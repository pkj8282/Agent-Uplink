import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const css = fs.readFileSync(path.join(here, "styles.css"), "utf8");
const html = fs.readFileSync(path.join(here, "index.html"), "utf8");

test("hidden은 어떤 display 규칙보다 우선한다(.form·label의 display가 숨김을 덮어 저장소 입력칸이 다 보이던 문제)", () => {
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important;?\s*\}/);
});

test("저장소 종류별 폼: Supabase 폼은 처음에 숨김(기본 종류 GitHub)", () => {
  assert.match(html, /<form id="supabase-form" class="form" hidden>/);
  assert.match(html, /<select id="storage-kind"><option value="github"/);
});
