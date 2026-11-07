import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { freePort, startTestHub, TestClient } from "./testing.js";
import { MemoryBackend } from "./connection/storage/backend.js";

const TOKEN_A = "ghp_OWNER_SECRET_123";
const TOKEN_B = "ghp_MEMBER_SECRET_456";

async function hub(backend: MemoryBackend) {
  const t = await startTestHub({ space1BackendForTest: () => backend, connBackoffMs: [50, 100] } as any);
  const token = fs.readFileSync(path.join(t.dataDir, "admin.key"), "utf8").trim();
  const c = new TestClient(t.port);
  await c.ready();
  const req = (op: string, p: object = {}) => c.req(op, { token, ...p }) as Promise<any>;
  return { ...t, c, req };
}

async function login(port: number, uuid: string, area?: "connection") {
  const c = new TestClient(port);
  await c.ready();
  assert.equal((await c.req("login", { uuid, ...(area ? { area } : {}) })).ok, true);
  return c;
}

async function setup() {
  const be = new MemoryBackend();
  const A = await hub(be);
  const B = await hub(be);
  await A.req("admin_conn_set_user", { name: "에이" });
  await B.req("admin_conn_set_user", { name: "비" });
  // A의 로컬 서버(로컬 계정 AI가 만든 것)를 공간으로
  const aiA = await login(A.port, "a-ai");
  const srv = await aiA.req("create_server", { name: "팀" });
  const ch = (await aiA.req("create_channel", { serverId: srv.serverId, name: "작업방" })).channelId as string;
  const made = await A.req("admin_conn_s1_create", { spaceName: "공간", localServerId: srv.serverId, repo: "me/space", ghToken: TOKEN_A, intervalSec: 30 });
  assert.equal(made.ok, true, made.code);
  const inv = await A.req("admin_conn_s1_invite", { spaceId: made.spaceId, label: "비", expiresInMs: 60_000 });
  assert.match(inv.code, /^UPLINKS1-/);
  const joined = await B.req("admin_conn_s1_join", { code: inv.code, ghToken: TOKEN_B });
  assert.equal(joined.ok, true, joined.code);
  await A.req("admin_conn_s1_sync_now", { spaceId: made.spaceId });
  const sb = await B.req("admin_conn_s1_sync_now", { spaceId: made.spaceId });
  assert.equal(sb.space.state, "active");
  return { be, A, B, aiA, ch, spaceId: made.spaceId as string };
}

test("hub_flow_via_admin_ops: 관리 op로 만들기·초대·참여·동기화, 로컬 계정끼리 대화(연결 계정 아님)", async () => {
  const s = await setup();
  try {
    const mirrorId = `s1:${s.spaceId}:${s.ch}`;
    const aiB = await login(s.B.port, "b-ai"); // 로컬 계정
    assert.equal((await s.aiA.req("send", { channelId: s.ch, text: "에이가 보냄" })).ok, true);
    await s.A.req("admin_conn_s1_sync_now", { spaceId: s.spaceId });
    await s.B.req("admin_conn_s1_sync_now", { spaceId: s.spaceId });
    const rb: any = await aiB.req("read", { channelId: mirrorId });
    assert.equal(rb.ok, true, rb.code);
    assert.deepEqual(rb.messages.map((m: any) => [m.text, m.origin?.hubUser]), [["에이가 보냄", "에이"]]);
    assert.equal((await aiB.req("send", { channelId: mirrorId, text: "비가 답함" })).ok, true);
    await s.B.req("admin_conn_s1_sync_now", { spaceId: s.spaceId });
    await s.A.req("admin_conn_s1_sync_now", { spaceId: s.spaceId });
    const ra: any = await s.aiA.req("read", { channelId: s.ch });
    assert.deepEqual(ra.messages.map((m: any) => [m.text, m.origin?.hubUser ?? null]), [["에이가 보냄", null], ["비가 답함", "비"]]);
    const st = await s.A.req("admin_conn_s1_status");
    assert.deepEqual(st.spaces.map((x: any) => [x.spaceName, x.role, x.state, x.members.length]), [["공간", "owner", "active", 2]]);
    // 퇴출
    const bHub = st.spaces[0].members.find((m: any) => !m.me).hubId;
    assert.equal((await s.A.req("admin_conn_s1_revoke", { spaceId: s.spaceId, hubId: bHub })).ok, true);
    const sb = await s.B.req("admin_conn_s1_sync_now", { spaceId: s.spaceId });
    assert.equal(sb.space.state, "revoked");
    // 나가기: 거울 채널이 사라짐
    assert.equal((await s.B.req("admin_conn_s1_leave", { spaceId: s.spaceId })).ok, true);
    assert.equal((await aiB.req("read", { channelId: mirrorId })).code, "channel_not_found");
    aiB.close();
  } finally { s.A.hub.stop(); s.B.hub.stop(); }
});

test("mode1_and_mode2_together: 같은 Hub에서 방식 1 공간과 방식 2 통신이 섞이지 않는다", async () => {
  const s = await setup();
  try {
    // 방식 2: A가 통신 서버, B가 참여
    await s.A.req("admin_conn_enable_server", { port: await freePort(), bindHost: "127.0.0.1", profile: "tls13-chacha20", spaceName: "통신" });
    const cs = await s.A.req("admin_conn_create_server", { name: "통신팀" });
    const cch = (await s.A.req("admin_conn_create_channel", { serverId: cs.serverId, name: "실시간" })).channelId;
    await s.A.req("admin_conn_set_shared", { serverIds: [cs.serverId] });
    const inv2 = await s.A.req("admin_conn_create_invite", { label: "비", host: "127.0.0.1", expiresInMs: 60_000 });
    assert.equal((await s.B.req("admin_conn_join", { code: inv2.code })).ok, true);
    // 방식 1 초대 코드를 방식 2 참여에 넣으면 거부, 반대도 거부
    const inv1 = await s.A.req("admin_conn_s1_invite", { spaceId: s.spaceId, label: "씨", expiresInMs: 60_000 });
    assert.equal((await s.B.req("admin_conn_join", { code: inv1.code })).ok, false);
    assert.equal((await s.B.req("admin_conn_s1_join", { code: inv2.code, ghToken: TOKEN_B })).code, "invite_not_space");
    // 방식 1 거울 채널은 로컬 영역(연결 계정은 못 씀), 방식 2 공유 채널은 연결 영역(로컬 계정은 못 씀)
    const mirrorId = `s1:${s.spaceId}:${s.ch}`;
    const localB = await login(s.B.port, "b-local");
    for (let i = 0; i < 100; i++) { if ((await s.B.req("admin_conn_status")).joined[0]?.connected) break; await new Promise((r) => setTimeout(r, 20)); }
    const connB = await login(s.B.port, "b-conn", "connection");
    assert.equal((await localB.req("send", { channelId: mirrorId, text: "방식1" })).ok, true);
    assert.equal((await localB.req("send", { channelId: `r:${(await s.B.req("admin_conn_status")).joined[0].spaceId}:${cch}`, text: "x" })).ok, false);
    assert.equal((await connB.req("send", { channelId: mirrorId, text: "x" })).ok, true); // 연결 계정은 로컬 채널도 쓸 수 있음(설계 7)
    localB.close(); connB.close();
  } finally { s.A.hub.stop(); s.B.hub.stop(); }
});

test("untouched_without_space1: 방식 1을 안 쓰면 connection/ 폴더도 바깥 요청도 없다", async () => {
  let made = 0;
  const t = await startTestHub({ space1BackendForTest: () => { made++; return new MemoryBackend(); } } as any);
  try {
    const token = fs.readFileSync(path.join(t.dataDir, "admin.key"), "utf8").trim();
    const c = new TestClient(t.port);
    await c.ready();
    const st: any = await c.req("admin_conn_s1_status", { token });
    assert.deepEqual(st.spaces, []);
    assert.equal(fs.existsSync(path.join(t.dataDir, "connection")), false);
    assert.equal(made, 0);
    c.close();
  } finally { t.hub.stop(); }
});

test("token_never_echoed: GitHub 토큰은 상태·응답·파일(비밀 파일 제외)에 없다", async () => {
  const s = await setup();
  try {
    const all = JSON.stringify([await s.A.req("admin_conn_s1_status"), await s.B.req("admin_conn_s1_status"), await s.A.req("admin_conn_status")]);
    for (const tk of [TOKEN_A, TOKEN_B]) assert.equal(all.includes(tk), false);
    for (const t of [s.A, s.B]) {
      const dir = path.join(t.dataDir, "connection", "spaces1", s.spaceId);
      for (const f of ["config.json", "state.json"]) {
        const text = fs.readFileSync(path.join(dir, f), "utf8");
        assert.equal(text.includes(TOKEN_A) || text.includes(TOKEN_B), false, f);
      }
    }
    const storage = [...s.be.files.values()].map((b) => b.toString("utf8")).join("\n");
    assert.equal(storage.includes("ghp_"), false);
  } finally { s.A.hub.stop(); s.B.hub.stop(); }
});

test("member_can_discover_space_channels: 구성원 쪽 로컬 세션이 list_servers·list_channels로 공간 채널을 찾는다", async () => {
  const s = await setup();
  try {
    const aiB = await login(s.B.port, "b-ai2");
    const ls: any = await aiB.req("list_servers", {});
    const sp = ls.servers.find((x: any) => x.serverId === `s1:${s.spaceId}`);
    assert.ok(sp, JSON.stringify(ls.servers));
    assert.equal(sp.name, "공간");
    assert.equal(sp.channelCount, 1);
    assert.deepEqual(sp.remote, { spaceName: "공간", hubUser: "에이" });
    const lc: any = await aiB.req("list_channels", { serverId: `s1:${s.spaceId}` });
    assert.deepEqual(lc.channels, [{ channelId: `s1:${s.spaceId}:${s.ch}`, name: "작업방" }]);
    aiB.close();
  } finally { s.A.hub.stop(); s.B.hub.stop(); }
});
