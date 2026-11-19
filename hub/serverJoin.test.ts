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
    assert.deepEqual(mem.servers[srv], { members: ["b"], history: ["b"] });
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

// ───── Task 3: 계정·서버 삭제·복원 때 리스트 편집, 동기화 ─────
async function admin(t: { port: number; dataDir: string }) {
  const token = fs.readFileSync(path.join(t.dataDir, "admin.key"), "utf8").trim();
  const c = new TestClient(t.port); await c.ready();
  return { c, req: (op: string, p: object = {}) => c.req(op, { token, ...p }) as Promise<any> };
}
const memRaw = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, "memberships.json"), "utf8"));
const memFile = (dir: string) => Object.fromEntries(Object.entries(memRaw(dir).servers as Record<string, { members: string[] }>).map(([s, r]) => [s, r.members])) as Record<string, string[]>;
const histFile = (dir: string) => Object.fromEntries(Object.entries(memRaw(dir).servers as Record<string, { history: string[] }>).map(([s, r]) => [s, r.history])) as Record<string, string[]>;
const trashIdOf = async (adm: Awaited<ReturnType<typeof admin>>, kind: string) => (await adm.req("admin_snapshot")).trash.find((x: any) => x.kind === kind).id;

test("delete_server_removes_row_restore_brings_back: 서버를 지우면 줄이 빠지고, 되살리면 참가자도 돌아온다", async () => {
  const s = await twoServers();
  try {
    await s.a.req("join_server", { serverId: s.sb });
    const adm = await admin(s.t);
    assert.equal((await adm.req("admin_delete_server", { serverId: s.sb })).ok, true);
    assert.equal(s.sb in memFile(s.t.dataDir), false);
    assert.equal((await adm.req("admin_restore_trash", { trashId: await trashIdOf(adm, "server") })).ok, true);
    assert.deepEqual(memFile(s.t.dataDir)[s.sb].sort(), ["a", "b"]);
    await s.b.req("send", { channelId: s.cb, text: "되살린 서버" });
    assert.deepEqual(texts(await s.a.req("check")), ["되살린 서버"]);
    adm.c.close();
  } finally { s.t.hub.stop(); }
});

test("delete_account_removes_everywhere_restore_brings_back: 계정을 지우면 모든 서버에서 빠지고, 되살리면 다시 들어간다", async () => {
  const s = await twoServers();
  try {
    await s.a.req("join_server", { serverId: s.sb });
    const adm = await admin(s.t);
    assert.equal((await adm.req("admin_delete_account", { uuid: "a" })).ok, true);
    const m1 = memFile(s.t.dataDir);
    assert.equal(m1[s.sa].includes("a") || m1[s.sb].includes("a"), false);
    assert.equal((await adm.req("admin_restore_trash", { trashId: await trashIdOf(adm, "account") })).ok, true);
    const m2 = memFile(s.t.dataDir);
    assert.equal(m2[s.sa].includes("a") && m2[s.sb].includes("a"), true);
    adm.c.close();
  } finally { s.t.hub.stop(); }
});

test("restore_skips_vanished: 서버를 되살릴 때 그 사이 지워진 계정은 넣지 않는다", async () => {
  const s = await twoServers();
  try {
    await s.a.req("join_server", { serverId: s.sb });
    const adm = await admin(s.t);
    await adm.req("admin_delete_server", { serverId: s.sb });
    await adm.req("admin_delete_account", { uuid: "a" });
    assert.equal((await adm.req("admin_restore_trash", { trashId: await trashIdOf(adm, "server") })).ok, true);
    assert.deepEqual(memFile(s.t.dataDir)[s.sb], ["b"]);
    adm.c.close();
  } finally { s.t.hub.stop(); }
});

test("admin_sync_memberships_counts: 동기화는 유령 서버·계정을 지우고 빠진 서버를 빈 줄로 더한다", async () => {
  const s = await twoServers();
  try {
    const f = path.join(s.t.dataDir, "memberships.json");
    const j = memRaw(s.t.dataDir);
    j.servers["유령서버"] = { members: ["a"], history: ["a"] };
    j.servers[s.sa].members.push("ghost-account");
    delete j.servers[s.sb];
    j.accounts.b = [...(j.accounts.b ?? []).filter((x: string) => x !== s.sb), s.sa]; // 계정 쪽에만 있는 짝(서버 A의 b)
    fs.writeFileSync(f, JSON.stringify(j));
    const adm = await admin(s.t);
    // 파일을 직접 고쳤으니 Hub가 다시 읽도록 재시작 없이 op가 파일 기준으로 맞추는지 보려면 Hub 재시작이 필요 — 여기서는 새 Hub로 연다
    adm.c.close();
    s.t.hub.stop();
    const t2 = await startTestHub({ dataDir: s.t.dataDir });
    const adm2 = await admin(t2);
    const r = await adm2.req("admin_sync_memberships");
    assert.deepEqual([r.ok, r.removedServers, r.removedMembers, r.addedServers, r.repaired], [true, 1, 1, 1, 1]); // 맞춘 짝: 서버 A의 b(계정 쪽에만 있었음) — 유령은 먼저 지워 세지 않음
    const after = memFile(t2.dataDir);
    assert.equal("유령서버" in after, false);
    assert.equal(after[s.sa].includes("ghost-account"), false);
    assert.deepEqual(after[s.sb], []);
    assert.equal(after[s.sa].includes("b"), true, "계정 쪽에만 있던 짝은 참가로 판정");
    adm2.c.close();
    t2.hub.stop();
  } catch (e) { s.t.hub.stop(); throw e; }
});

test("snapshot_has_memberships: 관리 스냅샷에 서버 관점 참가자 리스트", async () => {
  const s = await twoServers();
  try {
    const adm = await admin(s.t);
    const snap = await adm.req("admin_snapshot");
    assert.deepEqual(snap.memberships[s.sa], ["a"]);
    assert.deepEqual(snap.memberships[s.sb], ["b"]);
    adm.c.close();
  } finally { s.t.hub.stop(); }
});

test("history_in_snapshot_and_trash: 나간 계정은 참가 전적에 남고, 서버를 지웠다 되살리면 전적도 돌아온다", async () => {
  const s = await twoServers();
  try {
    await s.a.req("join_server", { serverId: s.sb });
    await s.a.req("leave_server", { serverId: s.sb });
    const adm = await admin(s.t);
    let snap = await adm.req("admin_snapshot");
    assert.deepEqual(snap.memberships[s.sb], ["b"]);
    assert.deepEqual(snap.membershipHistory[s.sb].sort(), ["a", "b"]);
    await adm.req("admin_delete_server", { serverId: s.sb });
    assert.equal(s.sb in histFile(s.t.dataDir), false);
    assert.equal((await adm.req("admin_restore_trash", { trashId: await trashIdOf(adm, "server") })).ok, true);
    snap = await adm.req("admin_snapshot");
    assert.deepEqual(snap.memberships[s.sb], ["b"], "나간 a는 되살려도 참가자가 아님");
    assert.deepEqual(snap.membershipHistory[s.sb].sort(), ["a", "b"]);
    const r = await adm.req("admin_sync_memberships");
    assert.equal(r.repaired, 0);
    assert.deepEqual((await adm.req("admin_snapshot")).memberships[s.sb], ["b"], "동기화해도 나간 a는 되살아나지 않음");
    adm.c.close();
  } finally { s.t.hub.stop(); }
});

// ───── 최종 리뷰 Important 3·4·(Minor→Important) ─────
test("leave_drops_queued: 나간 서버의, 아직 안 읽은 메시지는 받은편지함에서 걸러진다(묶음 상한을 넘어도)", async () => {
  const s = await twoServers();
  try {
    const adm = await admin(s.t);
    await adm.req("admin_set_config", { patch: { inboxMaxBatch: 2 } });
    await s.a.req("join_server", { serverId: s.sb });
    for (let i = 0; i < 5; i++) await s.b.req("send", { channelId: s.cb, text: `쌓임${i}` });
    await s.b.req("send", { channelId: "lobby", text: "로비" });
    await s.a.req("leave_server", { serverId: s.sb });
    assert.deepEqual(texts(await s.a.req("check")), ["로비"], "나간 서버 것은 걸러지고 뒤의 로비 글이 온다");
    adm.c.close();
  } finally { s.t.hub.stop(); }
});

test("sync_keeps_space_rows_known_on_disk: 동기화는 지금 활성 목록에 없더라도 디스크에 있는 공간 서버 줄을 지우지 않는다", async () => {
  const s = await twoServers();
  try {
    const sp = path.join(s.t.dataDir, "connection", "spaces1", "sp-pending");
    fs.mkdirSync(sp, { recursive: true });
    const adm = await admin(s.t);
    adm.c.close();
    s.t.hub.stop();
    const j = memRaw(s.t.dataDir);
    j.servers["s1:sp-pending"] = { members: ["a"], history: ["a"] };
    j.accounts.a = [...(j.accounts.a ?? []), "s1:sp-pending"];
    fs.writeFileSync(path.join(s.t.dataDir, "memberships.json"), JSON.stringify(j));
    const t2 = await startTestHub({ dataDir: s.t.dataDir });
    const adm2 = await admin(t2);
    const r = await adm2.req("admin_sync_memberships");
    assert.equal(r.removedServers, 0);
    assert.deepEqual(memFile(t2.dataDir)["s1:sp-pending"], ["a"]);
    adm2.c.close();
    t2.hub.stop();
  } catch (e) { s.t.hub.stop(); throw e; }
});

test("old_trash_server_restore_seeds_from_logs: 3.1.0 시절에 지운 서버(참가 정보 없음)를 되살리면 글 쓴 계정이 참가자가 된다", async () => {
  const s = await twoServers();
  try {
    await s.b.req("send", { channelId: s.cb, text: "비의 글" });
    const adm = await admin(s.t);
    await adm.req("admin_delete_server", { serverId: s.sb });
    const id = await trashIdOf(adm, "server");
    const metaFile = path.join(s.t.dataDir, "trash", id, "meta.json");
    const meta = JSON.parse(fs.readFileSync(metaFile, "utf8"));
    delete meta.memberships; delete meta.membershipHistory; // 옛 항목처럼
    fs.writeFileSync(metaFile, JSON.stringify(meta));
    assert.equal((await adm.req("admin_restore_trash", { trashId: id })).ok, true);
    assert.deepEqual(memFile(s.t.dataDir)[s.sb], ["b"]);
    adm.c.close();
  } finally { s.t.hub.stop(); }
});

test("not_joined_hint_mentions_restart: 참가 안내는 옛 세션(도구 없음)에게 다시 시작하라고도 말한다", async () => {
  const s = await twoServers();
  try {
    const r: any = await s.a.req("read", { channelId: s.cb });
    assert.match(r.error, /join_server/);
    assert.match(r.error, /다시 시작/);
  } finally { s.t.hub.stop(); }
});

test("fanout_skips_unknown_accounts: 리스트에 없는 계정이 섞여 있어도 받은편지함 파일을 만들지 않는다", async () => {
  const s = await twoServers();
  try {
    const adm = await admin(s.t);
    adm.c.close();
    s.t.hub.stop();
    const j = memRaw(s.t.dataDir);
    j.servers[s.sa].members.push("ghost-account");
    fs.writeFileSync(path.join(s.t.dataDir, "memberships.json"), JSON.stringify(j));
    const t2 = await startTestHub({ dataDir: s.t.dataDir });
    const a2 = await login(t2.port, "a");
    await a2.req("send", { channelId: s.ca, text: "유령에게 가면 안 됨" });
    assert.equal(fs.existsSync(path.join(s.t.dataDir, "notifications", "ghost-account.jsonl")), false);
    a2.close();
    t2.hub.stop();
  } catch (e) { s.t.hub.stop(); throw e; }
});

test("snapshot_has_account_view: 관리 스냅샷에 참가자 관점(계정 → 서버)도 실린다", async () => {
  const s = await twoServers();
  try {
    await s.a.req("join_server", { serverId: s.sb });
    const adm = await admin(s.t);
    const snap = await adm.req("admin_snapshot");
    assert.deepEqual(snap.membershipAccounts.a.sort(), [s.sa, s.sb].sort());
    assert.deepEqual(snap.membershipAccounts.b, [s.sb]);
    adm.c.close();
  } finally { s.t.hub.stop(); }
});
