import { test } from "node:test";
import assert from "node:assert/strict";
import { escapeControls, isUnsafeChar, oneLine } from "./controlChars.js";

const B = String.fromCharCode(92);
const ch = (c: number) => String.fromCodePoint(c);

test("escapeControls: LF·CR·TAB은 백슬래시+n·r·t", () => {
  assert.equal(escapeControls(`a${ch(10)}b${ch(13)}c${ch(9)}d`), `a${B}nb${B}rc${B}td`);
});

test("escapeControls: 그 밖의 위장 문자는 백슬래시+u{대문자 16진수}", () => {
  const cases: [number, string][] = [
    [0x00, "0"], [0x07, "7"], [0x1b, "1B"], [0x7f, "7F"], [0x85, "85"], [0x9f, "9F"],
    [0x2028, "2028"], [0x2029, "2029"], [0x202a, "202A"], [0x202e, "202E"], [0x2066, "2066"], [0x2069, "2069"],
    [0x200e, "200E"], [0x200f, "200F"], [0x061c, "61C"], [0x200b, "200B"], [0x200d, "200D"], [0xfeff, "FEFF"],
  ];
  for (const [c, hex] of cases) assert.equal(escapeControls(`x${ch(c)}y`), `x${B}u{${hex}}y`, hex);
});

test("escapeControls: 일반 문자(한글·이모지·결합 문자·공백·백슬래시)는 그대로", () => {
  const s = `세션-1 ${ch(0x1f600)} e${ch(0x301)} ${B}n ~`;
  assert.equal(escapeControls(s), s);
});

test("escapeControls: 전 코드포인트에서 결과에 위장 문자가 없고, 두 번 적용해도 같다", () => {
  for (let c = 0; c <= 0x10ffff; c++) {
    if (c >= 0xd800 && c <= 0xdfff) continue;
    const once = escapeControls(ch(c));
    for (const x of once) if (isUnsafeChar(x.codePointAt(0)!)) assert.fail(`남은 위장 문자: ${c.toString(16)}`);
    if (escapeControls(once) !== once) assert.fail(`멱등 아님: ${c.toString(16)}`);
  }
});

test("oneLine: 기존 동작 유지(위장 문자 → 공백, 코드포인트 기준 자르기)", () => {
  assert.equal(oneLine(`a${ch(10)}b`, 10), "a b");
  assert.equal(oneLine("가나다라", 2), "가나…");
});
