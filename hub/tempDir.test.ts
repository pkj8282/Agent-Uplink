// 테스트 임시 폴더 위생: 테스트는 tempDir()로만 임시 폴더를 만들고, 프로세스가 끝나면 지워진다.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIRS = ["hub", "mcp", "cli", "shared", "admin/src"];
const HELPER = "hub/testing.ts";

function testFiles(): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) { if (e.name !== "node_modules" && e.name !== "dist" && e.name !== "release") walk(r); continue; }
      if (e.name.endsWith(".test.ts") || r === HELPER) out.push(r);
    }
  };
  DIRS.forEach(walk);
  return out.sort();
}

/** mkdtemp/mkdtempSync 호출 위치(file:line). 도우미 파일에서는 tempDir 함수 안의 호출만 허용한다. */
function directMkdtemp(rel: string): string[] {
  const text = fs.readFileSync(path.join(root, rel), "utf8");
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.ES2022, true);
  const hits: string[] = [];
  const visit = (n: ts.Node, inHelper: boolean) => {
    const helperHere = inHelper || (ts.isFunctionDeclaration(n) && n.name?.text === "tempDir" && rel === HELPER);
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      const name = ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isIdentifier(callee) ? callee.text : "";
      if ((name === "mkdtempSync" || name === "mkdtemp") && !helperHere) {
        hits.push(`${rel}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`);
      }
    }
    ts.forEachChild(n, (c) => visit(c, helperHere));
  };
  visit(sf, false);
  return hits;
}

test("테스트는 임시 폴더를 tempDir()로만 만든다(mkdtemp 직접 호출 금지 — 정리가 빠진다)", () => {
  assert.deepEqual(testFiles().flatMap(directMkdtemp), []);
});

test("tempDir()로 만든 폴더는 테스트 프로세스가 끝나면(--test-force-exit의 process.exit 포함) 지워진다", () => {
  const helperUrl = pathToFileURL(path.join(root, HELPER)).href;
  const script = [
    `const { tempDir } = await import(${JSON.stringify(helperUrl)});`,
    `const d = tempDir("uplink-hygiene-");`,
    `const fs = await import("node:fs");`,
    `fs.mkdirSync(d + "/nested/deeper", { recursive: true });`,
    `fs.writeFileSync(d + "/nested/deeper/file.txt", "x");`,
    `console.log(d);`,
    `process.exit(0);`,
  ].join("\n");
  const r = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { cwd: root, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const dir = r.stdout.trim().split(/\r?\n/).pop()!;
  assert.match(path.basename(dir), /^uplink-hygiene-/);
  assert.equal(fs.existsSync(dir), false, `남은 폴더: ${dir}`);
});
