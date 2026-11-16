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

test("렌더러가 만드는 label은 클래스를 단다(.form label은 grid라 체크 박스와 이름이 위아래로 갈라짐 — 5단계 망 공유 목록)", () => {
  const src = fs.readFileSync(path.join(here, "renderer.ts"), "utf8");
  assert.equal(/el\("label"\)/.test(src), false);
});

test("refresh_button_has_aria_label_and_tip: 새로고침은 아이콘 버튼 + 화면 읽기용 이름 + 포인터 툴팁", () => {
  assert.match(html, /<button id="refresh" type="button" class="icon"[^>]*data-i18n-aria="btn_refresh"[^>]*data-tip="btn_refresh"/);
  assert.match(html, /<div id="tip" class="tip" role="tooltip" hidden><\/div>/);
  assert.match(css, /\.tip\s*\{[^}]*position:\s*fixed/);
  assert.match(css, /\.tip\s*\{[^}]*pointer-events:\s*none/);
});

test("hubdown_block_centered: Hub 꺼짐 화면은 가운데 문구+시작 버튼, 그때 왼쪽 목록·본문은 숨김", () => {
  assert.match(html, /<div id="hubdown" class="hubdown">[\s\S]*id="hub-start"/);
  assert.match(css, /\.hubdown\s*\{[^}]*place-content:\s*center/);
  assert.match(css, /body:not\(\[data-state="hubdown"\]\)\s+\.hubdown\s*\{\s*display:\s*none/);
  assert.match(css, /body\[data-state="hubdown"\]\s+\.side,\s*body\[data-state="hubdown"\]\s+main\s*\{\s*display:\s*none/);
});
