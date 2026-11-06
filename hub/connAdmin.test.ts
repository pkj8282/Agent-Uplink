import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { freePort, startTestHub, TestClient } from "./testing.js";

async function hubWithToken() {
  const t = await startTestHub({ connBackoffMs: [50, 100] });
  const token = fs.readFileSync(path.join(t.dataDir, "admin.key"), "utf8").trim();
  const c = new TestClient(t.port);
  await c.ready();
  return { ...t, token, c };
}

test("conn_admin_ops_require_admin_token: 관리 토큰 없이는 통신 관리 op 거부(MCP 로그인 연결 포함)", async () => {
  const t = await hubWithToken();
  try {
    await t.c.req("login", { uuid: "agent" });
    for (const op of ["admin_conn_status", "admin_conn_set_user", "admin_conn_enable_server", "admin_conn_create_invite", "admin_conn_join", "admin_conn_revoke", "admin_conn_set_shared", "admin_conn_create_server", "admin_conn_create_channel", "admin_conn_disable_server"]) {
      assert.equal((await t.c.req(op, { name: "x" })).code, "admin_auth_failed", op);
      assert.equal((await t.c.req(op, { token: "wrong", name: "x" })).code, "admin_auth_failed", op);
    }
    assert.equal(fs.existsSync(path.join(t.dataDir, "connection")), false);
    t.c.close();
  } finally { t.hub.stop(); }
});

test("no_connection_no_port: 통신 설정이 없는 Hub는 통신 포트를 열지 않고 connection/도 만들지 않음", async () => {
  const t = await hubWithToken();
  try {
    const st: any = await t.c.req("admin_conn_status", { token: t.token });
    assert.equal(st.ok, true);
    assert.equal(st.server, null);
    assert.deepEqual(st.members, []);
    assert.deepEqual(st.joined, []);
    assert.deepEqual(st.comms, []);
    assert.deepEqual(st.events, []);
    assert.equal(t.hub.conn.hasLiveConnection(), false);
    assert.equal(fs.existsSync(path.join(t.dataDir, "connection")), false);
    t.c.close();
  } finally { t.hub.stop(); }
});

test("full_flow_via_admin_ops: 관리 op만으로 A가 서버를 열고 B가 참여, 양쪽 상태 반영", async () => {
  const A = await hubWithToken();
  const B = await hubWithToken();
  try {
    const port = await freePort();
    const req = (h: typeof A, op: string, p: object = {}) => (h.c.req(op, { token: h.token, ...p }) as Promise<any>);
    assert.equal((await req(A, "admin_conn_set_user", { name: "에이" })).ok, true);
    assert.equal((await req(A, "admin_conn_set_user", { name: "" })).code, "name_invalid");
    const en = await req(A, "admin_conn_enable_server", { port, bindHost: "127.0.0.1", profile: "tls13-aes256gcm", spaceName: "팀", burnOnJoin: true });
    assert.equal(en.ok, true);
    assert.equal(en.port, port);
    assert.equal((await req(A, "admin_conn_enable_server", { port, profile: "tls12-weak", spaceName: "팀", burnOnJoin: true })).code, "profile_invalid");
    const srv = await req(A, "admin_conn_create_server", { name: "팀작업" });
    assert.equal(srv.ok, true);
    const ch = await req(A, "admin_conn_create_channel", { serverId: srv.serverId, name: "main" });
    assert.equal(ch.ok, true);
    assert.equal((await req(A, "admin_conn_set_shared", { serverIds: [srv.serverId] })).ok, true);
    const inv = await req(A, "admin_conn_create_invite", { label: "비", host: "127.0.0.1", expiresInMs: 60_000 });
    assert.equal(inv.ok, true);
    assert.match(inv.code, /^UPLINK1-/);
    assert.equal(inv.ipWarning, true);
    assert.equal((await req(B, "admin_conn_set_user", { name: "비" })).ok, true);
    assert.equal((await req(B, "admin_conn_join", { code: "UPLINK1-AAAA" })).ok, false);
    const j = await req(B, "admin_conn_join", { code: inv.code });
    assert.equal(j.ok, true, j.code);
    let sb: any;
    for (let i = 0; i < 150; i++) {
      sb = await req(B, "admin_conn_status");
      if (sb.joined?.[0]?.connected) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.deepEqual(sb.joined.map((x: any) => [x.spaceName, x.hostUser, x.connected]), [["팀", "에이", true]]);
    const sa = await req(A, "admin_conn_status");
    assert.equal(sa.server.enabled, true);
    assert.equal(sa.server.port, port);
    assert.equal(sa.server.spaceName, "팀");
    assert.deepEqual(sa.server.shared, [srv.serverId]);
    assert.deepEqual(sa.members.map((m: any) => [m.userName, m.revoked, m.online]), [["비", false, true]]);
    // B의 연결 계정 로그인 가능
    const bc = new TestClient(B.port);
    await bc.ready();
    assert.equal((await bc.req("login", { uuid: "b-conn", area: "connection" })).ok, true);
    bc.close();
    A.c.close(); B.c.close();
  } finally { A.hub.stop(); B.hub.stop(); }
});

test("invite_ip_warning_flag: 직접 연결 초대는 항상 IP 경고 표시", async () => {
  const t = await hubWithToken();
  try {
    const req = (op: string, p: object = {}) => (t.c.req(op, { token: t.token, ...p }) as Promise<any>);
    assert.equal((await req("admin_conn_create_invite", { label: "x", host: "203.0.113.5", expiresInMs: 60_000 })).code, "server_not_enabled");
    await req("admin_conn_enable_server", { port: await freePort(), bindHost: "127.0.0.1", profile: "tls13-chacha20", spaceName: "팀", burnOnJoin: true });
    const inv = await req("admin_conn_create_invite", { label: "x", host: "203.0.113.5", expiresInMs: 60_000 });
    assert.equal(inv.ipWarning, true);
    assert.equal((await req("admin_conn_create_invite", { label: "x", host: "", expiresInMs: 60_000 })).code, "host_invalid");
    assert.equal((await req("admin_conn_create_invite", { label: "x", host: "h", expiresInMs: -1 })).code, "expires_invalid");
    t.c.close();
  } finally { t.hub.stop(); }
});

test("revoke_disconnects_live_member: 해지하면 연결 중인 구성원이 끊기고 다시 못 붙는다", async () => {
  const A = await hubWithToken();
  const B = await hubWithToken();
  try {
    const req = (h: typeof A, op: string, p: object = {}) => (h.c.req(op, { token: h.token, ...p }) as Promise<any>);
    await req(A, "admin_conn_set_user", { name: "에이" });
    await req(A, "admin_conn_enable_server", { port: await freePort(), bindHost: "127.0.0.1", profile: "tls13-chacha20", spaceName: "팀", burnOnJoin: true });
    const inv = await req(A, "admin_conn_create_invite", { label: "비", host: "127.0.0.1", expiresInMs: 60_000 });
    await req(B, "admin_conn_set_user", { name: "비" });
    assert.equal((await req(B, "admin_conn_join", { code: inv.code })).ok, true);
    let sa: any;
    for (let i = 0; i < 150; i++) { sa = await req(A, "admin_conn_status"); if (sa.members[0]?.online) break; await new Promise((r) => setTimeout(r, 20)); }
    const memberId = sa.members[0].memberId;
    assert.equal((await req(A, "admin_conn_revoke", { memberId })).ok, true);
    assert.equal((await req(A, "admin_conn_revoke", { memberId: "nope" })).code, "member_not_found");
    let sb: any;
    for (let i = 0; i < 150; i++) { sb = await req(B, "admin_conn_status"); if (!sb.joined[0].connected) break; await new Promise((r) => setTimeout(r, 20)); }
    assert.equal(sb.joined[0].connected, false);
    await new Promise((r) => setTimeout(r, 300)); // 재접속 시도가 몇 번 지나도
    assert.equal((await req(B, "admin_conn_status")).joined[0].connected, false);
    assert.equal((await req(A, "admin_conn_status")).members[0].revoked, true);
    A.c.close(); B.c.close();
  } finally { A.hub.stop(); B.hub.stop(); }
});

test("burn_flag_default_off: 파기 플래그는 사용자가 켰을 때만(설계: 기본 꺼짐)", async () => {
  const t = await hubWithToken();
  try {
    const req = (op: string, p: object = {}) => t.c.req(op, { token: t.token, ...p }) as Promise<any>;
    await req("admin_conn_enable_server", { port: await freePort(), bindHost: "127.0.0.1", profile: "tls13-chacha20", spaceName: "팀" });
    assert.equal((await req("admin_conn_status")).server.burnOnJoin, false);
    await req("admin_conn_enable_server", { port: await freePort(), bindHost: "127.0.0.1", profile: "tls13-chacha20", spaceName: "팀", burnOnJoin: "yes" });
    assert.equal((await req("admin_conn_status")).server.burnOnJoin, false);
    await req("admin_conn_enable_server", { port: await freePort(), bindHost: "127.0.0.1", profile: "tls13-chacha20", spaceName: "팀", burnOnJoin: true });
    assert.equal((await req("admin_conn_status")).server.burnOnJoin, true);
    t.c.close();
  } finally { t.hub.stop(); }
});

test("status_lists_comms_and_events: 상태에 통신 서버·채널 목록과 참여 사건", async () => {
  const A = await hubWithToken();
  const B = await hubWithToken();
  try {
    const req = (h: typeof A, op: string, p: object = {}) => (h.c.req(op, { token: h.token, ...p }) as Promise<any>);
    await req(A, "admin_conn_set_user", { name: "에이" });
    await req(A, "admin_conn_enable_server", { port: await freePort(), bindHost: "127.0.0.1", profile: "tls13-chacha20", spaceName: "팀" });
    const srv = await req(A, "admin_conn_create_server", { name: "팀작업" });
    const ch = await req(A, "admin_conn_create_channel", { serverId: srv.serverId, name: "main" });
    let sa = await req(A, "admin_conn_status");
    assert.deepEqual(sa.comms, [{ serverId: srv.serverId, name: "팀작업", channels: [{ channelId: ch.channelId, name: "main" }] }]);
    const inv = await req(A, "admin_conn_create_invite", { label: "비씨", host: "127.0.0.1", expiresInMs: 60_000 });
    assert.equal((await req(B, "admin_conn_join", { code: inv.code })).ok, true);
    sa = await req(A, "admin_conn_status");
    const joined = sa.events.filter((e: any) => e.code === "member_joined");
    assert.equal(joined.length, 1);
    assert.equal(joined[0].detail.userName, "비씨");
    assert.equal(joined[0].detail.memberId, sa.members[0].memberId);
    assert.equal(typeof joined[0].ts, "number");
    A.c.close(); B.c.close();
  } finally { A.hub.stop(); B.hub.stop(); }
});

test("revoke_logs_and_twice_is_harmless: 퇴출은 사건 한 번, 두 번째 퇴출도 ok", async () => {
  const A = await hubWithToken();
  const B = await hubWithToken();
  try {
    const req = (h: typeof A, op: string, p: object = {}) => (h.c.req(op, { token: h.token, ...p }) as Promise<any>);
    await req(A, "admin_conn_enable_server", { port: await freePort(), bindHost: "127.0.0.1", profile: "tls13-chacha20", spaceName: "팀" });
    const inv = await req(A, "admin_conn_create_invite", { label: "비", host: "127.0.0.1", expiresInMs: 60_000 });
    assert.equal((await req(B, "admin_conn_join", { code: inv.code })).ok, true);
    const memberId = (await req(A, "admin_conn_status")).members[0].memberId;
    assert.equal((await req(A, "admin_conn_revoke", { memberId })).ok, true);
    assert.equal((await req(A, "admin_conn_revoke", { memberId })).ok, true);
    const ev = (await req(A, "admin_conn_status")).events.filter((e: any) => e.code === "member_revoked");
    assert.deepEqual(ev.map((e: any) => e.detail), [{ memberId, userName: "비" }]);
    A.c.close(); B.c.close();
  } finally { A.hub.stop(); B.hub.stop(); }
});
