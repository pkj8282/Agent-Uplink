import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionRegistry } from "./sessions.js";

test("create는 uplink-1, uplink-2로 자동 이름을 준다", () => {
  const reg = new SessionRegistry();
  assert.equal(reg.create(0).name, "uplink-1");
  assert.equal(reg.create(0).name, "uplink-2");
});

test("create의 startSeq가 세션의 초기 커서가 된다", () => {
  const reg = new SessionRegistry();
  assert.equal(reg.create(42).lastDeliveredSeq, 42);
});

test("rename은 중복 이름에 접미사를 붙인다", () => {
  const reg = new SessionRegistry();
  const a = reg.create(0);
  const b = reg.create(0);
  assert.equal(reg.rename(a, "A"), "A");
  assert.equal(reg.rename(b, "A"), "A-2");
});

test("rename은 자기 자신과는 충돌로 보지 않는다", () => {
  const reg = new SessionRegistry();
  const a = reg.create(0);
  assert.equal(reg.rename(a, "A"), "A");
  assert.equal(reg.rename(a, "A"), "A"); // 다시 같은 이름은 그대로
});

test("remove 후 list에서 사라진다", () => {
  const reg = new SessionRegistry();
  const a = reg.create(0);
  reg.rename(a, "A");
  reg.create(0);
  reg.remove(a);
  assert.deepEqual(reg.list().map((s) => s.name), ["uplink-2"]);
});
