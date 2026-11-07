import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { freePort, startTestHub, tempDir, TestClient } from "./testing.js";

/** 가짜 GitHub(o/r) — 조각 수만 센다. */
async function fakeGitHub() {
  const files = new Map<string, string>();
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const json = (code: number, v: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(v)); };
      const m = /^\/repos\/o\/r(?:\/contents\/(.*?))?(?:\?.*)?$/.exec(req.url!);
      if (!m) return json(404, {});
      const p = m[1] ? decodeURIComponent(m[1]) : undefined;
      if (p === undefined) return json(200, {});
      if (req.method === "PUT") { files.set(p, JSON.parse(body).content); return json(201, {}); }
      if (files.has(p)) return json(200, { type: "file", encoding: "base64", content: files.get(p) });
      return json(404, {});
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  return { files, apiBase: `http://127.0.0.1:${(srv.address() as net.AddressInfo).port}`, close: () => new Promise<void>((r) => srv.close(() => r())) };
}

async function admin(t: { port: number; dataDir: string }) {
  const token = fs.readFileSync(path.join(t.dataDir, "admin.key"), "utf8").trim();
  const c = new TestClient(t.port);
  await c.ready();
  return { c, req: (op: string, p: object = {}) => c.req(op, { token, ...p }) as Promise<any> };
}

async function say(port: number, channelId: string, text: string) {
  const a = new TestClient(port);
  await a.ready();
  await a.req("login", { uuid: "conn-ai", area: "connection" });
  assert.equal((await a.req("send", { channelId, text })).ok, true);
  a.close();
}

async function setupServer(a: Awaited<ReturnType<typeof admin>>, connPort: number) {
  await a.req("admin_conn_enable_server", { port: connPort, bindHost: "127.0.0.1", profile: "tls13-chacha20", spaceName: "팀" });
  const srv = await a.req("admin_conn_create_server", { name: "팀작업" });
  return (await a.req("admin_conn_create_channel", { serverId: srv.serverId, name: "main" })).channelId as string;
}

const lastEvent = (dataDir: string) => JSON.parse(fs.readFileSync(path.join(dataDir, "connection", "lifecycle.jsonl"), "utf8").trim().split("\n").at(-1)!);

test("unclean_start_uploads_pending: 정상 종료 보고 없이 꺼진 뒤 다시 켜면 '비정상 종료 감지' + 밀린 백업 업로드", async () => {
  const g = await fakeGitHub();
  const dataDir = tempDir("uplink-life-hub-");
  const connPort = await freePort();
  const h1 = await startTestHub({ dataDir, storageApiBase: g.apiBase });
  const a1 = await admin(h1);
  const ch = await setupServer(a1, connPort);
  assert.equal(lastEvent(dataDir).e, "start"); // 통신 서버를 처음 켠 실행부터 기록
  assert.equal((await a1.req("admin_conn_storage_set", { kind: "github", repo: "o/r", ghToken: "tok", intervalMin: 60 })).ok, true);
  assert.equal(lastEvent(dataDir).e, "start"); // 처음 켠 실행도 기록
  await say(h1.port, ch, "꺼지기 직전");
  // 갑자기 꺼짐: 정상 종료 절차(마지막 업로드·보고)를 건너뛰고 포트만 닫는다
  (h1.hub.conn as any).uploader.stopTimer();
  await (h1.hub.conn as any).listener?.close();
  h1.hub.conn.stop = async () => {};
  a1.c.close();
  h1.hub.stop();
  assert.equal(g.files.size, 0);
  const h2 = await startTestHub({ dataDir, storageApiBase: g.apiBase });
  try {
    const a2 = await admin(h2);
    for (let i = 0; i < 100 && g.files.size === 0; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(g.files.size, 1);
    const codes = (await a2.req("admin_conn_status")).events.map((e: any) => e.code);
    assert.ok(codes.includes("unclean_shutdown_detected"), codes.join(","));
    assert.equal(lastEvent(dataDir).e, "start");
    a2.c.close();
  } finally { h2.hub.stop(); await g.close(); }
});

test("clean_stop_records_after_last_upload: 정상 종료는 마지막 업로드 뒤 보고, 다음 가동은 정상", async () => {
  const g = await fakeGitHub();
  const dataDir = tempDir("uplink-life-hub-");
  const h1 = await startTestHub({ dataDir, storageApiBase: g.apiBase });
  const a1 = await admin(h1);
  const ch = await setupServer(a1, await freePort());
  await a1.req("admin_conn_storage_set", { kind: "github", repo: "o/r", ghToken: "tok", intervalMin: 60 });
  await say(h1.port, ch, "마지막");
  a1.c.close();
  await h1.hub.conn.stop();
  h1.hub.stop();
  assert.equal(g.files.size, 1);
  const ev = lastEvent(dataDir);
  assert.equal(ev.e, "clean_stop");
  assert.equal(ev.nextIndex, 1);
  assert.match(ev.lastHash, /^[0-9a-f]{64}$/);
  const h2 = await startTestHub({ dataDir, storageApiBase: g.apiBase });
  try {
    const a2 = await admin(h2);
    const codes = (await a2.req("admin_conn_status")).events.map((e: any) => e.code);
    assert.equal(codes.includes("unclean_shutdown_detected"), false);
    a2.c.close();
  } finally { h2.hub.stop(); await g.close(); }
});

test("no_connection_no_lifecycle: 통신을 켠 적 없는 Hub는 사건 기록을 남기지 않는다", async () => {
  const t = await startTestHub();
  await t.hub.conn.stop();
  t.hub.stop();
  assert.equal(fs.existsSync(path.join(t.dataDir, "connection")), false);
});
