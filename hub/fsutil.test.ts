import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeFileAtomic } from "./fsutil.js";

function tmp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), "uplink-fs-")); }

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
