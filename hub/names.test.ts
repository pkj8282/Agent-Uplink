import { test } from "node:test";
import assert from "node:assert/strict";
import { nameKey, uniqueName } from "./names.js";

test("nameKey는 앞뒤 공백·대소문자를 무시한다", () => {
  assert.equal(nameKey("  Main "), "main");
  assert.equal(nameKey("기획"), "기획");
});

test("uniqueName: 겹치지 않으면 그대로", () => {
  assert.equal(uniqueName("기획", ["구현", "QA"]), "기획");
});

test("uniqueName: 겹치는 이름 개수+1", () => {
  assert.equal(uniqueName("기획", ["기획"]), "기획 (2)");
  assert.equal(uniqueName("기획", ["기획", "기획 (2)"]), "기획 (3)");
  assert.equal(uniqueName("Main", ["main ", "MAIN (2)", "main (3)"]), "Main (4)");
});

test("uniqueName: 개수+1이 이미 있으면 빈 번호까지 올린다(개수만 쓰면 충돌하는 경우)", () => {
  // 겹치는 이름 2개(기획, 기획 (3)) → 후보 (3)은 이미 있음 → (4)
  assert.equal(uniqueName("기획", ["기획", "기획 (3)"]), "기획 (4)");
});

test("uniqueName: 관련 없는 이름·숫자 아닌 괄호는 세지 않는다", () => {
  assert.equal(uniqueName("기획", ["기획", "기획팀", "기획 (초안)", "기획 ()"]), "기획 (2)");
});
