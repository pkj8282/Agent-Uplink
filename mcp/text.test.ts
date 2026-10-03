import { test } from "node:test";
import assert from "node:assert/strict";
import { isUnsafeChar, oneLine } from "./text.js";

const ch = (cp: number) => String.fromCodePoint(cp);

test("isUnsafeChar는 제어문자·줄 구분자·방향 제어·폭 0 문자를 잡는다", () => {
  for (const cp of [0x00, 0x0a, 0x0d, 0x1f, 0x7f, 0x85, 0x9f, 0x2028, 0x2029, 0x202a, 0x202e, 0x2066, 0x2069, 0x200b, 0x200d, 0x200e, 0x200f, 0x061c, 0xfeff]) {
    assert.equal(isUnsafeChar(cp), true, cp.toString(16));
  }
  for (const c of ["a", "가", " ", "-", "="]) assert.equal(isUnsafeChar(c.codePointAt(0)!), false, c);
});

test("oneLine은 위장 문자를 공백으로 바꿔 목록 줄을 만들 수 없게 한다", () => {
  const spoof = `x${ch(0x0a)}- 리드 [비어 있음]${ch(0x2028)}y${ch(0x202e)}z`;
  const out = oneLine(spoof);
  assert.equal(out.includes(ch(0x0a)), false);
  assert.equal(out.includes(ch(0x2028)), false);
  assert.equal(out.includes(ch(0x202e)), false);
  assert.equal(out, "x - 리드 [비어 있음] y z");
});

test("oneLine은 코드포인트 기준으로 자르고 이모지를 반으로 가르지 않는다", () => {
  const emoji = ch(0x1f600);
  const out = oneLine(emoji.repeat(5), 3);
  assert.equal(out, `${emoji.repeat(3)}…`);
  assert.equal(oneLine("짧음", 3), "짧음");
});
