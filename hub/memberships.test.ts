import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tempDir } from "./testing.js";
import { MembershipStore } from "./memberships.js";

const store = (dir = tempDir("uplink-mem-")) => ({ dir, s: new MembershipStore({ dataDir: dir }) });

test("memberships_two_views: 서버 관점과 참가자 관점이 같은 데이터를 두 방향으로 보여 준다", () => {
  const { s } = store();
  for (const [srv, list] of [["A", ["a", "b", "c"]], ["B", ["b", "c"]], ["C", ["c"]]] as const) for (const u of list) s.join(srv, u);
  assert.deepEqual(s.membersOf("A"), ["a", "b", "c"]);
  assert.deepEqual(s.membersOf("B"), ["b", "c"]);
  assert.deepEqual(s.serversOf("c"), ["A", "B", "C"]);
  assert.deepEqual(s.serversOf("a"), ["A"]);
  assert.deepEqual(s.serversOf("nobody"), []);
  assert.equal(s.isMember("B", "a"), false);
  assert.deepEqual(s.all(), { A: ["a", "b", "c"], B: ["b", "c"], C: ["c"] });
});

test("join_leave_idempotent: 두 번 참가해도 한 번, 참가 안 한 서버에서 나가도 오류 없음", () => {
  const { s } = store();
  assert.equal(s.join("A", "a"), true);
  assert.equal(s.join("A", "a"), false);
  assert.deepEqual(s.membersOf("A"), ["a"]);
  assert.equal(s.leave("B", "a"), false);
  assert.equal(s.leave("A", "b"), false);
  assert.equal(s.leave("A", "a"), true);
  assert.deepEqual(s.membersOf("A"), []);
  assert.equal(s.hasServer("A"), true, "마지막 참가자가 나가도 서버 줄은 남는다");
});

test("persist_and_reload: 파일에 저장되고 다시 열면 그대로", () => {
  const { dir, s } = store();
  s.join("A", "a"); s.join("A", "b"); s.join("B", "b");
  assert.equal(s.fresh, true);
  const again = new MembershipStore({ dataDir: dir });
  assert.equal(again.fresh, false);
  assert.deepEqual(again.all(), { A: ["a", "b"], B: ["b"] });
  const raw = JSON.parse(fs.readFileSync(path.join(dir, "memberships.json"), "utf8"));
  assert.equal(raw.v, 1);
});

test("remove_and_restore_server_account: 서버·계정을 빼면 뺀 목록을 돌려주고, 되살리면 다시 들어간다", () => {
  const { s } = store();
  s.join("A", "a"); s.join("A", "b"); s.join("B", "a");
  assert.deepEqual(s.removeServer("A"), ["a", "b"]);
  assert.equal(s.hasServer("A"), false);
  assert.deepEqual(s.removeAccount("a"), ["B"]);
  assert.deepEqual(s.membersOf("B"), []);
  s.restoreServer("A", ["a", "b"]);
  s.restoreAccount("a", ["B"]);
  assert.deepEqual(s.membersOf("A"), ["a", "b"]);
  assert.deepEqual(s.membersOf("B"), ["a"]);
  assert.deepEqual(s.removeServer("없음"), []);
  assert.deepEqual(s.removeAccount("없음"), []);
});

test("corrupt_file_moved_and_fresh: 손상된 파일은 옆으로 옮기고 빈 목록으로 새로 시작(→ 기록으로 다시 채움)", () => {
  for (const bad of ["{ not json", JSON.stringify({ v: 1, servers: { A: "a" } }), JSON.stringify({ v: 2, servers: {} }), JSON.stringify([])]) {
    const dir = tempDir("uplink-mem-");
    fs.writeFileSync(path.join(dir, "memberships.json"), bad);
    const s = new MembershipStore({ dataDir: dir });
    assert.equal(s.fresh, true, bad);
    assert.deepEqual(s.all(), {});
    assert.ok(fs.readdirSync(dir).some((f) => f.startsWith("memberships.json.bad-")), bad);
  }
});

test("seed_and_sync_drops_ghosts_adds_new: 처음 채우기와 동기화(없는 서버·계정 삭제, 새 서버 빈 줄)", () => {
  const { s } = store();
  s.seed({ A: ["a", "ghost"], GONE: ["a"], B: [] });
  const r = s.sync({ servers: ["A", "B", "NEW"], accounts: ["a", "b"] });
  assert.deepEqual(r, { removedServers: 1, removedMembers: 1, addedServers: 1 });
  assert.deepEqual(s.all(), { A: ["a"], B: [], NEW: [] });
  assert.deepEqual(s.sync({ servers: ["A", "B", "NEW"], accounts: ["a", "b"] }), { removedServers: 0, removedMembers: 0, addedServers: 0 });
});
