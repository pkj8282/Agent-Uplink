import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { encodeFrame, FrameDecoder } from "../shared/framing.js";
import { Hub } from "./server.js";
import { Response } from "../shared/protocol.js";

function tmp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), "uplink-tops-")); }

import { startTestHub, TestClient as Client } from "./testing.js";

async function startHub(dataDir = tmp()) {
  // MCP 삭제(delete_channel/delete_server) 경로를 시험하므로 기존 설치처럼 켜 둔다(v2.0.2 새 설치 기본값은 꺼짐).
  if (!fs.existsSync(path.join(dataDir, "config.json"))) fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify({ allowDevDelete: true }));
  const { hub, port } = await startTestHub({ dataDir });
  return { hub, port, dataDir, token: fs.readFileSync(path.join(dataDir, "admin.key"), "utf8").trim() };
}

function trashMetas(dataDir: string): any[] {
  const d = path.join(dataDir, "trash");
  return fs.readdirSync(d).map((id) => JSON.parse(fs.readFileSync(path.join(d, id, "meta.json"), "utf8")));
}

/** 서버 1·채널 2(메시지 있음/없음) + 계정 A·B와 DM(메시지 있음)을 심는다. */
async function seed(port: number) {
  const a = new Client(port); await a.ready(); await a.req("login", { uuid: "aaaaaaaa-0000-4000-8000-000000000001", name: "A" });
  const b = new Client(port); await b.ready(); await b.req("login", { uuid: "bbbbbbbb-0000-4000-8000-000000000002", name: "B" });
  const srv = (await a.req("create_server", { name: "Main" })).serverId!;
  const ch1 = (await a.req("create_channel", { serverId: srv, name: "일반" })).channelId!;
  const ch2 = (await a.req("create_channel", { serverId: srv, name: "빈채널" })).channelId!;
  await a.req("send", { channelId: ch1, text: "채널 메시지" });
  const dm = (await a.req("open_dm", { peer: "B" })).channelId!;
  await a.req("send", { channelId: dm, text: "DM 메시지" });
  return { a, b, srv, ch1, ch2, dm, A: "aaaaaaaa-0000-4000-8000-000000000001", B: "bbbbbbbb-0000-4000-8000-000000000002" };
}

test("채널 삭제: 로그가 휴지통으로 이동, meta는 done·소속 서버 기록, 이후 send는 오류", async () => {
  const { hub, port, dataDir } = await startHub();
  const s = await seed(port);
  assert.equal((await s.a.req("delete_channel", { channelId: s.ch1 })).ok, true);
  assert.equal(fs.existsSync(path.join(dataDir, "servers", `${s.ch1}.jsonl`)), false);
  const [m] = trashMetas(dataDir);
  assert.equal(m.kind, "channel"); assert.equal(m.state, "done"); assert.equal(m.deletedBy, "mcp");
  assert.equal(m.serverId, s.srv); assert.equal(m.serverName, "Main");
  assert.deepEqual(m.files, [`${s.ch1}.jsonl`]);
  const r = await s.a.req("send", { channelId: s.ch1, text: "삭제 후" });
  assert.equal(r.ok, false); assert.equal(r.code, "channel_not_found");
  assert.equal(fs.existsSync(path.join(dataDir, "servers", `${s.ch1}.jsonl`)), false); // 로그 재생성 없음
  s.a.close(); s.b.close(); hub.stop();
});

test("서버 삭제: 소속 채널 로그 전부가 항목 1개로(빈 채널 로그는 files에 없음)", async () => {
  const { hub, port, dataDir, token } = await startHub();
  const s = await seed(port);
  const admin = new Client(port); await admin.ready();
  assert.equal((await admin.req("admin_delete_server", { token, serverId: s.srv })).ok, true);
  const ms = trashMetas(dataDir);
  assert.equal(ms.length, 1);
  assert.equal(ms[0].kind, "server"); assert.equal(ms[0].deletedBy, "admin");
  assert.deepEqual(ms[0].channels.map((c: any) => c.name), ["일반", "빈채널"]);
  assert.deepEqual(ms[0].files, [`${s.ch1}.jsonl`]);
  admin.close(); s.a.close(); s.b.close(); hub.stop();
});

test("계정 삭제: account.json·DM 로그는 휴지통, 인박스는 영구 삭제, 상대 역색인 정리", async () => {
  const { hub, port, dataDir, token } = await startHub();
  const s = await seed(port);
  const admin = new Client(port); await admin.ready();
  assert.equal((await admin.req("admin_delete_account", { token, uuid: s.A })).ok, true);
  const [m] = trashMetas(dataDir);
  assert.equal(m.kind, "account"); assert.equal(m.account.uuid, s.A); assert.equal(m.name, "A");
  assert.deepEqual(m.dms, [{ channelId: s.dm, peer: s.B, label: "A-B" }]);
  assert.deepEqual([...m.files].sort(), [`${s.dm}.jsonl`, "account.json"].sort());
  assert.equal(fs.existsSync(path.join(dataDir, "notifications", `${s.A}.jsonl`)), false);
  assert.deepEqual((await s.b.req("list_dms")).dms, []);
  admin.close(); s.a.close(); s.b.close(); hub.stop();
});

test("시작 복구: state=deleting 항목은 재기동 시 마저 삭제되고, 삭제 중이던 계정은 되살아나지 않는다", async () => {
  const dataDir = tmp();
  {
    const { hub, port } = await startHub(dataDir);
    const s = await seed(port);
    s.a.close(); s.b.close(); hub.stop();
    // 크래시 흉내: 계정 삭제 저널만 쓰고 실제 삭제 전 중단
    const id = "1759500000000-account-0000abcd";
    fs.mkdirSync(path.join(dataDir, "trash", id), { recursive: true });
    fs.writeFileSync(path.join(dataDir, "trash", id, "meta.json"), JSON.stringify({
      v: 1, id, kind: "account", state: "deleting", deletedAt: 1759500000000, deletedBy: "admin", name: "A",
      account: { uuid: s.A }, dms: [{ channelId: s.dm, peer: s.B, label: "A-B" }], files: [],
    }));
  }
  const { hub, port, token } = await startHub(dataDir);
  const admin = new Client(port); await admin.ready();
  const snap = await admin.req("admin_snapshot", { token });
  assert.deepEqual(snap.snapshotAccounts!.map((a) => a.name), ["B"]);
  assert.deepEqual(snap.snapshotDms, []);
  const m = trashMetas(dataDir)[0];
  assert.equal(m.state, "done");
  assert.equal(m.files.includes("account.json"), true);
  admin.close(); hub.stop();
});

async function restore(admin: Client, token: string, id: string, confirmRename?: boolean) {
  return admin.req("admin_restore_trash", { token, trashId: id, ...(confirmRename === undefined ? {} : { confirmRename }) });
}

test("채널 복원: 같은 id·이름으로 돌아오고 이전 메시지를 read로 볼 수 있다, 항목은 사라진다", async () => {
  const { hub, port, token } = await startHub();
  const s = await seed(port);
  const admin = new Client(port); await admin.ready();
  await admin.req("admin_delete_channel", { token, channelId: s.ch1 });
  const snap = await admin.req("admin_snapshot", { token });
  const item = snap.trash![0];
  assert.equal(item.restorable, true);
  const r = await restore(admin, token, item.id);
  assert.equal(r.ok, true);
  assert.equal(r.restored!.itemRemoved, true);
  assert.deepEqual(r.restored!.renamed, []);
  assert.deepEqual((await s.a.req("read", { channelId: s.ch1 })).messages!.map((m) => m.text), ["채널 메시지"]);
  assert.deepEqual((await admin.req("admin_snapshot", { token })).trash, []);
  admin.close(); s.a.close(); s.b.close(); hub.stop();
});

test("이름 충돌: 확인 없이는 name_conflict+미리보기(변경 없음), confirmRename이면 번호를 붙여 복원", async () => {
  const { hub, port, token } = await startHub();
  const s = await seed(port);
  const admin = new Client(port); await admin.ready();
  await admin.req("admin_delete_channel", { token, channelId: s.ch1 });
  await s.a.req("create_channel", { serverId: s.srv, name: "일반" });
  await s.a.req("create_channel", { serverId: s.srv, name: "일반 (3)" });
  const id = (await admin.req("admin_snapshot", { token })).trash![0].id;
  const first = await restore(admin, token, id);
  assert.equal(first.ok, false);
  assert.equal(first.code, "name_conflict");
  assert.deepEqual(first.conflicts, [{ kind: "channel", name: "일반", to: "일반 (4)" }]);
  assert.equal((await admin.req("admin_snapshot", { token })).trash!.length, 1); // 변경 없음
  const ok = await restore(admin, token, id, true);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.restored!.renamed, [{ kind: "channel", from: "일반", to: "일반 (4)" }]);
  const names = (await s.a.req("list_channels", { serverId: s.srv })).channels!.map((c) => c.name).sort();
  assert.deepEqual(names, ["빈채널", "일반", "일반 (3)", "일반 (4)"].sort());
  admin.close(); s.a.close(); s.b.close(); hub.stop();
});

test("채널 복원 시 서버가 없으면 원래 id로 다시 만들고, 이후 서버 항목 복원은 그 서버로 합친다", async () => {
  const { hub, port, token } = await startHub();
  const s = await seed(port);
  const admin = new Client(port); await admin.ready();
  await admin.req("admin_delete_channel", { token, channelId: s.ch1 });
  await admin.req("admin_delete_server", { token, serverId: s.srv });
  const [chItem, srvItem] = (await admin.req("admin_snapshot", { token })).trash!;
  assert.equal(chItem.kind, "channel"); assert.equal(srvItem.kind, "server");
  const r1 = await restore(admin, token, chItem.id);
  assert.deepEqual(r1.restored!.recreatedServer, { id: s.srv, name: "Main" });
  const r2 = await restore(admin, token, srvItem.id);
  assert.equal(r2.ok, true);
  const servers = (await s.a.req("list_servers")).servers!;
  assert.deepEqual(servers.map((x) => [x.serverId, x.name, x.channelCount]), [[s.srv, "Main", 2]]);
  admin.close(); s.a.close(); s.b.close(); hub.stop();
});

test("복원이 채널 한계를 넘으면 channel_limit, 변경 없음", async () => {
  const { hub, port, token } = await startHub();
  const s = await seed(port);
  const admin = new Client(port); await admin.ready();
  await admin.req("admin_delete_channel", { token, channelId: s.ch1 });
  await admin.req("admin_set_config", { token, patch: { maxChannelsPerServer: 1 } });
  const id = (await admin.req("admin_snapshot", { token })).trash![0].id;
  const r = await restore(admin, token, id);
  assert.equal(r.code, "channel_limit");
  assert.equal((await admin.req("admin_snapshot", { token })).trash!.length, 1);
  admin.close(); s.a.close(); s.b.close(); hub.stop();
});

test("탐색기로 파일이 지워진 항목·두 번째 복원은 trash_missing, orphan은 not_restorable, 잘못된 id는 bad_id", async () => {
  const { hub, port, dataDir, token } = await startHub();
  const s = await seed(port);
  const admin = new Client(port); await admin.ready();
  await admin.req("admin_delete_channel", { token, channelId: s.ch1 });
  await admin.req("admin_delete_channel", { token, channelId: s.ch2 });
  const [i1, i2] = (await admin.req("admin_snapshot", { token })).trash!;
  fs.rmSync(path.join(dataDir, "trash", i1.id, `${s.ch1}.jsonl`));
  assert.equal((await restore(admin, token, i1.id)).code, "trash_missing");
  assert.equal((await restore(admin, token, i2.id)).ok, true);
  assert.equal((await restore(admin, token, i2.id)).code, "trash_missing"); // 두 번째
  assert.equal((await restore(admin, token, "../../etc")).code, "trash_bad_id");
  const oid = "1759500000000-orphan-0000beef";
  fs.mkdirSync(path.join(dataDir, "trash", oid));
  fs.writeFileSync(path.join(dataDir, "trash", oid, "meta.json"), JSON.stringify({ v: 1, id: oid, kind: "orphan", state: "done", deletedAt: 1759500000000, deletedBy: "recovery", name: "servers/33333333-3333-4333-8333-333333333333.jsonl", files: [] }));
  assert.equal((await restore(admin, token, oid)).code, "trash_not_restorable");
  admin.close(); s.a.close(); s.b.close(); hub.stop();
});

test("계정 복원: 같은 uuid가 재로그인(접속 중)해 있으면 현재 이름 유지·DM만 붙고 연결 유지", async () => {
  const { hub, port, token } = await startHub();
  const s = await seed(port);
  const admin = new Client(port); await admin.ready();
  await admin.req("admin_delete_account", { token, uuid: s.A });
  const again = new Client(port); await again.ready();
  await again.req("login", { uuid: s.A, name: "A-새이름" });
  const id = (await admin.req("admin_snapshot", { token })).trash![0].id;
  const r = await restore(admin, token, id);
  assert.equal(r.ok, true);
  assert.equal(r.restored!.dmsRestored, 1);
  assert.equal((await again.req("whoami")).name, "A-새이름");
  const dms = (await again.req("list_dms")).dms!;
  assert.deepEqual(dms.map((d) => d.channelId), [s.dm]);
  assert.deepEqual((await again.req("read", { channelId: s.dm })).messages!.map((m) => m.text), ["DM 메시지"]);
  admin.close(); again.close(); s.a.close(); s.b.close(); hub.stop();
});

test("계정 복원: 상대가 없는 DM은 항목에 남고(dmLeftover), 상대 복원 뒤 다시 복원하면 붙는다", async () => {
  const { hub, port, token } = await startHub();
  const s = await seed(port);
  const admin = new Client(port); await admin.ready();
  await admin.req("admin_delete_account", { token, uuid: s.A }); // DM A-B는 A 항목으로
  await admin.req("admin_delete_account", { token, uuid: s.B });
  let [aItem, bItem] = (await admin.req("admin_snapshot", { token })).trash!;
  const r1 = await restore(admin, token, aItem.id);
  assert.equal(r1.restored!.dmsLeft, 1);
  assert.equal(r1.restored!.itemRemoved, false);
  aItem = (await admin.req("admin_snapshot", { token })).trash!.find((i) => i.id === aItem.id)!;
  assert.equal(aItem.dmLeftover, 1);
  await restore(admin, token, bItem.id);
  const r3 = await restore(admin, token, aItem.id);
  assert.equal(r3.restored!.dmsRestored, 1);
  assert.equal(r3.restored!.itemRemoved, true);
  admin.close(); s.a.close(); s.b.close(); hub.stop();
});

test("admin_empty_trash는 완료 항목을 영구 삭제하고 개수를 준다", async () => {
  const { hub, port, token } = await startHub();
  const s = await seed(port);
  const admin = new Client(port); await admin.ready();
  await admin.req("admin_delete_channel", { token, channelId: s.ch1 });
  await admin.req("admin_delete_channel", { token, channelId: s.ch2 });
  assert.equal((await admin.req("admin_empty_trash", { token })).removed, 2);
  assert.deepEqual((await admin.req("admin_snapshot", { token })).trash, []);
  admin.close(); s.a.close(); s.b.close(); hub.stop();
});

test("시작 복구: state=restoring 항목은 재기동 시 plan대로 마저 복원된다", async () => {
  const dataDir = tmp();
  let ch1 = ""; let srv = "";
  {
    const { hub, port, token } = await startHub(dataDir);
    const s = await seed(port); ch1 = s.ch1; srv = s.srv;
    const admin = new Client(port); await admin.ready();
    await admin.req("admin_delete_channel", { token, channelId: s.ch1 });
    admin.close(); s.a.close(); s.b.close(); hub.stop();
    const id = fs.readdirSync(path.join(dataDir, "trash"))[0];
    const mf = path.join(dataDir, "trash", id, "meta.json");
    const m = JSON.parse(fs.readFileSync(mf, "utf8"));
    m.state = "restoring"; m.plan = { serverName: "Main", channelNames: { [s.ch1]: "일반" } };
    fs.writeFileSync(mf, JSON.stringify(m));
  }
  const { hub, port } = await startHub(dataDir);
  const c = new Client(port); await c.ready(); await c.req("login", { uuid: "aaaaaaaa-0000-4000-8000-000000000001" });
  assert.deepEqual((await c.req("list_channels", { serverId: srv })).channels!.map((x) => x.channelId).includes(ch1), true);
  assert.deepEqual(fs.readdirSync(path.join(dataDir, "trash")), []);
  c.close(); hub.stop();
});
