import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadOrCreateAdminKey, verifyAdminToken } from "./adminKey.js";

function tmp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), "uplink-adk-")); }

test("없으면 생성하고(64 hex) 파일에 저장, 있으면 재사용한다", () => {
  const dir = tmp();
  const k1 = loadOrCreateAdminKey(dir);
  assert.match(k1, /^[0-9a-f]{64}$/); // 32바이트 hex
  assert.ok(fs.existsSync(path.join(dir, "admin.key")));
  const k2 = loadOrCreateAdminKey(dir);
  assert.equal(k2, k1); // 재사용
});

test("verifyAdminToken은 일치/불일치/비문자열/길이불일치를 구분한다", () => {
  const key = "a".repeat(64);
  assert.equal(verifyAdminToken(key, "a".repeat(64)), true);
  assert.equal(verifyAdminToken(key, "b".repeat(64)), false);
  assert.equal(verifyAdminToken(key, "a".repeat(10)), false); // 길이 불일치
  assert.equal(verifyAdminToken(key, 123), false); // 비문자열
  assert.equal(verifyAdminToken(key, undefined), false);
});
