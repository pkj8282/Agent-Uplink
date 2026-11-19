// v3.1.1 서버 참가제: 계정은 참가한 서버의 내용만 받고 읽고 쓴다(로비·DM·연결 영역은 그대로).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { startTestHub, TestClient, tempDir } from "./testing.js";

async function login(port: number, uuid: string, name = uuid) {
  const c = new TestClient(port);
  await c.ready();
  assert.equal((await c.req("login", { uuid, name })).ok, true);
  return c;
}
const texts = (r: any) => (r.items ?? []).map((i: any) => i.text);

async function twoServers() {
  const t = await startTestHub();
  const a = await login(t.port, "a"), b = await login(t.port, "b");
  const sa = (await a.req("create_server", { name: "에이서버" })).serverId as string;
  const ca = (await a.req("create_channel", { serverId: sa, name: "일반" })).channelId as string;
  const sb = (await b.req("create_server", { name: "비서버" })).serverId as string;
  const cb = (await b.req("create_channel", { serverId: sb, name: "일반" })).channelId as string;
  await a.req("check"); await b.req("check");
  return { t, a, b, sa, ca, sb, cb };
}

test("inbox_only_members: 서버 채널 메시지는 그 서버 참가자에게만 간다", async () => {
  const s = await twoServers();
  try {
    assert.equal((await s.b.req("send", { channelId: s.cb, text: "비만" })).ok, true);
    assert.deepEqual(texts(await s.a.req("check")), [], "a는 비서버에 참가 안 함");
    assert.equal((await s.a.req("join_server", { serverId: s.sb })).changed, true);
    assert.equal((await s.b.req("send", { channelId: s.cb, text: "이제 보임" })).ok, true);
    assert.deepEqual(texts(await s.a.req("check")), ["이제 보임"]);
  } finally { s.t.hub.stop(); }
});

test("lobby_and_dm_unchanged: 로비는 전체, DM은 두 사람 — 참가제와 무관", async () => {
  const s = await twoServers();
  try {
    await s.a.req("send", { channelId: "lobby", text: "로비" });
    assert.deepEqual(texts(await s.b.req("check")), ["로비"]);
    const dm = (await s.a.req("open_dm", { peer: "b" })).channelId;
    await s.a.req("send", { channelId: dm, text: "디엠" });
    assert.deepEqual(texts(await s.b.req("check")), ["디엠"]);
  } finally { s.t.hub.stop(); }
});

test("read_send_not_joined: 참가 안 한 서버 채널은 읽기·쓰기 거부, 참가하면 되고 나가면 다시 거부", async () => {
  const s = await twoServers();
  try {
    const r1: any = await s.a.req("read", { channelId: s.cb });
    assert.equal(r1.code, "not_joined");
    assert.equal(r1.ok, false);
    assert.equal((await s.a.req("send", { channelId: s.cb, text: "x" })).code, "not_joined");
    await s.a.req("join_server", { serverId: s.sb });
    assert.equal((await s.a.req("send", { channelId: s.cb, text: "참가 후" })).ok, true);
    assert.equal((await s.a.req("read", { channelId: s.cb })).ok, true);
    assert.equal((await s.a.req("leave_server", { serverId: s.sb })).changed, true);
    assert.equal((await s.a.req("read", { channelId: s.cb })).code, "not_joined");
    assert.equal((await s.a.req("leave_server", { serverId: s.sb })).changed, false, "두 번째 나가기는 오류 아님");
    assert.equal((await s.a.req("join_server", { serverId: s.sb })).changed, true);
    assert.equal((await s.a.req("join_server", { serverId: s.sb })).changed, false, "두 번째 참가도 오류 아님");
  } finally { s.t.hub.stop(); }
});

test("create_server_auto_joins: 서버를 만든 계정은 자동 참가", async () => {
  const s = await twoServers();
  try {
    await s.a.req("send", { channelId: s.ca, text: "내 서버" });
    assert.equal((await s.a.req("read", { channelId: s.ca })).ok, true);
  } finally { s.t.hub.stop(); }
});

test("list_servers_marks_joined_and_shows_all: 서버 목록은 전부 보이고 참가 여부 표시", async () => {
  const s = await twoServers();
  try {
    const r: any = await s.a.req("list_servers");
    const byId = new Map(r.servers.map((x: any) => [x.serverId, x]));
    assert.equal((byId.get(s.sa) as any).joined, true);
    assert.equal((byId.get(s.sb) as any).joined, false);
  } finally { s.t.hub.stop(); }
});

test("list_channels_visible_without_join: 참가 안 해도 채널 이름은 보인다(참가할지 고르게)", async () => {
  const s = await twoServers();
  try {
    const r: any = await s.a.req("list_channels", { serverId: s.sb });
    assert.deepEqual(r.channels.map((c: any) => c.name), ["일반"]);
  } finally { s.t.hub.stop(); }
});

test("join_unknown_server: 없는 서버·로비·DM id로 참가하면 server_not_found", async () => {
  const s = await twoServers();
  try {
    for (const id of ["nope", "lobby", "s1:nope"]) assert.equal((await s.a.req("join_server", { serverId: id })).code, "server_not_found", id);
    assert.equal((await s.a.req("leave_server", { serverId: "nope" })).code, "server_not_found");
  } finally { s.t.hub.stop(); }
});

test("migration_joins_past_senders: 참가자 리스트 없이 기존 기록으로 시작하면 글 쓴 계정만 자동 참가", async () => {
  const dir = tempDir("uplink-mig-");
  const t1 = await startTestHub({ dataDir: dir });
  const a = await login(t1.port, "a"), b = await login(t1.port, "b"), c = await login(t1.port, "c");
  const srv = (await a.req("create_server", { name: "옛서버" })).serverId as string;
  const ch = (await a.req("create_channel", { serverId: srv, name: "일반" })).channelId as string;
  await b.req("join_server", { serverId: srv });
  await b.req("send", { channelId: ch, text: "비가 썼음" });
  a.close(); b.close(); c.close();
  t1.hub.stop();
  fs.rmSync(path.join(dir, "memberships.json")); // 3.1.0 데이터 폴더처럼
  const t2 = await startTestHub({ dataDir: dir });
  try {
    const b2 = await login(t2.port, "b"), c2 = await login(t2.port, "c"), a2 = await login(t2.port, "a");
    assert.equal((await b2.req("read", { channelId: ch })).ok, true, "글 쓴 b는 참가");
    assert.equal((await c2.req("read", { channelId: ch })).code, "not_joined", "읽기만 한 c는 아님");
    assert.equal((await a2.req("read", { channelId: ch })).code, "not_joined", "a는 이 기록에 글을 안 썼음(만든 것은 기록에 없음)");
    const mem = JSON.parse(fs.readFileSync(path.join(dir, "memberships.json"), "utf8"));
    assert.deepEqual(mem.servers[srv], ["b"]);
  } finally { t2.hub.stop(); }
});

test("restored_channel_still_filtered: 휴지통에서 되살린 서버 채널도 참가자만 받는다", async () => {
  const s = await twoServers();
  try {
    const token = fs.readFileSync(path.join(s.t.dataDir, "admin.key"), "utf8").trim();
    const adm = new TestClient(s.t.port); await adm.ready();
    assert.equal((await adm.req("admin_delete_channel", { token, channelId: s.cb })).ok, true);
    const snap: any = await adm.req("admin_snapshot", { token });
    const item = snap.trash.find((x: any) => x.kind === "channel");
    assert.equal((await adm.req("admin_restore_trash", { token, trashId: item.id })).ok, true);
    await s.b.req("send", { channelId: s.cb, text: "되살린 뒤" });
    assert.deepEqual(texts(await s.a.req("check")), []);
    adm.close();
  } finally { s.t.hub.stop(); }
});
