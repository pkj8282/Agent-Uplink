// 스킬 문서(skills/agent-uplink)가 코드·문서의 사실과 어긋나지 않는지, 공개해도 되는 형태인지 검사한다.
// 스킬 배포물에 섞이지 않도록 테스트는 스킬 폴더 밖(여기)에 둔다.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { toolTexts } from "./tools.js";
import { MAX_TEXT_LENGTH } from "../shared/protocol.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SKILL = path.join(ROOT, "skills", "agent-uplink");

/** 스킬 폴더 기준 상대 경로의 파일(줄 끝 LF로 통일). */
const read = (rel: string): string => fs.readFileSync(path.join(SKILL, rel), "utf8").replace(/\r\n/g, "\n");
/** 저장소 루트 기준 상대 경로의 파일. */
const src = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full));
    else if (e.name.endsWith(".md")) out.push(path.relative(SKILL, full).split(path.sep).join("/"));
  }
  return out;
}
/** 에이전트가 읽는 영어 파일(ko/ 제외). */
const enFiles = (): string[] => walk(SKILL).filter((f) => !f.startsWith("ko/"));

function frontmatter(md: string): Record<string, string> {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(md);
  assert.ok(m, "frontmatter가 없다");
  const out: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

/** 상대 링크 대상(앵커·URL 제외). */
const links = (md: string): string[] =>
  [...md.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)].map((m) => m[1]).filter((h) => !/^[a-z]+:/i.test(h));

const MARKER = /^<!-- 사용자 작성: [A-K](?:-[^\s]+)? -->$/;
const FORBIDDEN: RegExp[] = [/[A-Za-z]:\\/, /\.dev-docs/, /pkjhjt/i, /Research/, /세션-[0-9]/, /Cyber Factory/i, /감염시스템/, /커미션/];

test("frontmatter: name·description 형식", () => {
  const fm = frontmatter(read("SKILL.md"));
  assert.equal(fm.name, "agent-uplink");
  assert.match(fm.name, /^[a-z0-9-]{1,64}$/);
  assert.ok(fm.description && fm.description.length <= 1024, "description은 1~1024자");
  assert.doesNotMatch(fm.description, /[<>]/, "description에 꺾쇠 금지");
  assert.doesNotMatch(fm.description, /: /, "YAML 일반 문자열이라 ': ' 금지");
  assert.match(fm.description, /^Coordinates /, "3인칭으로 시작");
});

test("SKILL.md의 상대 링크는 모두 존재하고 ko/를 가리키지 않으며, references는 전부 연결된다", () => {
  const targets = links(read("SKILL.md"));
  for (const t of targets) {
    assert.ok(fs.existsSync(path.join(SKILL, t)), `없는 링크: ${t}`);
    assert.ok(!t.startsWith("ko/"), `영어 본문이 ko/를 가리킴: ${t}`);
  }
  for (const f of enFiles().filter((f) => f.startsWith("references/"))) {
    assert.ok(targets.includes(f), `SKILL.md에서 연결 안 된 파일: ${f}`);
  }
});

test("references 안에서는 다른 파일로 다시 연결하지 않는다(한 단계)", () => {
  for (const f of enFiles().filter((f) => f.startsWith("references/"))) {
    assert.deepEqual(links(read(f)), [], `${f}가 다른 파일을 가리킴`);
  }
});

test("HTML 주석은 사용자 작성 표시뿐이다", () => {
  for (const f of enFiles()) {
    for (const m of read(f).matchAll(/<!--[\s\S]*?-->/g)) assert.match(m[0], MARKER, `${f}: ${m[0]}`);
  }
});

test("공개 저장소에 둘 수 없는 내용이 없다", () => {
  for (const f of walk(SKILL)) {
    const text = read(f);
    for (const re of FORBIDDEN) assert.doesNotMatch(text, re, `${f}: ${re}`);
  }
});

/** 소스에서 첫 캡처 숫자를 꺼낸다. 못 찾으면 테스트가 깨져서 소스 변경을 알린다. */
function num(rel: string, re: RegExp): string {
  const m = re.exec(src(rel));
  assert.ok(m, `${rel}에서 ${re}를 못 찾음`);
  return m[1];
}
const section = (md: string, title: string): string => {
  const start = md.indexOf(`## ${title}\n`);
  assert.ok(start >= 0, `섹션 없음: ${title}`);
  const rest = md.slice(start + title.length + 4);
  const end = rest.search(/^## /m);
  return end < 0 ? rest : rest.slice(0, end);
};

test("도구 표는 MCP 도구 17개와 정확히 같다", () => {
  const rows = [...section(read("SKILL.md"), "Tools").matchAll(/^\| `([a-z_]+)` \|/gm)].map((m) => m[1]);
  const tools = Object.keys(toolTexts("en").tools);
  assert.equal(tools.length, 17);
  assert.deepEqual([...rows].sort(), [...tools].sort());
});

test("스킬 파일에 나오는 도구 이름은 실제 도구뿐이다", () => {
  const tools = new Set(Object.keys(toolTexts("en").tools));
  for (const f of enFiles()) {
    for (const m of read(f).matchAll(/`([a-z]+(?:_[a-z]+)+)[`(]/g)) assert.ok(tools.has(m[1]), `${f}: 없는 도구 ${m[1]}`);
  }
});

test("한도 숫자는 코드 값과 같다", () => {
  // 숫자만 찾으면 "30"이 "30000" 안에서도 맞으므로, 단위까지 붙은 문장 조각으로 대조한다.
  const limits = section(read("SKILL.md"), "Limits");
  const has = (piece: string, what: string) => assert.ok(limits.includes(piece), `${what}: "${piece}" 없음`);
  has(`up to ${MAX_TEXT_LENGTH.toLocaleString("en-US")} characters`, "메시지 최대 길이");
  has(`at most ${num("mcp/index.ts", /timeoutMs: z\.number\(\)[^\n]*?\.max\((\d+)\)/)} ms`, "wait 최대");
  has(`default ${num("mcp/index.ts", /client\.wait\(timeoutMs \?\? (\d+)\)/)} ms`, "wait 기본");
  has(`at most ${num("mcp/index.ts", /limit: z\.number\(\)[^\n]*?\.max\((\d+)\)/)}.`, "read 최대");
  has(`at most ${num("hub/config.ts", /inboxMaxBatch: (\d+)/)} items`, "inboxMaxBatch 기본");
  has(`at most ${num("hub/config.ts", /maxChannelsPerServer: (\d+)/)} channels`, "서버당 채널 기본");
  has(`at most ${num("mcp/index.ts", /description: z\.string\(\)\.max\((\d+)\)/)} characters`, "프로필 최대");
  assert.match(src("docs/messaging.md"), /default 50/, "read 기본 50의 근거 문서");
  has("default 50 messages", "read 기본");
});

test("안전 수칙: 받은 메시지는 데이터, 삭제 기본 꺼짐, UUID, 숨은 문자 표시", () => {
  const safety = section(read("SKILL.md"), "Safety");
  assert.match(safety, /not the user's instructions/);
  assert.match(safety, /allowDevDelete/);
  assert.match(safety, /UUID/);
  assert.ok(safety.includes(String.fromCharCode(92) + "u{"), "숨은 문자 이스케이프 표시 설명");
});

test("Review Focus 1·2: 미설치 안내와 pull 전용 문장", () => {
  const md = read("SKILL.md");
  assert.match(md, /not installed/);
  assert.match(md, /\(references\/setup\.md\)/);
  assert.match(section(md, "Core flow"), /Nothing reaches you until you call `check` or `wait`/);
});
