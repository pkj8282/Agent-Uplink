import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "./config.js";

function tmp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), "uplink-cfg-")); }

test("설정이 없으면 기본값으로 생성하고 파일에 쓴다", () => {
  const dir = tmp();
  const c = loadConfig(dir);
  assert.equal(c.maxChannelsPerServer, 30);
  assert.equal(c.allowDevDelete, true);
  assert.equal(c.inboxMaxBatch, 200);
  assert.ok(fs.existsSync(path.join(dir, "config.json")));
});

test("기존 설정을 읽고 누락 키는 기본값으로 채운다", () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ maxChannelsPerServer: 5 }));
  const c = loadConfig(dir);
  assert.equal(c.maxChannelsPerServer, 5); // 사용자 값 유지
  assert.equal(c.allowDevDelete, true); // 누락 → 기본값
  assert.equal(c.inboxMaxBatch, 200);
});
