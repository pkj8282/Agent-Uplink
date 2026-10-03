import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AccountStore } from "./accounts.js";

function tmp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), "uplink-acc-")); }

test("getOrCreate는 계정을 만들고 파일로 영속한다", () => {
  const dir = tmp();
  const s = new AccountStore({ dir });
  const a = s.getOrCreate("u1", "A");
  assert.equal(a.uuid, "u1");
  assert.equal(a.name, "A");
  assert.equal(a.inboxCursor, 0);
  assert.ok(fs.existsSync(path.join(dir, "accounts", "u1.json")));
});

test("getOrCreate는 기존 계정을 다시 만들지 않는다(멱등)", () => {
  const s = new AccountStore({ dir: tmp() });
  s.getOrCreate("u1", "A");
  const again = s.getOrCreate("u1", "무시됨");
  assert.equal(again.name, "A"); // 기존 이름 유지
});

test("setName과 setInboxCursor가 영속되고 재시작 후 복원된다", () => {
  const dir = tmp();
  const s1 = new AccountStore({ dir });
  s1.getOrCreate("u1", "A");
  s1.setName("u1", "에이");
  s1.setInboxCursor("u1", 7);
  const s2 = new AccountStore({ dir }); // 재시작
  const a = s2.get("u1")!;
  assert.equal(a.name, "에이");
  assert.equal(a.inboxCursor, 7);
});

test("list와 allUuids가 모든 계정을 반환한다", () => {
  const s = new AccountStore({ dir: tmp() });
  s.getOrCreate("u1", "A");
  s.getOrCreate("u2", "B");
  assert.deepEqual(s.allUuids().sort(), ["u1", "u2"]);
  assert.deepEqual(s.list().map((x) => x.name).sort(), ["A", "B"]);
});

test("setDm은 역색인을 계정 파일에 기록하고 재시작 후 복원된다", () => {
  const dir = tmp();
  const s = new AccountStore({ dir });
  s.getOrCreate("u1", "A");
  s.setDm("u1", "u2", "dmX");
  const s2 = new AccountStore({ dir });
  assert.equal(s2.get("u1")!.dm["u2"], "dmX");
});

test("remove는 계정을 메모리와 파일에서 지운다", () => {
  const dir = tmp();
  const s = new AccountStore({ dir });
  s.getOrCreate("u1", "A");
  assert.equal(s.remove("u1"), true);
  assert.equal(s.get("u1"), undefined);
  assert.equal(fs.existsSync(path.join(dir, "accounts", "u1.json")), false);
  assert.equal(s.remove("u1"), false); // 이미 없음
});

test("removeDm은 역색인에서 peer만 지운다", () => {
  const s = new AccountStore({ dir: tmp() });
  s.getOrCreate("u1", "A");
  s.setDm("u1", "u2", "c2");
  s.setDm("u1", "u3", "c3");
  s.removeDm("u1", "u2");
  assert.equal(s.get("u1")!.dm["u2"], undefined);
  assert.equal(s.get("u1")!.dm["u3"], "c3");
});
