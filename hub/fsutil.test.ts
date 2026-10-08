import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic, writeSecretFile } from "./fsutil.js";
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
