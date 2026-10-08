// v2.1.2 관리 앱 DM 삭제: 휴지통 종류 dm, 복원 거부 2종, 크래시 이어서 끝내기, 레드팀 RT34–RT36.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { startTestHub, TestClient as Client, tempDir } from "./testing.js";

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";

async function startHub(dataDir = tempDir("uplink-dmdel-")) {
  const t = await startTestHub({ dataDir });
  return { ...t, token: fs.readFileSync(path.join(t.dataDir, "admin.key"), "utf8").trim() };
}

async function seed(port: number) {
  const a = new Client(port); await a.ready(); await a.req("login", { uuid: A, name: "A" });
  const b = new Client(port); await b.ready(); await b.req("login", { uuid: B, name: "B" });
  const dm = (await a.req("open_dm", { peer: "B" })).channelId!;
  await a.req("send", { channelId: dm, text: "DM 메시지" });
  const admin = new Client(port); await admin.ready();
  return { a, b, dm, admin };
}

const metas = (dataDir: string) => {
  const d = path.join(dataDir, "trash");
  return fs.readdirSync(d).map((id) => JSON.parse(fs.readFileSync(path.join(d, id, "meta.json"), "utf8")));
};

test("DM 삭제: 로그가 휴지통으로, 색인·양쪽 역색인에서 빠지고, 복원하면 같은 ID·기록으로 돌아온다", async () => {
  const { hub, port, dataDir, token } = await startHub();
  const s = await seed(port);
  assert.equal((await s.admin.req("admin_delete_dm", { token, channelId: s.dm })).ok, true);
  assert.equal(fs.existsSync(path.join(dataDir, "dm", `${s.dm}.jsonl`)), false);
  const [m] = metas(dataDir).filter((x) => x.kind === "dm");
  assert.equal(m.state, "done"); assert.equal(m.deletedBy, "admin"); assert.equal(m.name, "A ↔ B");
  assert.deepEqual(m.dm, { channelId: s.dm, members: [A, B], label: "A-B" });
  assert.deepEqual(m.files, [`${s.dm}.jsonl`]);
  assert.deepEqual((await s.a.req("list_dms")).dms, []);
  assert.deepEqual((await s.b.req("list_dms")).dms, []);
  const send = await s.a.req("send", { channelId: s.dm, text: "삭제 후" });
  assert.equal(send.ok, false); assert.equal(send.code, "channel_not_found");
  const item = (await s.admin.req("admin_snapshot", { token })).trash!.find((t) => t.kind === "dm")!;
  assert.equal(item.restorable, true); assert.equal(item.name, "A ↔ B");
  assert.equal((await s.admin.req("admin_restore_trash", { token, trashId: item.id })).ok, true);
  assert.equal((await s.a.req("list_dms")).dms![0].channelId, s.dm);
  assert.equal((await s.b.req("read", { channelId: s.dm })).messages![0].text, "DM 메시지");
  assert.equal((await s.admin.req("admin_snapshot", { token })).trash!.length, 0);
  s.a.close(); s.b.close(); s.admin.close(); hub.stop();
});

test("DM 삭제 중 접속한 세션: 삭제 전 쌓인 알림은 그대로 전달(기존 동작), 이후 wait는 정상 타임아웃", async () => {
  const { hub, port, token } = await startHub();
  const s = await seed(port);
  await s.a.req("send", { channelId: s.dm, text: "안 읽은 알림" });
  assert.equal((await s.admin.req("admin_delete_dm", { token, channelId: s.dm })).ok, true);
  const w = await s.b.req("wait", { timeoutMs: 200 });
  assert.equal(w.ok, true);
  assert.equal(w.items!.some((i) => i.text === "안 읽은 알림"), true);
  const w2 = await s.b.req("wait", { timeoutMs: 200 });
  assert.equal(w2.ok, true); assert.deepEqual(w2.items ?? [], []);
  s.a.close(); s.b.close(); s.admin.close(); hub.stop();
});

test("DM 복원 거부: 새 DM이 있으면 dm_exists, 멤버 계정이 없으면 dm_member_missing — 아무것도 바뀌지 않음", async () => {
  const { hub, port, token } = await startHub();
  const s = await seed(port);
  await s.admin.req("admin_delete_dm", { token, channelId: s.dm });
  const oldId = (await s.admin.req("admin_snapshot", { token })).trash![0].id;
  const fresh = (await s.a.req("open_dm", { peer: "B" })).channelId!;
  const r1 = await s.admin.req("admin_restore_trash", { token, trashId: oldId });
  assert.equal(r1.ok, false); assert.equal(r1.code, "dm_exists");
  assert.equal((await s.a.req("list_dms")).dms![0].channelId, fresh);
  await s.admin.req("admin_delete_dm", { token, channelId: fresh });
  s.b.close();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await s.admin.req("admin_delete_account", { token, uuid: B })).ok, true);
  const r2 = await s.admin.req("admin_restore_trash", { token, trashId: oldId });
  assert.equal(r2.ok, false); assert.equal(r2.code, "dm_member_missing");
  assert.equal((await s.admin.req("admin_snapshot", { token })).trash!.some((t) => t.id === oldId), true);
  s.a.close(); s.admin.close(); hub.stop();
});

test("크래시 이어서 끝내기: deleting 메타는 시작 때 삭제를, restoring 메타는 복원을 마저 한다", async () => {
  const first = await startHub();
  const s = await seed(first.port);
  s.a.close(); s.b.close(); s.admin.close(); first.hub.stop();
  const id = `${String(Date.now()).padStart(13, "0")}-dm-0a1b2c3d`;
  fs.mkdirSync(path.join(first.dataDir, "trash", id), { recursive: true });
  fs.writeFileSync(path.join(first.dataDir, "trash", id, "meta.json"), JSON.stringify({
    v: 1, id, kind: "dm", state: "deleting", deletedAt: Date.now(), deletedBy: "admin", name: "A ↔ B",
    dm: { channelId: s.dm, members: [A, B], label: "A-B" }, files: [],
  }));
  const second = await startHub(first.dataDir);
  assert.equal(fs.existsSync(path.join(first.dataDir, "dm", `${s.dm}.jsonl`)), false);
  const m = JSON.parse(fs.readFileSync(path.join(first.dataDir, "trash", id, "meta.json"), "utf8"));
  assert.equal(m.state, "done"); assert.deepEqual(m.files, [`${s.dm}.jsonl`]);
  second.hub.stop();
  m.state = "restoring";
  fs.writeFileSync(path.join(first.dataDir, "trash", id, "meta.json"), JSON.stringify(m));
  const third = await startHub(first.dataDir);
  const a = new Client(third.port); await a.ready(); await a.req("login", { uuid: A });
  assert.equal((await a.req("list_dms")).dms![0].channelId, s.dm);
  assert.equal(fs.existsSync(path.join(first.dataDir, "trash", id)), false);
  a.close(); third.hub.stop();
});

test("RT34: 무인증 연결·일반 세션·틀린 토큰의 admin_delete_dm은 거부, DM 그대로", async () => {
  const { hub, port, token } = await startHub();
  const s = await seed(port);
  const raw = new Client(port); await raw.connected();
  assert.equal((await raw.req("admin_delete_dm", { token, channelId: s.dm })).code, "auth_required");
  assert.equal((await s.a.req("admin_delete_dm", { channelId: s.dm })).code, "admin_auth_failed");
  assert.equal((await s.a.req("admin_delete_dm", { token: "0".repeat(64), channelId: s.dm })).code, "admin_auth_failed");
  assert.equal((await s.a.req("list_dms")).dms![0].channelId, s.dm);
  raw.close(); s.a.close(); s.b.close(); s.admin.close(); hub.stop();
});

test("RT35: 경로 조작·다른 종류 ID·잘못된 형식은 dm_not_found, 다른 데이터 변경 없음", async () => {
  const { hub, port, token } = await startHub();
  const s = await seed(port);
  const srv = (await s.a.req("create_server", { name: "Main" })).serverId!;
  const chId = (await s.a.req("create_channel", { serverId: srv, name: "c" })).channelId!;
  for (const bad of ["../dm/index", `..${path.sep}accounts${path.sep}${A}`, chId, "lobby", "__proto__", 123, null, undefined]) {
    const r = await s.admin.req("admin_delete_dm", { token, channelId: bad as never });
    assert.equal(r.ok, false, String(bad)); assert.equal(r.code, "dm_not_found", String(bad));
  }
  assert.equal((await s.a.req("list_channels", { serverId: srv })).channels!.length, 1);
  assert.equal((await s.a.req("list_dms")).dms!.length, 1);
  assert.equal((await s.a.req("read", { channelId: "lobby" })).ok, true);
  s.a.close(); s.b.close(); s.admin.close(); hub.stop();
});

test("RT36: 변조된 dm 메타(같은 계정 둘·잘못된 ID·필드 누락)는 손상으로 거부, 유령 계정 없음", async () => {
  const { hub, port, dataDir, token } = await startHub();
  const s = await seed(port);
  await s.admin.req("admin_delete_dm", { token, channelId: s.dm });
  const id = (await s.admin.req("admin_snapshot", { token })).trash![0].id;
  const mf = path.join(dataDir, "trash", id, "meta.json");
  const orig = JSON.parse(fs.readFileSync(mf, "utf8"));
  const variants = [
    { ...orig, dm: { ...orig.dm, members: [A, A] } },
    { ...orig, dm: { ...orig.dm, members: ["../evil", B] } },
    { ...orig, dm: { ...orig.dm, channelId: "../../accounts/x" } },
    { ...orig, dm: undefined },
  ];
  for (const v of variants) {
    fs.writeFileSync(mf, JSON.stringify(v));
    const r = await s.admin.req("admin_restore_trash", { token, trashId: id });
    assert.equal(r.ok, false); assert.equal(r.code, "trash_missing");
  }
  const accounts = (await s.a.req("list_accounts")).accounts!.map((x) => x.uuid).sort();
  assert.deepEqual(accounts, [A, B]);
  s.a.close(); s.b.close(); s.admin.close(); hub.stop();
});
