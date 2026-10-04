// 로컬 공격면 회귀 테스트(레드티밍 결과). 공격 절차 상세는 공개하지 않는다.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { Hub } from "./server.js";
import { startTestHub, TestClient } from "./testing.js";
import { isAllowedHost, renderViewerHtml } from "./viewer.js";
import { encodeFrame, FrameDecoder } from "../shared/framing.js";

function tmp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), "uplink-sec-")); }
const CRLF = String.fromCharCode(13, 10);

function get(port: number, urlPath: string, host: string | null): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (host !== null) headers.Host = host;
    const req = http.request({ host: "127.0.0.1", port, path: urlPath, headers, setHost: host !== null }, (res) => {
      let body = "";
      res.on("data", (d) => {
        body += d;
        if (urlPath === "/events") { res.destroy(); resolve({ status: res.statusCode!, body }); }
      });
      res.on("end", () => resolve({ status: res.statusCode!, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("RT1: DNS rebinding — 공격자 Host로는 /accounts·/events·/ 를 읽을 수 없다(403)", async () => {
  const { hub } = await startTestHub({ http: true });
  const port = hub.httpAddress.port;
  try {
    for (const p of ["/accounts", "/events", "/"]) {
      const r = await get(port, p, `attacker.example:${port}`);
      assert.equal(r.status, 403, p);
      assert.doesNotMatch(r.body, /uuid|event: init/, p);
    }
    // Host 없음: Node가 HTTP/1.1 요청을 먼저 400으로 거부한다(어느 쪽이든 데이터 없음)
    const noHost = await get(port, "/accounts", null);
    assert.ok(noHost.status === 400 || noHost.status === 403, String(noHost.status));
    assert.doesNotMatch(noHost.body, /uuid/);
    assert.equal((await get(port, "/accounts", `127.0.0.1:${port}`)).status, 200);
    assert.equal((await get(port, "/accounts", `localhost:${port}`)).status, 200);
    assert.equal((await get(port, "/accounts", `[::1]:${port}`)).status, 200);
  } finally {
    hub.stop();
  }
});

test("RT2: HTTP 요청 바이트로는 TCP op가 실행되지 않는다(교차 프로토콜)", async () => {
  const { hub, port } = await startTestHub();
  try {
    const body = Buffer.concat([
      encodeFrame({ op: "login", id: 1, uuid: "rt2-attacker", name: "공격자" }),
      encodeFrame({ op: "send", id: 2, channelId: "lobby", text: "RT2" }),
    ]);
    const head = Buffer.from(["POST / HTTP/1.1", `Host: 127.0.0.1:${port}`, "Content-Type: text/plain", `Content-Length: ${body.length}`, "", ""].join(CRLF));
    await new Promise<void>((resolve) => {
      const s = net.connect(port, "127.0.0.1", () => { s.write(Buffer.concat([head, body])); setTimeout(() => { s.destroy(); resolve(); }, 300); });
    });
    const c = new TestClient(port); await c.ready();
    const list = await c.req("list_accounts");
    c.close();
    assert.equal(list.accounts!.some((a: any) => a.uuid === "rt2-attacker"), false);
  } finally {
    hub.stop();
  }
});

test("RT3: 뷰어 응답에 CORS 허용 헤더가 없다(다른 출처 페이지가 읽을 수 없음)", async () => {
  const { hub } = await startTestHub({ http: true });
  const port = hub.httpAddress.port;
  try {
    for (const p of ["/accounts", "/"]) {
      const res = await new Promise<http.IncomingMessage>((resolve) =>
        http.get({ host: "127.0.0.1", port, path: p, headers: { Origin: "http://evil.example" } }, resolve));
      assert.equal(res.headers["access-control-allow-origin"], undefined, p);
      res.resume();
    }
  } finally {
    hub.stop();
  }
});

test("RT4: 뷰어는 사용자 데이터를 HTML로 해석해 넣지 않는다", () => {
  assert.doesNotMatch(renderViewerHtml(), /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
});

test("RT6: junction 항목에 대한 restore/empty op는 바깥 폴더를 건드리지 않는다", async () => {
  const { hub, port, dataDir } = await startTestHub();
  try {
    const token = fs.readFileSync(path.join(dataDir, "admin.key"), "utf8").trim();
    const victim = fs.mkdtempSync(path.join(os.tmpdir(), "uplink-victim-"));
    const id = "1759500000000-channel-deadbeef";
    fs.writeFileSync(path.join(victim, "meta.json"), JSON.stringify({ v: 1, id, kind: "channel", state: "done", deletedAt: 1, deletedBy: "admin", name: "x", files: [] }));
    fs.symlinkSync(victim, path.join(dataDir, "trash", id), "junction");
    const call = async (op: string, p: object) => {
      const c = new TestClient(port); await c.ready();
      const r = await c.req(op, { token, ...p });
      c.close();
      return r;
    };
    assert.equal((await call("admin_restore_trash", { trashId: id })).code, "trash_missing");
    await call("admin_empty_trash", {});
    assert.equal(fs.existsSync(path.join(victim, "meta.json")), true);
  } finally {
    hub.stop();
  }
});

test("RT7: 1 MiB를 넘는 길이를 선언한 연결(HTTP POST 바이트)은 즉시 끊기고 Hub는 계속 응답한다", async () => {
  const { hub, port } = await startTestHub();
  try {
    const closed = await new Promise<boolean>((resolve) => {
      const s = net.connect(port, "127.0.0.1", () => s.write(["POST / HTTP/1.1", "Host: x", "", ""].join(CRLF)));
      s.on("close", () => resolve(true));
      s.on("error", () => {});
      setTimeout(() => { s.destroy(); resolve(false); }, 1000);
    });
    assert.equal(closed, true);
    const hello = await new Promise<any>((resolve) => {
      const s = net.connect(port, "127.0.0.1", () => s.write(encodeFrame({ op: "hello", id: 1 })));
      const dec = new FrameDecoder();
      s.on("data", (d) => dec.push(d, (r: any) => { resolve(r); s.destroy(); }));
    });
    assert.equal(hello.ok, true);
  } finally {
    hub.stop();
  }
});

test("send는 65536자를 넘는 메시지를 거부한다", async () => {
  const { hub, port } = await startTestHub();
  try {
    const c = new TestClient(port); await c.ready();
    const replies: any[] = [];
    replies.push(await c.req("login", { uuid: "u-long", name: "L" }));
    replies.push(await c.req("send", { channelId: "lobby", text: "가".repeat(65537) }));
    replies.push(await c.req("send", { channelId: "lobby", text: "가".repeat(65536) }));
    c.close();
    assert.equal(replies[1].ok, false);
    assert.match(replies[1].error, /65536/);
    assert.equal(replies[2].ok, true);
  } finally {
    hub.stop();
  }
});

test("login uuid에 경로 조작이 있으면 거부하고 데이터 폴더 밖에 계정 파일을 만들지 않는다", async () => {
  const { hub, port, dataDir } = await startTestHub();
  try {
    const c = new TestClient(port); await c.ready();
    const replies: any[] = [];
    replies.push(await c.req("login", { uuid: "../../escaped-account", name: "x" }));
    replies.push(await c.req("login", { uuid: "ok-account_1.a", name: "y" }));
    c.close();
    assert.equal(replies[0].ok, false);
    assert.equal(fs.existsSync(path.join(dataDir, "..", "escaped-account.json")), false);
    assert.equal(replies[1].ok, true); // 기존 형식(영숫자·-·_·.)은 그대로 허용
  } finally {
    hub.stop();
  }
});

test("isAllowedHost: 루프백 이름+정확한 포트만", () => {
  assert.equal(isAllowedHost("127.0.0.1:47801", 47801), true);
  assert.equal(isAllowedHost("LOCALHOST:47801", 47801), true);
  assert.equal(isAllowedHost("127.0.0.1:1", 47801), false);
  assert.equal(isAllowedHost("127.0.0.1.attacker.example:47801", 47801), false);
  assert.equal(isAllowedHost(undefined, 47801), false);
});
