import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { TrashStore, isTrashId, isTrashFileName, parseAccountRecord } from "./trash.js";
import { backupCorrupt } from "./fsutil.js";
import { tempDir } from "./testing.js";

function tmp(): string { return tempDir("uplink-trash-"); }
const U1 = "11111111-1111-4111-8111-111111111111";
const S1 = "22222222-2222-4222-8222-222222222222";

test("isTrashId/isTrashFileName은 형식만 통과시킨다(경로 조작 차단)", () => {
  assert.equal(isTrashId("1759500000000-channel-0a1b2c3d"), true);
  for (const bad of ["..", "../x", "1759500000000-channel-0a1b2c3d/..", "x", 5, null, "1759500000000-other-0a1b2c3d"]) {
    assert.equal(isTrashId(bad), false, String(bad));
  }
  assert.equal(isTrashFileName(`${U1}.jsonl`), true);
  assert.equal(isTrashFileName("account.json"), true);
  for (const bad of ["../a.jsonl", "meta.json", `..${path.sep}${U1}.jsonl`, `${U1}.jsonl.bak`, "C:x.jsonl"]) {
    assert.equal(isTrashFileName(bad), false, bad);
  }
});

test("create → moveIn → done 이면 목록에 intact·restorable·크기로 보인다", () => {
  const dir = tmp();
  const t = new TrashStore({ dir });
  const src = path.join(dir, "servers", `${U1}.jsonl`);
  fs.mkdirSync(path.dirname(src), { recursive: true });
  fs.writeFileSync(src, "abc\n");
  const m = t.create("channel", { deletedBy: "admin", name: "일반", serverId: S1, serverName: "Main", channels: [{ id: U1, name: "일반" }] }, 1759500000000);
  assert.equal(m.state, "deleting");
  assert.equal(t.moveIn(m.id, src, `${U1}.jsonl`), true);
  assert.equal(fs.existsSync(src), false);
  assert.equal(t.moveIn(m.id, src, `${U1}.jsonl`), true); // 멱등: 이미 옮겨짐
  m.files.push(`${U1}.jsonl`); m.state = "done"; t.writeMeta(m);
  const [it] = t.list();
  assert.deepEqual(
    { id: it.id, kind: it.kind, name: it.name, serverName: it.serverName, bytes: it.bytes, fileCount: it.fileCount, intact: it.intact, restorable: it.restorable },
    { id: m.id, kind: "channel", name: "일반", serverName: "Main", bytes: 4, fileCount: 1, intact: true, restorable: true },
  );
});

test("파일이 탐색기로 지워지면 intact=false, orphan은 restorable=false", () => {
  const dir = tmp();
  const t = new TrashStore({ dir });
  const m = t.create("server", { deletedBy: "admin", name: "S", serverId: S1, serverName: "S", channels: [] });
  t.writeFile(m.id, `${U1}.jsonl`, "x\n"); m.files.push(`${U1}.jsonl`); m.state = "done"; t.writeMeta(m);
  fs.rmSync(path.join(t.dir, m.id, `${U1}.jsonl`));
  assert.equal(t.list()[0].intact, false);
  const o = t.create("orphan", { deletedBy: "recovery", name: `servers/${U1}.jsonl` }); o.state = "done"; t.writeMeta(o);
  assert.equal(t.list().find((i) => i.id === o.id)!.restorable, false);
});

test("메타 손상·형식 밖 폴더: 목록은 크래시 없이 손상 표시/제외, 비우기는 형식 밖을 건드리지 않음", () => {
  const dir = tmp();
  const t = new TrashStore({ dir });
  const m = t.create("channel", { deletedBy: "admin", name: "c" }); m.state = "done"; t.writeMeta(m);
  fs.writeFileSync(path.join(t.dir, m.id, "meta.json"), "{깨짐");
  fs.mkdirSync(path.join(t.dir, "내가-만든-폴더"));
  fs.writeFileSync(path.join(t.dir, "메모.txt"), "x");
  const list = t.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].intact, false);
  assert.equal(t.empty(), 1);
  assert.equal(fs.existsSync(path.join(t.dir, "내가-만든-폴더")), true);
  assert.equal(fs.existsSync(path.join(t.dir, "메모.txt")), true);
});

test("RT6: meta.files에 경로 조작 이름이 있으면 meta를 거부(null)한다", () => {
  const dir = tmp();
  const t = new TrashStore({ dir });
  const m = t.create("channel", { deletedBy: "admin", name: "c" });
  const evil = { ...m, state: "done", files: ["../../outside.jsonl"] };
  fs.writeFileSync(path.join(t.dir, m.id, "meta.json"), JSON.stringify(evil));
  assert.equal(t.readMeta(m.id), null);
});

test("RT6: 항목 폴더가 junction이면 따라가지 않는다(itemDir null, 비우기에서 대상 보존)", () => {
  const dir = tmp();
  const t = new TrashStore({ dir });
  const victim = tempDir("uplink-victim-");
  fs.writeFileSync(path.join(victim, "소중한.txt"), "keep");
  const id = "1759500000000-channel-deadbeef";
  fs.symlinkSync(victim, path.join(t.dir, id), "junction");
  assert.equal(t.itemDir(id), null);
  t.empty();
  assert.equal(fs.readFileSync(path.join(victim, "소중한.txt"), "utf8"), "keep");
});

test("deleting/restoring 상태 항목은 비우기에서 건너뛴다", () => {
  const dir = tmp();
  const t = new TrashStore({ dir });
  t.create("channel", { deletedBy: "admin", name: "진행중", serverId: S1, serverName: "S", channels: [] }); // state=deleting
  assert.equal(t.empty(), 0);
  assert.equal(t.list().length, 1);
});

test("backupCorrupt는 손상 파일을 .corrupt-<ms>로 옮겨 보존한다", () => {
  const dir = tmp();
  const f = path.join(dir, "index.json");
  fs.writeFileSync(f, "{깨짐");
  const b = backupCorrupt(f, 123);
  assert.equal(b, `${f}.corrupt-123`);
  assert.equal(fs.existsSync(f), false);
  assert.equal(fs.readFileSync(b!, "utf8"), "{깨짐");
});

test("parseAccountRecord: 이름·설명의 위장 문자는 이스케이프(v2.1.2 휴지통 입구)", () => {
  const LF = String.fromCharCode(10), B = String.fromCharCode(92);
  const r = parseAccountRecord(JSON.stringify({ uuid: "u1", name: `A${LF}x`, createdAt: 1, description: `d${String.fromCodePoint(0x202e)}` }));
  assert.deepEqual(r, { uuid: "u1", name: `A${B}nx`, createdAt: 1, description: `d${B}u{202E}` });
});
