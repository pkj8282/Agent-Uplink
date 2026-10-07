import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineCatalog, effectiveLang, parseLanguage, t } from "./i18n.js";
import { currentLang, readLanguage } from "./langConfig.js";

test("parseLanguage는 ko/en만 받고 나머지는 N/A", () => {
  assert.equal(parseLanguage("ko"), "ko");
  assert.equal(parseLanguage("en"), "en");
  for (const v of ["N/A", "KO", "", "fr", 1, null, undefined, {}, ["ko"], "ko".repeat(1000)]) assert.equal(parseLanguage(v), "N/A");
});

test("effectiveLang: ko만 한국어", () => {
  assert.equal(effectiveLang("ko"), "ko");
  assert.equal(effectiveLang("en"), "en");
  assert.equal(effectiveLang("N/A"), "en");
});

test("t: 문자열과 params 함수", () => {
  const c = defineCatalog({
    ko: { hi: "안녕", port: (p: { port: number }) => `포트 ${p.port}` },
    en: { hi: "hi", port: (p: { port: number }) => `port ${p.port}` },
  });
  assert.equal(t(c, "ko", "hi"), "안녕");
  assert.equal(t(c, "en", "port", { port: 5 }), "port 5");
});

function tmpDir(): string { return fs.mkdtempSync(path.join(os.tmpdir(), "uplink-lang-")); }

test("readLanguage: 파일 없음·깨짐·이상한 값 → N/A, 값이 바뀌면 바로 반영", () => {
  const d = tmpDir();
  assert.equal(readLanguage(d), "N/A");
  fs.writeFileSync(path.join(d, "config.json"), "{not json");
  assert.equal(readLanguage(d), "N/A");
  fs.writeFileSync(path.join(d, "config.json"), JSON.stringify({ language: { x: 1 } }));
  assert.equal(readLanguage(d), "N/A");
  fs.writeFileSync(path.join(d, "config.json"), JSON.stringify({ language: "ko" }));
  assert.equal(readLanguage(d), "ko");
  assert.equal(currentLang(d), "ko");
  fs.writeFileSync(path.join(d, "config.json"), JSON.stringify({ language: "en" }));
  assert.equal(readLanguage(d), "en");
});

test("readLanguage: config.json이 디렉터리거나 너무 크면 N/A", () => {
  const d = tmpDir();
  fs.mkdirSync(path.join(d, "config.json"));
  assert.equal(readLanguage(d), "N/A");
  const d2 = tmpDir();
  fs.writeFileSync(path.join(d2, "config.json"), JSON.stringify({ language: "ko", pad: "x".repeat(70 * 1024) }));
  assert.equal(readLanguage(d2), "N/A");
});
