import { test } from "node:test";
import assert from "node:assert/strict";
import { nameSchema } from "./schemas.js";

test("nameSchema는 Hub와 같이 코드포인트로 센다(이모지 64개 통과, 65자 거부, 빈 값 거부)", () => {
  const s = nameSchema("서버 이름", "ko");
  const emoji = String.fromCodePoint(0x1f600).repeat(64); // UTF-16 길이 128
  assert.equal(s.safeParse(emoji).success, true);
  assert.equal(s.safeParse("a".repeat(64)).success, true);
  assert.equal(s.safeParse("a".repeat(65)).success, false);
  assert.equal(s.safeParse("").success, false);
  assert.match(s.description ?? "", /최대 64자/);
});

test("nameSchema 영어: 설명·오류 문구", () => {
  const s = nameSchema("Server name", "en");
  assert.equal(s.description, "Server name (max 64 characters)");
  const r = s.safeParse("a".repeat(65));
  assert.equal(r.success, false);
  if (!r.success) assert.equal(r.error.issues[0].message, "Server name must be at most 64 characters.");
});
