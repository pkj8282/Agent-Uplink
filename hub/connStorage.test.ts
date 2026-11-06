import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { freePort, startTestHub, TestClient } from "./testing.js";

const TOKEN = "github_pat_HUB_STORAGE_SECRET_42";

/** 가짜 GitHub(o/r 저장소 하나). */
async function fakeGitHub() {
  const files = new Map<string, string>();
  let requests = 0;
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      requests++;
      const json = (code: number, v: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(v)); };
      const m = /^\/repos\/o\/r(?:\/contents\/(.*?))?(?:\?.*)?$/.exec(req.url!);
      if (!m) return json(404, {});
      const p = m[1] ? decodeURIComponent(m[1]) : undefined;
      if (p === undefined) return json(200, { full_name: "o/r" });
      if (req.method === "PUT") { if (files.has(p)) return json(422, {}); files.set(p, JSON.parse(body).content); return json(201, {}); }
      if (files.has(p)) return json(200, { type: "file", encoding: "base64", content: files.get(p) });
      const kids = [...new Set([...files.keys()].filter((k) => k.startsWith(`${p}/`)).map((k) => k.slice(p.length + 1).split("/")[0]))];
      return kids.length ? json(200, kids.map((name) => ({ name, type: "file" }))) : json(404, {});
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  return { files, requests: () => requests, apiBase: `http://127.0.0.1:${(srv.address() as net.AddressInfo).port}`, close: () => new Promise<void>((r) => srv.close(() => r())) };
}

async function hubWithServer(apiBase: string, withChannel = true) {
  const t = await startTestHub({ storageApiBase: apiBase } as any);
  const token = fs.readFileSync(path.join(t.dataDir, "admin.key"), "utf8").trim();
  const c = new TestClient(t.port);
  await c.ready();
  const req = (op: string, p: object = {}) => c.req(op, { token, ...p }) as Promise<any>;
  await req("admin_conn_enable_server", { port: await freePort(), bindHost: "127.0.0.1", profile: "tls13-chacha20", spaceName: "팀" });
  let channelId = "";
  if (withChannel) {
    const srv = await req("admin_conn_create_server", { name: "팀작업" });
    channelId = (await req("admin_conn_create_channel", { serverId: srv.serverId, name: "main" })).channelId;
  }
  return { ...t, c, req, channelId };
}

async function say(port: number, channelId: string, texts: string[]) {
  const a = new TestClient(port);
  await a.ready();
  assert.equal((await a.req("login", { uuid: "conn-ai", area: "connection" })).ok, true);
  for (const text of texts) assert.equal((await a.req("send", { channelId, text })).ok, true);
  a.close();
}

test("storage_ops_require_admin_token: 저장소 op는 관리 토큰 없이는 거부", async () => {
  const t = await startTestHub();
  try {
    const c = new TestClient(t.port);
    await c.ready();
    for (const op of ["admin_conn_storage_set", "admin_conn_storage_status", "admin_conn_storage_upload_now", "admin_conn_storage_verify", "admin_conn_storage_clear"]) {
      assert.equal((await c.req(op, { token: "wrong", repo: "o/r", token2: TOKEN })).code, "admin_auth_failed", op);
    }
    assert.equal(fs.existsSync(path.join(t.dataDir, "connection")), false);
    c.close();
  } finally { t.hub.stop(); }
});

test("set_upload_verify_flow: 연결 → 지금 올리기 → 검증, 입력 검사", async () => {
  const g = await fakeGitHub();
  const t = await hubWithServer(g.apiBase);
  try {
    assert.equal((await t.req("admin_conn_storage_set", { kind: "github", repo: "bad", ghToken: TOKEN, intervalMin: 5 })).code, "storage_config_invalid");
    assert.equal((await t.req("admin_conn_storage_set", { kind: "github", repo: "o/r", ghToken: "", intervalMin: 5 })).code, "storage_config_invalid");
    assert.equal((await t.req("admin_conn_storage_set", { kind: "github", repo: "o/r", ghToken: TOKEN, intervalMin: 0 })).code, "storage_config_invalid");
    assert.equal((await t.req("admin_conn_storage_set", { kind: "dropbox", repo: "o/r", ghToken: TOKEN, intervalMin: 5 })).code, "storage_config_invalid");
    assert.equal((await t.req("admin_conn_storage_upload_now")).code, "storage_not_configured");
    const set = await t.req("admin_conn_storage_set", { kind: "github", repo: "o/r", ghToken: TOKEN, intervalMin: 5 });
    assert.equal(set.ok, true, set.code);
    assert.match(set.recoveryKey, /^[A-Z2-7]{4}-/);
    await say(t.port, t.channelId, ["하나", "둘"]);
    const up = await t.req("admin_conn_storage_upload_now");
    assert.deepEqual([up.ok, up.fragments, up.messages], [true, 1, 2]);
    const v = await t.req("admin_conn_storage_verify");
    assert.deepEqual([v.ok, v.fragments, v.messages, v.breaks, v.missing, v.bad], [true, 1, 2, [], [], []]);
    const st = await t.req("admin_conn_storage_status");
    assert.equal(st.storage.configured, true);
    assert.equal(typeof st.storage.lastUploadAt, "number");
    assert.equal((await t.req("admin_conn_status")).storage.repo, "o/r");
    assert.equal((await t.req("admin_conn_storage_clear")).ok, true);
    assert.equal((await t.req("admin_conn_storage_status")).storage.configured, false);
    t.c.close();
  } finally { t.hub.stop(); await g.close(); }
});

test("token_never_echoed: 토큰은 상태·사건·보안 기록·stderr 어디에도 안 나온다", async () => {
  const g = await fakeGitHub();
  const out: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  (process.stderr as any).write = (s: unknown, ...rest: unknown[]) => { out.push(String(s)); return (orig as any)(s, ...rest); };
  const t = await hubWithServer(g.apiBase);
  try {
    await t.req("admin_conn_storage_set", { kind: "github", repo: "o/r", ghToken: TOKEN, intervalMin: 5 });
    await say(t.port, t.channelId, ["x"]);
    await t.req("admin_conn_storage_upload_now");
    const all = JSON.stringify([await t.req("admin_conn_status"), await t.req("admin_conn_storage_status"), await t.req("admin_snapshot")]);
    assert.equal(all.includes(TOKEN), false);
    assert.equal(out.join("").includes(TOKEN), false);
    for (const f of ["config.json", "state.json"]) assert.equal(fs.readFileSync(path.join(t.dataDir, "connection", "storage", f), "utf8").includes(TOKEN), false, f);
    t.c.close();
  } finally { (process.stderr as any).write = orig; t.hub.stop(); await g.close(); }
});

test("no_storage_no_requests: 저장소를 연결하지 않으면 바깥 요청 0", async () => {
  const g = await fakeGitHub();
  const t = await hubWithServer(g.apiBase);
  try {
    await say(t.port, t.channelId, ["x"]);
    await t.hub.conn.stop();
    assert.equal(g.requests(), 0);
    t.c.close();
  } finally { t.hub.stop(); await g.close(); }
});

test("stop_uploads_last: 정지하면 마지막으로 한 번 올린다", async () => {
  const g = await fakeGitHub();
  const t = await hubWithServer(g.apiBase);
  try {
    await t.req("admin_conn_storage_set", { kind: "github", repo: "o/r", ghToken: TOKEN, intervalMin: 60 });
    await say(t.port, t.channelId, ["마지막"]);
    await t.hub.conn.stop();
    assert.equal(g.files.size, 1);
    t.c.close();
  } finally { t.hub.stop(); await g.close(); }
});
