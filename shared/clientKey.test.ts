import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readClientKey, clientKeyPath, resolveDataDir } from "./clientKey.js";

function tmp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), "uplink-ck-")); }

test("client.key를 앞뒤 공백 없이 읽는다", () => {
  const d = tmp();
  fs.writeFileSync(clientKeyPath(d), ` ${"c".repeat(64)}\n`);
  assert.equal(readClientKey(d), "c".repeat(64));
});

test("없으면 경로와 재시작 안내를 담아 던진다", () => {
  const d = tmp();
  assert.throws(() => readClientKey(d), (e: Error) => e.message.includes("client.key를 읽을 수 없습니다") && e.message.includes("Hub를 재시작"));
});

test("형식이 틀리면 형식 오류로 던진다", () => {
  const d = tmp();
  fs.writeFileSync(clientKeyPath(d), "not-a-key");
  assert.throws(() => readClientKey(d), /형식 오류/);
});

test("resolveDataDir는 UPLINK_DATA_DIR 우선, 없으면 PROGRAMDATA/AgentUplink", () => {
  assert.equal(resolveDataDir({ UPLINK_DATA_DIR: "X:/d" }), "X:/d");
  assert.equal(resolveDataDir({ PROGRAMDATA: "C:/PD" }), path.join("C:/PD", "AgentUplink"));
});
