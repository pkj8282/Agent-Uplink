import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NAV, panelId, isMultiView, parseNavMemory } from "./nav.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(here, "index.html"), "utf8");
const renderer = fs.readFileSync(path.join(here, "renderer.ts"), "utf8");
const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
const idSet = new Set(ids);

/** 어떤 요소(id)의 시작 태그부터 짝이 맞는 닫는 태그까지(같은 태그 이름 중첩 고려). */
function block(id: string): string {
  const start = html.search(new RegExp(`<(\\w+)[^>]*\\sid="${id}"`));
  assert.ok(start >= 0, id);
  const tag = /^<(\w+)/.exec(html.slice(start))![1];
  const re = new RegExp(`<${tag}[\\s>]|</${tag}>`, "g");
  re.lastIndex = start + 1;
  let depth = 1;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    depth += m[0].startsWith("</") ? -1 : 1;
    if (depth === 0) return html.slice(start, m.index + m[0].length);
  }
  throw new Error(`닫히지 않음: ${id}`);
}

test("nav_order_matches_design: 왼쪽 목록 순서·하위 탭이 설계와 같다", () => {
  assert.deepEqual(NAV.map((n) => [n.id, (n.subs ?? []).map((s) => s.id)]), [
    ["app", []], ["limits", []], ["servers", ["local", "multi"]], ["accounts", ["local", "multi"]],
    ["security", []], ["multi", ["comms", "space1", "mesh", "storage"]], ["trash", []], ["quarantine", []],
  ]);
});

test("every_nav_panel_exists_in_html: 왼쪽 목록 버튼·칸·하위 탭 버튼·하위 칸이 모두 있다", () => {
  for (const n of NAV) {
    assert.ok(idSet.has(panelId(n.id)), panelId(n.id));
    assert.match(html, new RegExp(`data-nav="${n.id}"`), n.id);
    for (const s of n.subs ?? []) {
      assert.ok(idSet.has(panelId(n.id, s.id)), panelId(n.id, s.id));
      assert.ok(block(panelId(n.id)).includes(`id="${panelId(n.id, s.id)}"`), `${s.id}는 ${n.id} 안`);
      assert.match(block(panelId(n.id)), new RegExp(`data-sub="${s.id}"`));
    }
  }
});

test("every_byId_target_exists_in_html: 렌더러가 찾는 id는 전부 index.html에 있다(옮기다 잃은 칸 잡기)", () => {
  const wanted = new Set([...renderer.matchAll(/byId(?:<[^>]+>)?\("([^"]+)"\)/g)].map((m) => m[1]));
  assert.ok(wanted.size > 100);
  const missing = [...wanted].filter((id) => !idSet.has(id));
  assert.deepEqual(missing, []);
});

test("ids_unique_in_html: id가 겹치지 않는다", () => {
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
  assert.deepEqual(dup, []);
});

test("old_top_tabs_removed: 옛 위쪽 탭(role=tab data-tab)·tab-* 칸이 없다", () => {
  assert.equal(/data-tab=/.test(html), false);
  assert.equal(ids.some((id) => id.startsWith("tab-")), false);
  assert.equal(/["']tab-|data-tab/.test(renderer), false);
});

test("advanced_block_wraps_mesh_verify_case_coord: 서버 연결의 인증 코드·운영 방식·총괄은 '고급' 접기 안(기본 닫힘)", () => {
  const mesh = block("panel-multi-mesh");
  const adv = block("mesh-advanced");
  assert.ok(mesh.includes('id="mesh-advanced"'));
  assert.match(adv, /^<details[^>]*class="advanced"/);
  assert.equal(/^<details[^>]*\sopen/.test(adv), false);
  for (const id of ["mesh-verify-create-form", "mesh-verify-held", "mesh-case-form", "mesh-declare", "mesh-cmd-form", "mesh-effects"]) assert.ok(adv.includes(`id="${id}"`), id);
  for (const id of ["mesh-links", "mesh-servers", "mesh-candidates", "mesh-invite-form", "mesh-join-form"]) assert.equal(adv.includes(`id="${id}"`), false, id);
});

test("storage_moved_out_of_comms: 저장소 백업·정리·복원은 '다중 연결 ▸ 저장소', 통신 칸에는 없다", () => {
  const sto = block("panel-multi-storage");
  const comms = block("panel-multi-comms");
  for (const id of ["storage-form", "supabase-form", "prune-form", "restore-form", "storage-recovery"]) {
    assert.ok(sto.includes(`id="${id}"`), id);
    assert.equal(comms.includes(`id="${id}"`), false, id);
  }
});

test("security_badge_in_nav: 보안 배지는 왼쪽 목록의 '보안' 버튼 안", () => {
  assert.match(html, /<button[^>]*data-nav="security"[^>]*>(?:(?!<\/button>)[\s\S])*id="security-badge"/);
});

test("limits_and_app_split: 언어는 '앱 설정'(main 밖 언어 막대), 숫자·삭제 허용은 '제한 및 권한'", () => {
  const limits = block("panel-limits");
  for (const id of ["cfg-max", "cfg-batch", "cfg-dev-delete"]) assert.ok(limits.includes(`id="${id}"`), id);
  assert.equal(block("main-area").includes('id="cfg-lang"'), false, "언어는 Hub가 꺼져도 쓸 수 있게 main 밖");
});

test("panel_id_and_multi_view: 칸 id 규칙과 다중 연결 화면 판정(자동 갱신 조건)", () => {
  assert.equal(panelId("servers"), "panel-servers");
  assert.equal(panelId("servers", "multi"), "panel-servers-multi");
  assert.equal(isMultiView("multi", "storage"), true);
  assert.equal(isMultiView("servers", "multi"), true);
  assert.equal(isMultiView("accounts", "multi"), true);
  assert.equal(isMultiView("accounts", "local"), false);
  assert.equal(isMultiView("app", undefined), false);
});

test("parse_nav_memory: 기억한 위치는 알려진 칸만 받고, 이상하면 첫 화면(앱 설정)", () => {
  assert.deepEqual(parseNavMemory(null), { section: "app", subs: {} });
  assert.deepEqual(parseNavMemory("{oops"), { section: "app", subs: {} });
  assert.deepEqual(parseNavMemory(JSON.stringify({ section: "evil", subs: { multi: "x" } })), { section: "app", subs: {} });
  assert.deepEqual(parseNavMemory(JSON.stringify({ section: "multi", subs: { multi: "mesh", servers: "nope" } })), { section: "multi", subs: { multi: "mesh" } });
});

test("sync_button_in_app_settings: 앱 설정 칸에 참가자 리스트 동기화 버튼과 결과 자리", () => {
  const app = block("panel-app");
  assert.ok(app.includes('id="sync-memberships"'));
  assert.ok(app.includes('id="sync-msg"'));
});
