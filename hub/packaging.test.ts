import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("build_excludes_testkit: 망 시험 도구(testkit)는 빌드·npm 패키지에 들어가지 않는다", () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(root, "tsconfig.json"), "utf8"));
  assert.ok((cfg.exclude as string[]).includes("hub/connection/mesh/testkit.ts"));
  const tsc = path.join(root, "node_modules", "typescript", "bin", "tsc");
  const files = execFileSync(process.execPath, [tsc, "--listFilesOnly", "-p", "tsconfig.json"], { cwd: root, encoding: "utf8" });
  assert.equal(/testkit/.test(files), false);
  assert.ok(/hub[\/]connection[\/]mesh[\/]mesh\.ts/.test(files), "망 코드 자체는 빌드에 들어감");
});
