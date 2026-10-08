import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { readClientKey, clientKeyPath, resolveDataDir } from "./clientKey.js";
import { tempDir } from "../hub/testing.js";

/** 데이터 폴더(언어 기본 ko — 기존 한국어 안내 단정을 유지한다). */
function tmp(language: "ko" | "en" = "ko"): string {
  const d = tempDir("uplink-ck-");
  fs.writeFileSync(path.join(d, "config.json"), JSON.stringify({ language }));
  return d;
}

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

test("오류 안내는 데이터 폴더의 언어를 따른다(en)", () => {
  const d = tmp("en");
  assert.throws(() => readClientKey(d), (e: Error) => e.message.startsWith("Cannot read client.key") && e.message.includes("restarting the hub"));
  fs.writeFileSync(clientKeyPath(d), "not-a-key");
  assert.throws(() => readClientKey(d), /malformed/);
});

test("resolveDataDir는 UPLINK_DATA_DIR 우선, 없으면 PROGRAMDATA/AgentUplink", () => {
  assert.equal(resolveDataDir({ UPLINK_DATA_DIR: "X:/d" }), "X:/d");
  assert.equal(resolveDataDir({ PROGRAMDATA: "C:/PD" }), path.join("C:/PD", "AgentUplink"));
});
