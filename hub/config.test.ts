import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadConfig, saveConfig } from "./config.js";
import { tempDir } from "./testing.js";

function tmp(): string { return tempDir("uplink-cfg-"); }

test("설정이 없으면 기본값으로 생성하고 파일에 쓴다", () => {
  const dir = tmp();
  const c = loadConfig(dir);
  assert.equal(c.maxChannelsPerServer, 30);
  assert.equal(c.allowDevDelete, false); // v2.0.2부터 새 설치 기본값은 꺼짐
  assert.equal(c.inboxMaxBatch, 200);
  assert.ok(fs.existsSync(path.join(dir, "config.json")));
});

test("기존 설정을 읽고 누락 키는 기본값으로 채운다", () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ maxChannelsPerServer: 5 }));
  const c = loadConfig(dir);
  assert.equal(c.maxChannelsPerServer, 5); // 사용자 값 유지
  assert.equal(c.allowDevDelete, false); // 누락 → 기본값
  assert.equal(c.inboxMaxBatch, 200);
});

test("saveConfig는 원자적으로 저장하고 loadConfig가 읽는다", () => {
  const dir = tmp();
  saveConfig(dir, { maxChannelsPerServer: 7, allowDevDelete: false, inboxMaxBatch: 50 });
  const c = loadConfig(dir);
  assert.equal(c.maxChannelsPerServer, 7);
  assert.equal(c.allowDevDelete, false);
  assert.equal(c.inboxMaxBatch, 50);
});

test("새 설치의 allowDevDelete 기본값은 false, 기존 파일의 true는 유지", () => {
  const fresh = tmp();
  assert.equal(loadConfig(fresh).allowDevDelete, false);
  const old = tmp();
  fs.writeFileSync(path.join(old, "config.json"), JSON.stringify({ maxChannelsPerServer: 30, allowDevDelete: true, inboxMaxBatch: 200 }));
  assert.equal(loadConfig(old).allowDevDelete, true);
});

test("language 기본값은 N/A이고 파일에 채워진다", () => {
  const d = tmp();
  assert.equal(loadConfig(d).language, "N/A");
  assert.equal(JSON.parse(fs.readFileSync(path.join(d, "config.json"), "utf8")).language, "N/A");
});

test("파일에 language만 있어도 보존된다(관리 앱이 Hub 꺼진 채 저장한 경우)", () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, "config.json"), JSON.stringify({ language: "ko" }));
  const c = loadConfig(d);
  assert.equal(c.language, "ko");
  assert.equal(c.maxChannelsPerServer, 30);
  assert.equal(JSON.parse(fs.readFileSync(path.join(d, "config.json"), "utf8")).language, "ko");
});

test("이상한 language 값은 N/A로 정규화", () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, "config.json"), JSON.stringify({ language: "<script>" }));
  assert.equal(loadConfig(d).language, "N/A");
  assert.equal(JSON.parse(fs.readFileSync(path.join(d, "config.json"), "utf8")).language, "N/A");
});
