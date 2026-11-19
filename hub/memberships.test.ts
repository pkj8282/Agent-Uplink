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
  assert.equal(raw.v, 2);
});

test("remove_and_restore_server_account: 서버·계정을 빼면 뺀 목록을 돌려주고, 되살리면 다시 들어간다", () => {
  const { s } = store();
  s.join("A", "a"); s.join("A", "b"); s.join("B", "a");
  assert.deepEqual(s.removeServer("A"), { members: ["a", "b"], history: ["a", "b"] });
  assert.equal(s.hasServer("A"), false);
  assert.deepEqual(s.removeAccount("a"), { servers: ["B"], history: ["B"] });
  assert.deepEqual(s.membersOf("B"), []);
  s.restoreServer("A", ["a", "b"], ["a", "b"]);
  s.restoreAccount("a", ["B"], ["B"]);
  assert.deepEqual(s.membersOf("A"), ["a", "b"]);
  assert.deepEqual(s.membersOf("B"), ["a"]);
  assert.deepEqual(s.serversOf("a"), ["A", "B"]);
  assert.deepEqual(s.removeServer("없음"), { members: [], history: [] });
  assert.deepEqual(s.removeAccount("없음"), { servers: [], history: [] });
});

test("corrupt_file_moved_and_fresh: 손상된 파일은 옆으로 옮기고 빈 목록으로 새로 시작(→ 기록으로 다시 채움)", () => {
  for (const bad of ["{ not json", JSON.stringify({ v: 1, servers: { A: "a" } }), JSON.stringify({ v: 2, servers: {} }), JSON.stringify([])]) {
    const dir = tempDir("uplink-mem-");
    fs.writeFileSync(path.join(dir, "memberships.json"), bad);
    const s = new MembershipStore({ dataDir: dir });
    assert.equal(s.fresh, true, bad);
    assert.deepEqual(s.all(), {});
    assert.ok(fs.readdirSync(dir).some((f) => f.startsWith("memberships.json.corrupt-")), bad);
  }
});

test("seed_and_sync_drops_ghosts_adds_new: 처음 채우기와 동기화(없는 서버·계정 삭제, 새 서버 빈 줄)", () => {
  const { s } = store();
  s.seed({ A: ["a", "ghost"], GONE: ["a"], B: [] });
  const r = s.sync({ servers: ["A", "B", "NEW"], accounts: ["a", "b"] });
  assert.deepEqual(r, { removedServers: 1, removedMembers: 1, addedServers: 1, repaired: 0 });
  assert.deepEqual(s.all(), { A: ["a"], B: [], NEW: [] });
  assert.deepEqual(s.historyOf("A"), ["a"], "유령 계정은 전적에서도 지움");
  assert.deepEqual(s.sync({ servers: ["A", "B", "NEW"], accounts: ["a", "b"] }), { removedServers: 0, removedMembers: 0, addedServers: 0, repaired: 0 });
});

// ───── 사용자 설계 추가: 참가 전적·두 관점 저장·동기화 합집합 ─────
const raw = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, "memberships.json"), "utf8"));

test("history_keeps_left_members: 나가도 참가 전적에는 남는다", () => {
  const { s } = store();
  s.join("A", "a"); s.join("A", "b"); s.leave("A", "a");
  assert.deepEqual(s.membersOf("A"), ["b"]);
  assert.deepEqual(s.historyOf("A"), ["a", "b"]);
  assert.deepEqual(s.history(), { A: ["a", "b"] });
});

test("stores_both_views_in_one_file: 서버 관점(현재·전적)과 참가자 관점을 한 파일에 함께 저장", () => {
  const { dir, s } = store();
  s.join("A", "a"); s.join("B", "a"); s.leave("B", "a");
  const j = raw(dir);
  assert.equal(j.v, 2);
  assert.deepEqual(j.servers.A, { members: ["a"], history: ["a"] });
  assert.deepEqual(j.servers.B, { members: [], history: ["a"] });
  assert.deepEqual(j.accounts, { a: ["A"] });
});

test("sync_union_when_views_disagree: 서버 관점과 참가자 관점이 다르면 참가로 판정해 양쪽을 맞춘다", () => {
  const dir = tempDir("uplink-mem-");
  fs.writeFileSync(path.join(dir, "memberships.json"), JSON.stringify({ v: 2, servers: { A: { members: ["a"], history: ["a"] }, B: { members: [], history: [] } }, accounts: { a: ["B"], b: ["A"] } }));
  const s = new MembershipStore({ dataDir: dir });
  const r = s.sync({ servers: ["A", "B"], accounts: ["a", "b"] });
  assert.equal(r.repaired, 3, "A의 a(계정 쪽 없음), B의 a(서버 쪽 없음), A의 b(서버 쪽 없음)");
  assert.deepEqual(s.membersOf("A").sort(), ["a", "b"]);
  assert.deepEqual(s.membersOf("B"), ["a"]);
  assert.deepEqual(s.serversOf("a").sort(), ["A", "B"]);
  assert.deepEqual(s.historyOf("A").sort(), ["a", "b"], "맞춘 참가자는 전적에도");
  const acc = raw(dir).accounts; assert.deepEqual([acc.a.sort(), acc.b], [["A", "B"], ["A"]]);
});

test("sync_never_rejoins_from_history: 동기화는 참가 전적만 보고 다시 참가시키지 않는다(나간 계정은 그대로)", () => {
  const { s } = store();
  s.join("A", "a"); s.leave("A", "a");
  const r = s.sync({ servers: ["A"], accounts: ["a"] });
  assert.equal(r.repaired, 0);
  assert.deepEqual(s.membersOf("A"), []);
  assert.deepEqual(s.serversOf("a"), []);
  assert.deepEqual(s.historyOf("A"), ["a"]);
});

test("v1_file_upgraded: 옛 v1 파일(서버 → 목록)은 읽어서 v2로(전적 = 현재 참가자)", () => {
  const dir = tempDir("uplink-mem-");
  fs.writeFileSync(path.join(dir, "memberships.json"), JSON.stringify({ v: 1, servers: { A: ["a", "b"] } }));
  const s = new MembershipStore({ dataDir: dir });
  assert.equal(s.fresh, false);
  assert.deepEqual(s.membersOf("A"), ["a", "b"]);
  assert.deepEqual(s.historyOf("A"), ["a", "b"]);
  assert.deepEqual(s.serversOf("b"), ["A"]);
});

test("seed_fills_history: 처음 채우기(글 쓴 계정)는 전적에도 들어간다", () => {
  const { s } = store();
  s.seed({ A: ["a"] });
  assert.deepEqual(s.historyOf("A"), ["a"]);
  assert.deepEqual(s.serversOf("a"), ["A"]);
});

// ───── 최종 리뷰 Important 1·2: 읽기 오류·저장 실패 ─────
test("read_error_not_treated_as_missing: 없는 게 아닌 읽기 오류면 새로 채우지 않고 저장도 막는다(정상 파일 덮어쓰기 방지)", () => {
  const dir = tempDir("uplink-mem-");
  fs.mkdirSync(path.join(dir, "memberships.json")); // 읽으면 EISDIR(ENOENT 아님)
  const s = new MembershipStore({ dataDir: dir });
  assert.equal(s.fresh, false, "기록으로 다시 채우면 안 됨");
  assert.equal(s.saveBlocked, true);
  assert.doesNotThrow(() => s.join("A", "a"));
  assert.equal(fs.statSync(path.join(dir, "memberships.json")).isDirectory(), true, "그대로 둠");
});

test("save_failure_does_not_throw: 저장이 실패해도 던지지 않고 메모리 상태는 유지", () => {
  const { dir, s } = store();
  fs.mkdirSync(path.join(dir, "memberships.json")); // 이제 쓰기가 실패한다
  assert.doesNotThrow(() => s.join("A", "a"));
  assert.equal(s.isMember("A", "a"), true);
  assert.doesNotThrow(() => s.seed({ B: ["b"] }));
  assert.doesNotThrow(() => s.sync({ servers: ["A"], accounts: ["a"] }));
});

test("corrupt_backup_failure_blocks_save: 손상 파일을 옆으로 옮기지 못하면 덮어쓰지 않는다", () => {
  const dir = tempDir("uplink-mem-");
  const f = path.join(dir, "memberships.json");
  fs.writeFileSync(f, "{ broken");
  const s = new MembershipStore({ dataDir: dir, backup: () => null });
  assert.equal(s.fresh, true);
  assert.equal(s.saveBlocked, true);
  s.join("A", "a");
  assert.equal(fs.readFileSync(f, "utf8"), "{ broken", "원본(증거) 보존");
});
