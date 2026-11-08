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
    assert.equal([...g.files.keys()].filter((k) => k.endsWith(".frag")).length, 1);
    t.c.close();
  } finally { t.hub.stop(); await g.close(); }
});

test("supabase_set_upload_verify_flow: Supabase로 연결 → 지금 올리기 → 검증, 입력 검사, 키 비노출", async () => {
  const { fakeSupabase, SUPA_KEY } = await import("./connection/storage/fakeSupabase.js");
  const sb = await fakeSupabase();
  const t = await startTestHub({ supabaseInsecureForTest: true } as any);
  const token = fs.readFileSync(path.join(t.dataDir, "admin.key"), "utf8").trim();
  const c = new TestClient(t.port);
  await c.ready();
  const req = (op: string, p: object = {}) => c.req(op, { token, ...p }) as Promise<any>;
  try {
    await req("admin_conn_enable_server", { port: await freePort(), bindHost: "127.0.0.1", profile: "tls13-chacha20", spaceName: "팀" });
    const srv = await req("admin_conn_create_server", { name: "팀작업" });
    const ch = (await req("admin_conn_create_channel", { serverId: srv.serverId, name: "main" })).channelId;
    assert.equal((await req("admin_conn_storage_set", { kind: "supabase", url: sb.url, key: "", intervalMin: 5 })).code, "storage_config_invalid");
    assert.equal((await req("admin_conn_storage_set", { kind: "supabase", url: sb.url, key: SUPA_KEY, bucket: "bad/bucket", intervalMin: 5 })).code, "storage_config_invalid");
    const set = await req("admin_conn_storage_set", { kind: "supabase", url: sb.url, key: SUPA_KEY, intervalMin: 5 });
    assert.equal(set.ok, true, set.code);
    assert.match(set.recoveryKey, /^[A-Z2-7]{4}-/);
    assert.deepEqual([...sb.buckets.keys()], ["agent-uplink"]); // 기본 버킷
    await say(t.port, ch, ["수파베이스로"]);
    const up = await req("admin_conn_storage_upload_now");
    assert.deepEqual([up.ok, up.fragments, up.messages], [true, 1, 1]);
    assert.equal([...sb.objects.keys()].filter((k) => k.endsWith(".frag")).length, 1);
    const v = await req("admin_conn_storage_verify");
    assert.deepEqual([v.fragments, v.messages, v.breaks, v.missing, v.bad], [1, 1, [], [], []]);
    const st = (await req("admin_conn_storage_status")).storage;
    assert.deepEqual([st.kind, st.url, st.bucket], ["supabase", sb.url, "agent-uplink"]);
    const all = JSON.stringify([st, await req("admin_conn_status")]);
    assert.equal(all.includes(SUPA_KEY), false);
    for (const f of ["config.json", "state.json"]) assert.equal(fs.readFileSync(path.join(t.dataDir, "connection", "storage", f), "utf8").includes(SUPA_KEY), false, f);
    c.close();
  } finally { t.hub.stop(); await sb.close(); }
});

test("supabase_url_must_be_supabase_co: 실제 Hub는 https://<ref>.supabase.co 만 받는다", async () => {
  const t = await startTestHub();
  const token = fs.readFileSync(path.join(t.dataDir, "admin.key"), "utf8").trim();
  const c = new TestClient(t.port);
  await c.ready();
  try {
    await c.req("admin_conn_enable_server", { token, port: await freePort(), bindHost: "127.0.0.1", profile: "tls13-chacha20", spaceName: "팀" });
    for (const url of ["http://127.0.0.1:1", "https://evil.com", "https://x.supabase.co.evil.com"]) {
      assert.equal((await c.req("admin_conn_storage_set", { token, kind: "supabase", url, key: "sb_secret_x", intervalMin: 5 })).code, "storage_config_invalid", url);
    }
    c.close();
  } finally { t.hub.stop(); }
});

test("restore_e2e_new_hub: Hub X의 백업을 새 Hub Y가 저장소 정보+복구 키로 찾아 되살리고, 연결 계정이 읽는다", async () => {
  const g = await fakeGitHub();
  const X = await hubWithServer(g.apiBase);
  const Y = await startTestHub({ storageApiBase: g.apiBase } as any);
  try {
    await say(X.port, X.channelId, ["예전 대화 1", "예전 대화 2"]);
    const { recoveryKey } = await X.req("admin_conn_storage_set", { kind: "github", repo: "o/r", ghToken: TOKEN, intervalMin: 5 });
    assert.equal((await X.req("admin_conn_storage_upload_now")).ok, true);
    const yToken = fs.readFileSync(path.join(Y.dataDir, "admin.key"), "utf8").trim();
    const yc = new TestClient(Y.port);
    await yc.ready();
    const yreq = (op: string, p: object = {}) => yc.req(op, { token: yToken, ...p }) as Promise<any>;
    const input = { kind: "github", repo: "o/r", ghToken: TOKEN, recoveryKey };
    assert.equal((await yreq("admin_conn_storage_restore_scan", { ...input, recoveryKey: "AAAA" })).code, "recovery_key_invalid");
    const scan = await yreq("admin_conn_storage_restore_scan", input);
    assert.equal(scan.ok, true, scan.code);
    assert.equal(scan.candidates.length, 1);
    const r = await yreq("admin_conn_storage_restore", { ...input, spaceId: scan.candidates[0].spaceId, hubId: scan.candidates[0].hubId, serverName: "되살림" });
    assert.equal(r.ok, true, r.code);
    assert.equal(r.messageCount, 2);
    assert.equal(r.channelCount, 1);
    assert.deepEqual(r.breaks, []);
    const st = await yreq("admin_conn_status");
    const srv = st.comms.find((s: { name: string }) => s.name === "되살림");
    assert.ok(srv, JSON.stringify(st.comms));
    assert.equal(srv.channels[0].name, "팀작업/main");
    // 연결 계정은 통신이 켜져 있을 때만 로그인(기존 설계) — 새 PC도 통신 서버를 켠다
    await yreq("admin_conn_enable_server", { port: await freePort(), bindHost: "127.0.0.1", profile: "tls13-chacha20", spaceName: "새 PC" });
    const ai = new TestClient(Y.port);
    await ai.ready();
    assert.equal((await ai.req("login", { uuid: "y-ai", area: "connection" })).ok, true);
    const msgs = (await ai.req("read", { channelId: srv.channels[0].channelId })).messages ?? [];
    assert.deepEqual(msgs.map((m: { text: string }) => m.text), ["예전 대화 1", "예전 대화 2"]);
    // 토큰·복구 키는 Y에 남지 않는다
    const all: string[] = [];
    const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else all.push(fs.readFileSync(p, "latin1")); } };
    walk(Y.dataDir);
    assert.equal(all.some((s) => s.includes(TOKEN) || s.includes(recoveryKey) || s.includes(recoveryKey.replace(/-/g, ""))), false);
    // 저장소에 쓰지 않았다(파일 수 그대로)
    const before = g.files.size;
    await yreq("admin_conn_storage_restore_scan", input);
    assert.equal(g.files.size, before);
    ai.close(); yc.close();
  } finally { X.c.close(); X.hub.stop(); Y.hub.stop(); await g.close(); }
});
