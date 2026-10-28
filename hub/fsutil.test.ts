import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { backupCorrupt, writeFileAtomic, writeSecretFile } from "./fsutil.js";
import { tempDir } from "./testing.js";

function tmp(): string { return tempDir("uplink-fs-"); }

test("writeFileAtomic는 내용을 정확히 쓰고 임시 파일을 남기지 않는다", () => {
  const dir = tmp();
  const file = path.join(dir, "a.json");
  writeFileAtomic(file, '{"x":1}');
  assert.equal(fs.readFileSync(file, "utf8"), '{"x":1}');
  assert.equal(fs.existsSync(file + ".tmp"), false);
});

test("writeFileAtomic는 기존 파일을 완전히 교체한다", () => {
  const dir = tmp();
  const file = path.join(dir, "a.json");
  writeFileAtomic(file, "old-and-longer-content");
  writeFileAtomic(file, "new");
  assert.equal(fs.readFileSync(file, "utf8"), "new"); // 잔여 바이트 없이 완전 교체
});

test("writeSecretFile은 기존 파일을 교체하고, 고정 이름 .tmp를 쓰지 않는다", () => {
  const d = tmp();
  const f = path.join(d, "client.key");
  fs.writeFileSync(`${f}.tmp`, "attacker"); // 선점된 고정 임시 파일
  fs.writeFileSync(f, "old");
  writeSecretFile(f, "new");
  assert.equal(fs.readFileSync(f, "utf8"), "new");
  assert.equal(fs.readFileSync(`${f}.tmp`, "utf8"), "attacker"); // 건드리지 않음
  assert.deepEqual(fs.readdirSync(d).filter((n) => n.startsWith("client.key.") && n !== "client.key.tmp"), []); // 무작위 임시 파일 정리됨
});

// ── v2.1.3 RT43: 손상 파일 백업이 실패해도 원본을 잃지 않는다(설계 ⑨) ──
test("RT43: backupCorrupt는 rename이 막히면(같은 이름 폴더) 복사본 .corrupt-<ms>-<hex>로 보존하고 원본도 남긴다", () => {
  const d = tmp();
  const f = path.join(d, "index.json");
  fs.writeFileSync(f, "{broken");
  fs.mkdirSync(`${f}.corrupt-123`); // rename 대상을 막는다
  const b = backupCorrupt(f, 123);
  assert.ok(b && path.basename(b).startsWith("index.json.corrupt-123-"), String(b));
  assert.equal(fs.readFileSync(b!, "utf8"), "{broken");
  assert.equal(fs.readFileSync(f, "utf8"), "{broken");
});

test("RT43: rename·복사가 모두 실패하면 null", () => {
  const d = tmp();
  assert.equal(backupCorrupt(path.join(d, "없는파일.json"), 1), null);
});
