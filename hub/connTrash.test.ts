import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { freePort, startHubPair, startTestHub, TestClient } from "./testing.js";

async function adminOf(t: { port: number; dataDir: string }) {
  const token = fs.readFileSync(path.join(t.dataDir, "admin.key"), "utf8").trim();
  const c = new TestClient(t.port);
  await c.ready();
  return { c, req: (op: string, p: object = {}) => c.req(op, { token, ...p }) as Promise<any> };
}

async function login(port: number, uuid: string, area?: "connection") {
  const c = new TestClient(port);
  await c.ready();
  assert.equal((await c.req("login", { uuid, ...(area ? { area } : {}) })).ok, true);
  return c;
}

test("delete_comms_channel_to_trash_and_restore: 통신 채널 삭제 → 휴지통(통신 표시) → 복원하면 메시지·영역 그대로", async () => {
  const t = await startTestHub();
  const a = await adminOf(t);
  try {
    await a.req("admin_conn_enable_server", { port: await freePort(), bindHost: "127.0.0.1", profile: "tls13-chacha20", spaceName: "팀" });
    const srv = await a.req("admin_conn_create_server", { name: "팀작업" });
    const ch = (await a.req("admin_conn_create_channel", { serverId: srv.serverId, name: "main" })).channelId;
    const ai = await login(t.port, "conn-ai", "connection");
    assert.equal((await ai.req("send", { channelId: ch, text: "지우기 전" })).ok, true);

    assert.equal((await a.req("admin_conn_delete_channel", { channelId: "nope" })).code, "channel_not_found");
    assert.equal((await a.req("admin_conn_delete_channel", { channelId: ch })).ok, true);
    assert.deepEqual((await a.req("admin_conn_status")).comms[0].channels, []);
    assert.equal((await ai.req("send", { channelId: ch, text: "x" })).code, "channel_not_found");
    const trash = (await a.req("admin_snapshot")).trash;
    assert.equal(trash.length, 1);
    assert.deepEqual([trash[0].kind, trash[0].area, trash[0].name, trash[0].serverName, trash[0].restorable], ["channel", "connection", "main", "팀작업", true]);
    assert.equal(fs.existsSync(path.join(t.dataDir, "connection", "comms", "servers", `${ch}.jsonl`)), false);

    const r = await a.req("admin_restore_trash", { trashId: trash[0].id });
    assert.equal(r.ok, true, r.code);
    assert.deepEqual((await a.req("admin_conn_status")).comms[0].channels, [{ channelId: ch, name: "main" }]);
    const read: any = await ai.req("read", { channelId: ch });
    assert.deepEqual(read.messages.map((m: any) => m.text), ["지우기 전"]);
    assert.equal((await ai.req("send", { channelId: ch, text: "복원 뒤" })).ok, true);
    const local = await login(t.port, "local-ai");
    assert.equal((await local.req("read", { channelId: ch })).code, "channel_forbidden"); // 통신 영역 유지
    assert.deepEqual((await a.req("admin_snapshot")).trash, []);
    ai.close(); local.close();
  } finally { a.c.close(); t.hub.stop(); }
});

test("delete_shared_server_unshares_and_notifies: 공유 중인 통신 서버 삭제 → 공유에서 빠지고 참여자 거울도 사라짐, 복원은 공유 꺼짐", async () => {
  const p = await startHubPair();
  const a = await adminOf(p.A);
  try {
    assert.equal((await a.req("admin_conn_delete_server", { serverId: "nope" })).code, "server_not_found");
    assert.equal((await a.req("admin_conn_delete_server", { serverId: p.serverId })).ok, true);
    let st = await a.req("admin_conn_status");
    assert.deepEqual(st.comms, []);
    assert.deepEqual(st.server.shared, []);
    await p.until(() => !p.B.hub.hasChannelForTest(p.remoteChannelId));
    const item = (await a.req("admin_snapshot")).trash[0];
    assert.deepEqual([item.kind, item.area], ["server", "connection"]);
    assert.equal((await a.req("admin_restore_trash", { trashId: item.id })).ok, true);
    st = await a.req("admin_conn_status");
    assert.deepEqual(st.comms.map((s: any) => [s.serverId, s.channels.length]), [[p.serverId, 1]]);
    assert.deepEqual(st.server.shared, []); // 다시 체크해야 공유
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(p.B.hub.hasChannelForTest(p.remoteChannelId), false);
  } finally { a.c.close(); p.A.hub.stop(); p.B.hub.stop(); }
});

test("local_ops_do_not_touch_comms: 로컬 삭제 op·MCP 삭제는 통신 채널을 못 지운다", async () => {
  const t = await startTestHub();
  const a = await adminOf(t);
  try {
    await a.req("admin_set_config", { patch: { allowDevDelete: true } });
    await a.req("admin_conn_enable_server", { port: await freePort(), bindHost: "127.0.0.1", profile: "tls13-chacha20", spaceName: "팀" });
    const srv = await a.req("admin_conn_create_server", { name: "팀작업" });
    const ch = (await a.req("admin_conn_create_channel", { serverId: srv.serverId, name: "main" })).channelId;
    assert.equal((await a.req("admin_delete_channel", { channelId: ch })).code, "channel_not_found");
    assert.equal((await a.req("admin_delete_server", { serverId: srv.serverId })).code, "server_not_found");
    const ai = await login(t.port, "conn-ai", "connection");
    assert.notEqual((await ai.req("delete_channel", { channelId: ch })).ok, true);
    assert.notEqual((await ai.req("delete_server", { serverId: srv.serverId })).ok, true);
    assert.equal((await a.req("admin_conn_status")).comms[0].channels.length, 1);
    ai.close();
  } finally { a.c.close(); t.hub.stop(); }
});

test("untouched_without_connection: 통신 안 켠 Hub는 통신 삭제 op에도 connection/을 만들지 않는다", async () => {
  const t = await startTestHub();
  const a = await adminOf(t);
  try {
    assert.equal((await a.req("admin_conn_delete_channel", { channelId: "x" })).code, "channel_not_found");
    assert.equal((await a.req("admin_conn_delete_server", { serverId: "x" })).code, "server_not_found");
    assert.equal(fs.existsSync(path.join(t.dataDir, "connection")), false);
  } finally { a.c.close(); t.hub.stop(); }
});
