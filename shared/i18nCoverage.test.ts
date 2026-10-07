// 번역 누락 검사: 문구표(messages.ts)·테스트 밖의 문자열 리터럴에 한글이 있으면 실패한다.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { hasHangul } from "../hub/testing.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const DIRS = ["hub", "mcp", "cli", "shared", "admin/src"];
const EXCLUDE = new Set(["hub/testing.ts", "hub/messages.ts", "mcp/messages.ts", "mcp/tools.ts", "cli/messages.ts", "shared/messages.ts", "admin/src/messages.ts"]);

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) { if (e.name !== "node_modules" && e.name !== "dist" && e.name !== "release") walk(r); continue; }
      if (!/\.(ts|cts)$/.test(e.name) || e.name.endsWith(".test.ts") || EXCLUDE.has(r)) continue;
      out.push(r);
    }
  };
  DIRS.forEach(walk);
  return out.sort();
}

/** 문자열·템플릿 리터럴 안의 한글 위치(file:line). 주석은 리터럴이 아니므로 걸리지 않는다. */
function hangulLiterals(rel: string): string[] {
  const text = fs.readFileSync(path.join(root, rel), "utf8");
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.ES2022, true);
  const hits: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) {
      if (hasHangul(n.text)) hits.push(`${rel}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return hits;
}

// 아직 변환하지 않은 파일. 각 Task가 자기 파일을 지운다 — 최종에는 비어 있어야 한다.
const PENDING = new Set<string>([
  "admin/src/adminClient.ts", "admin/src/auth.ts", "admin/src/main.ts",
  "admin/src/renderer/renderer.ts", "admin/src/renderer/view.ts",
  "cli/viewer.ts", "cli/viewerCore.ts",
]);
const PENDING_HTML = new Set<string>(["admin/src/renderer/index.html"]);

test("변환된 파일의 문자열 리터럴에 한글이 없다", () => {
  const offenders = sourceFiles().filter((f) => !PENDING.has(f)).flatMap(hangulLiterals);
  assert.deepEqual(offenders, []);
});

test("PENDING 목록은 정직하다(이미 깨끗한 파일은 목록에서 지운다)", () => {
  const clean = [...PENDING].filter((f) => hangulLiterals(f).length === 0);
  assert.deepEqual(clean, []);
});

test("관리 앱 index.html에 한글이 없다", () => {
  for (const f of ["admin/src/renderer/index.html"]) {
    if (PENDING_HTML.has(f)) continue;
    assert.equal(hasHangul(fs.readFileSync(path.join(root, f), "utf8")), false, f);
  }
});

test("Hub의 ok:false 응답 객체에는 모두 code가 있다", () => {
  const offenders: string[] = [];
  for (const rel of ["hub/server.ts", "hub/trashOps.ts"]) {
    const text = fs.readFileSync(path.join(root, rel), "utf8");
    const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.ES2022, true);
    const visit = (n: ts.Node) => {
      if (ts.isObjectLiteralExpression(n)) {
        const okFalse = n.properties.some((p) => ts.isPropertyAssignment(p) && p.name.getText(sf) === "ok" && p.initializer.kind === ts.SyntaxKind.FalseKeyword);
        const hasCode = n.properties.some((p) => ts.isSpreadAssignment(p) || (p.name !== undefined && p.name.getText(sf) === "code"));
        if (okFalse && !hasCode) offenders.push(`${rel}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  assert.deepEqual(offenders, []);
});
