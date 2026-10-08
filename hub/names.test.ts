import { test } from "node:test";
import assert from "node:assert/strict";
import { nameKey, uniqueName, validateName } from "./names.js";

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

test("validateName: 앞뒤 공백 제거, 1~64 코드포인트", () => {
  assert.deepEqual(validateName("  방  ", "channel"), { ok: true, name: "방" });
  assert.deepEqual(validateName("a".repeat(64), "server"), { ok: true, name: "a".repeat(64) });
  const emoji = String.fromCodePoint(0x1f600).repeat(64); // UTF-16으로는 128
  assert.deepEqual(validateName(emoji, "account"), { ok: true, name: emoji });
  for (const bad of ["", "   ", "a".repeat(65), 5, null, undefined]) {
    const r = validateName(bad, "server");
    assert.equal(r.ok, false, String(bad));
    // 문구는 Hub가 언어에 맞춰 만든다 — 여기서는 언어 중립 값(code·params)만 돌려준다.
    if (!r.ok) assert.deepEqual(r, { ok: false, code: "name_invalid", params: { kind: "server", max: 64 } });
  }
});

test("validateName: 위장 문자는 이스케이프, 길이는 원래 문자열 기준(v2.1.2)", () => {
  const LF = String.fromCharCode(10), B = String.fromCharCode(92);
  assert.deepEqual(validateName(`a${LF}b`, "server"), { ok: true, name: `a${B}nb` });
  assert.deepEqual(validateName(`x${LF.repeat(62)}y`, "server"), { ok: true, name: `x${`${B}n`.repeat(62)}y` }); // 원래 64
  assert.equal(validateName(`x${LF.repeat(63)}y`, "server").ok, false); // 원래 65
});
