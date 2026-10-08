import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { readLanguageFile, writeLanguageFile } from "./langFile.js";
import { tempDir } from "../../hub/testing.js";

const tmp = () => tempDir("uplink-alang-");
const cfg = (d: string) => path.join(d, "config.json");

test("다른 키를 보존하고 language만 바꾼다(임시 파일을 남기지 않는다)", () => {
  const d = tmp();
  fs.writeFileSync(cfg(d), JSON.stringify({ maxChannelsPerServer: 7, allowDevDelete: true, inboxMaxBatch: 9, language: "N/A" }));
  writeLanguageFile(d, "ko");
  assert.deepEqual(JSON.parse(fs.readFileSync(cfg(d), "utf8")), { maxChannelsPerServer: 7, allowDevDelete: true, inboxMaxBatch: 9, language: "ko" });
  assert.equal(readLanguageFile(d), "ko");
  assert.deepEqual(fs.readdirSync(d).filter((f) => f.endsWith(".tmp")), []);
});

test("파일이 없으면 language만 담아 만든다, 깨진 JSON은 교체", () => {
  const d = tmp();
  writeLanguageFile(d, "en");
  assert.deepEqual(JSON.parse(fs.readFileSync(cfg(d), "utf8")), { language: "en" });
  fs.writeFileSync(cfg(d), "{broken");
  writeLanguageFile(d, "ko");
  assert.deepEqual(JSON.parse(fs.readFileSync(cfg(d), "utf8")), { language: "ko" });
});

test("데이터 폴더가 아직 없으면 만든다(Hub를 한 번도 실행하지 않은 첫 실행)", () => {
  const d = path.join(tmp(), "AgentUplink");
  writeLanguageFile(d, "ko");
  assert.equal(readLanguageFile(d), "ko");
});

test("config.json이 디렉터리면 거부하고 건드리지 않는다", () => {
  const d = tmp();
  fs.mkdirSync(cfg(d));
  assert.throws(() => writeLanguageFile(d, "ko"));
  assert.ok(fs.statSync(cfg(d)).isDirectory());
});

test("config.json이 심볼릭 링크면 거부하고 링크 대상은 그대로(만들 수 있는 환경에서만)", (t) => {
  const d = tmp();
  const target = path.join(tmp(), "victim.json");
  fs.writeFileSync(target, "{}");
  try { fs.symlinkSync(target, cfg(d), "file"); } catch { t.skip("심볼릭 링크를 만들 권한 없음"); return; }
  assert.throws(() => writeLanguageFile(d, "ko"));
  assert.equal(fs.readFileSync(target, "utf8"), "{}");
});

test("잘못된 lang 값은 거부(런타임 방어)", () => {
  const d = tmp();
  assert.throws(() => writeLanguageFile(d, "fr" as never));
  assert.equal(fs.existsSync(cfg(d)), false);
});

test("readLanguageFile: 없음·깨짐·이상한 값은 N/A", () => {
  const d = tmp();
  assert.equal(readLanguageFile(d), "N/A");
  fs.writeFileSync(cfg(d), JSON.stringify({ language: "<script>" }));
  assert.equal(readLanguageFile(d), "N/A");
});

test("RT23: 데이터 폴더 자체가 정션·링크면 거부하고 연결된 폴더의 config.json을 건드리지 않는다", (t) => {
  const victim = tmp();
  fs.writeFileSync(cfg(victim), JSON.stringify({ theme: "dark" }));
  const link = path.join(tmp(), "AgentUplink");
  try { fs.symlinkSync(victim, link, "junction"); } catch { t.skip("정션을 만들 수 없음"); return; }
  assert.throws(() => writeLanguageFile(link, "ko"));
  assert.deepEqual(JSON.parse(fs.readFileSync(cfg(victim), "utf8")), { theme: "dark" });
});
