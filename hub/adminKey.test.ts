import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyAdminToken } from "./adminKey.js";

// admin.key 생성·재사용은 secure.test.ts에서 검증한다.
test("verifyAdminToken은 일치/불일치/비문자열/길이불일치를 구분한다", () => {
  const key = "a".repeat(64);
  assert.equal(verifyAdminToken(key, "a".repeat(64)), true);
  assert.equal(verifyAdminToken(key, "b".repeat(64)), false);
  assert.equal(verifyAdminToken(key, "a".repeat(10)), false); // 길이 불일치
  assert.equal(verifyAdminToken(key, 123), false); // 비문자열
  assert.equal(verifyAdminToken(key, undefined), false);
});
