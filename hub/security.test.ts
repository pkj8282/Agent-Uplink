// 로컬 공격면 회귀 테스트(레드티밍 결과). 공격 절차 상세는 공개하지 않는다.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { Hub } from "./server.js";
import { startTestHub, TestClient, httpGet, openViewerSession } from "./testing.js";
import { isAllowedHost, renderViewerHtml } from "./viewer.js";
import { encodeFrame, FrameDecoder } from "../shared/framing.js";

function tmp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), "uplink-sec-")); }
const CRLF = String.fromCharCode(13, 10);

function get(port: number, urlPath: string, host: string | null, cookie?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (host !== null) headers.Host = host;
    if (cookie) headers.Cookie = cookie;
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
  const { hub, port: tcpPort } = await startTestHub({ http: true });
  const port = hub.httpAddress.port;
  try {
    const cookie = await openViewerSession(tcpPort); // 세션이 있어도 Host가 틀리면 403
    for (const p of ["/accounts", "/events", "/"]) {
      const r = await get(port, p, `attacker.example:${port}`, cookie);
      assert.equal(r.status, 403, p);
      assert.doesNotMatch(r.body, /uuid|event: init/, p);
    }
    // Host 없음: Node가 HTTP/1.1 요청을 먼저 400으로 거부한다(어느 쪽이든 데이터 없음)
    const noHost = await get(port, "/accounts", null);
    assert.ok(noHost.status === 400 || noHost.status === 403, String(noHost.status));
    assert.doesNotMatch(noHost.body, /uuid/);
    assert.equal((await get(port, "/accounts", `127.0.0.1:${port}`, cookie)).status, 200);
    assert.equal((await get(port, "/accounts", `localhost:${port}`, cookie)).status, 200);
    assert.equal((await get(port, "/accounts", `[::1]:${port}`, cookie)).status, 200);
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
  const { hub, port: tcpPort } = await startTestHub({ http: true });
  const port = hub.httpAddress.port;
  try {
    const cookie = await openViewerSession(tcpPort);
    for (const p of ["/accounts", "/"]) {
      const res = await new Promise<http.IncomingMessage>((resolve) =>
        http.get({ host: "127.0.0.1", port, path: p, headers: { Origin: "http://evil.example", Cookie: cookie } }, resolve));
      assert.equal(res.statusCode, 200, p);
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

test("RT15: 연결 상한을 넘는 연결은 바로 끊기고, 자리가 나면 다시 받는다", async () => {
  const { hub, port } = await startTestHub({ limits: { maxConnections: 2 } });
  try {
    const a = new TestClient(port); await a.ready();
    const b = new TestClient(port); await b.ready();
    const c = new TestClient(port);
    await c.onClose(); // 즉시 끊김
    a.close();
    await new Promise((r) => setTimeout(r, 100));
    const d = new TestClient(port); await d.ready();
    assert.equal((await d.req("login", { uuid: "d", name: "D" })).ok, true);
    b.close(); d.close();
  } finally { hub.stop(); }
});

test("RT15: 인증하지 않은 연결은 authTimeoutMs 뒤 끊기고, 인증한 연결은 유지된다", async () => {
  const { hub, port } = await startTestHub({ limits: { authTimeoutMs: 200 } });
  try {
    const idle = new TestClient(port); await idle.connected();
    const ok = new TestClient(port); await ok.ready();
    const t0 = Date.now();
    await idle.onClose();
    assert.ok(Date.now() - t0 < 2000);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal((await ok.req("login", { uuid: "k", name: "K" })).ok, true);
    ok.close();
  } finally { hub.stop(); }
});

test("RT11: 쿠키 없이는 /, /events, /accounts가 401이고 데이터가 없다", async () => {
  const { hub } = await startTestHub({ http: true });
  const port = hub.httpAddress.port;
  try {
    for (const p of ["/", "/events", "/accounts"]) {
      const r = await httpGet(port, p);
      assert.equal(r.status, 401, p);
      assert.doesNotMatch(r.body, /uuid|event: init/, p);
    }
    assert.match((await httpGet(port, "/")).body, /agent-uplink-viewer/);
    assert.equal((await httpGet(port, "/accounts", { Cookie: `uplink_viewer=${"a".repeat(64)}` })).status, 401);
  } finally { hub.stop(); }
});

test("티켓 → 302 + HttpOnly·SameSite=Strict 쿠키 → 데이터 열림, 티켓 재사용은 401", async () => {
  const { hub, port } = await startTestHub({ http: true });
  const httpPort = hub.httpAddress.port;
  try {
    const c = new TestClient(port); await c.ready();
    const t = await c.req("viewer_ticket");
    assert.equal(t.ok, true);
    const url = new URL(t.url!);
    assert.equal(url.host, `127.0.0.1:${httpPort}`);
    const r = await httpGet(httpPort, url.pathname + url.search);
    assert.equal(r.status, 302);
    assert.equal(r.headers.location, "/");
    const cookie = String(r.headers["set-cookie"]);
    assert.match(cookie, /uplink_viewer=[0-9a-f]{64}/);
    assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/); assert.match(cookie, /Path=\//);
    const value = cookie.match(/uplink_viewer=[0-9a-f]{64}/)![0];
    assert.equal((await httpGet(httpPort, "/accounts", { Cookie: value })).status, 200);
    assert.equal((await httpGet(httpPort, url.pathname + url.search)).status, 401); // 재사용
    c.close();
  } finally { hub.stop(); }
});

test("RT17: Hub 재시작 뒤 옛 쿠키는 401 안내 페이지", async () => {
  const first = await startTestHub({ http: true });
  const cookie = await openViewerSession(first.port);
  first.hub.stop();
  const second = await startTestHub({ http: true, dataDir: first.dataDir });
  try {
    const r = await httpGet(second.hub.httpAddress.port, "/", { Cookie: cookie });
    assert.equal(r.status, 401);
    assert.match(r.body, /다시 열어야/);
  } finally { second.hub.stop(); }
});

test("뷰어 포트를 열지 않은 Hub는 viewer_unavailable", async () => {
  const { hub, port } = await startTestHub(); // http 없음
  try {
    const c = new TestClient(port); await c.ready();
    const r = await c.req("viewer_ticket");
    assert.equal(r.code, "viewer_unavailable");
    c.close();
  } finally { hub.stop(); }
});

test("보안 준비 전 뷰어 요청은 503", async () => {
  const dataDir = tmp();
  const hub = new Hub({ tcpPort: 0, httpPort: 0, dataDir, idleShutdownMs: 0 });
  await hub.startTcp(); await hub.startHttp();
  try {
    assert.equal((await httpGet(hub.httpAddress.port, "/")).status, 503);
  } finally { hub.stop(); }
});

test("SSE 동시 연결 상한을 넘으면 503", async () => {
  const { hub, port } = await startTestHub({ http: true, limits: { maxSse: 1 } });
  const httpPort = hub.httpAddress.port;
  try {
    const cookie = await openViewerSession(port);
    const first = http.get({ host: "127.0.0.1", port: httpPort, path: "/events", headers: { Cookie: cookie } });
    await new Promise((r) => first.once("response", r));
    assert.equal((await httpGet(httpPort, "/events", { Cookie: cookie })).status, 503);
    first.destroy();
  } finally { hub.stop(); }
});

test("알 수 없는 경로는 404", async () => {
  const { hub, port } = await startTestHub({ http: true });
  try {
    const cookie = await openViewerSession(port);
    assert.equal((await httpGet(hub.httpAddress.port, "/nope", { Cookie: cookie })).status, 404);
  } finally { hub.stop(); }
});

test("RT16: 인증된 연결에서 모든 op에 이상한 값을 넣어도 Hub는 죽지 않고 각 요청에 답한다", async () => {
  const { hub, port } = await startTestHub({ http: true });
  const OPS = ["login", "set_profile", "account_status", "whoami", "set_name", "list_accounts", "send", "read", "check",
    "open_dm", "list_dms", "create_server", "list_servers", "create_channel", "list_channels", "delete_channel", "delete_server",
    "viewer_ticket", "admin_snapshot", "admin_set_config", "admin_delete_channel", "admin_delete_server", "admin_delete_account",
    "admin_restore_trash", "admin_empty_trash", "auth", "hello"];
  const FIELDS = ["uuid", "name", "description", "uuids", "channelId", "text", "limit", "peer", "serverId", "token", "patch", "trashId", "confirmRename", "exclusive", "sessionToken", "nonce", "proof"];
  const VALUES: unknown[] = [null, 0, -1, 1e308, "", "x".repeat(100000), [], [1, "a"], {}, true, "../../x", "lobby"];
  const c = new TestClient(port); await c.ready();
  await c.req("login", { uuid: "fuzz", name: "F" });
  const timeout = (ms: number) => new Promise<"timeout">((r) => setTimeout(() => r("timeout"), ms));
  const silent: string[] = [];
  try {
    for (const op of OPS) for (const f of FIELDS) for (const v of VALUES) {
      const r = await Promise.race([c.req(op, { [f]: v }), timeout(2000)]);
      if (r === "timeout") silent.push(`${op}.${f}=${typeof v}`);
      else assert.equal(typeof (r as any).ok, "boolean", `${op}.${f}`);
    }
    assert.deepEqual(silent, []);
    const probe = new TestClient(port); await probe.ready();
    assert.equal((await probe.req("whoami")).ok, false); // 로그인 안 한 새 연결 — Hub 생존 확인
    probe.close();
  } finally { c.close(); hub.stop(); }
});

test("RT16: wait의 timeoutMs가 숫자가 아니면 기본 대기로 처리한다(즉시 빈 응답이 아님)", async () => {
  const { hub, port } = await startTestHub();
  const c = new TestClient(port); await c.ready();
  await c.req("login", { uuid: "w", name: "W" });
  try {
    for (const bad of ["x", null, {}, 1e308, -5]) {
      const r = await Promise.race([c.req("wait", { timeoutMs: bad }), new Promise<"pending">((res) => setTimeout(() => res("pending"), 300))]);
      assert.equal(r, "pending", String(bad)); // 최소 1초 이상 기다린다
    }
  } finally { c.close(); hub.stop(); }
});

test("RT15: 상한이 무인증 연결로 찼어도 새 연결은 받고, 가장 오래된 무인증 연결을 끊는다(인증된 연결은 유지)", async () => {
  const { hub, port } = await startTestHub({ limits: { maxConnections: 3 } });
  try {
    const authed = new TestClient(port); await authed.ready();
    const idle1 = new TestClient(port); await idle1.connected();
    const idle1Closed = idle1.onClose();
    await new Promise((r) => setTimeout(r, 30));
    const idle2 = new TestClient(port); await idle2.connected();
    await new Promise((r) => setTimeout(r, 30));
    const legit = new TestClient(port); await legit.ready(); // 상한(3) 초과 — 가장 오래된 무인증(idle1)을 밀어낸다
    await idle1Closed;
    assert.equal((await legit.req("login", { uuid: "l", name: "L" })).ok, true);
    assert.equal((await authed.req("login", { uuid: "a", name: "A" })).ok, true);
    authed.close(); idle2.close(); legit.close();
  } finally { hub.stop(); }
});

test("RT15: 연결이 한꺼번에 몰려도 Hub가 들고 있는 연결 수는 상한을 넘지 않는다", async () => {
  const { hub, port } = await startTestHub({ limits: { maxConnections: 10 } });
  const socks: net.Socket[] = [];
  try {
    for (let i = 0; i < 150; i++) {
      const s = net.connect(port, "127.0.0.1");
      s.on("error", () => {});
      socks.push(s);
    }
    await new Promise((r) => setTimeout(r, 800));
    const open = socks.filter((s) => s.readyState === "open").length;
    assert.ok(open <= 10, `열린 연결 ${open}개`);
    const legit = new TestClient(port); await legit.ready(); // 몰린 뒤에도 정상 클라이언트는 들어온다
    assert.equal((await legit.req("login", { uuid: "z", name: "Z" })).ok, true);
    legit.close();
  } finally { for (const s of socks) s.destroy(); hub.stop(); }
});
