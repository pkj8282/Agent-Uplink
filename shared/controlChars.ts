// 표시 위장 문자의 유일한 기준: Hub 입구 감독(inspectText·escapeControls)과 MCP·관리 앱 출력 한 줄 정리(oneLine).
// admin/src/text.ts는 이 파일의 복제본이다(첫 줄 제외) — admin/src/text.test.ts가 일치를 검사한다.
// 정규식의 백슬래시는 코드포인트로 만든다(도구 경유 입력에서 이스케이프가 원문자로 바뀐 사례가 있음).

const BACKSLASH = String.fromCharCode(92);
const prop = (p: string) => `${BACKSLASH}p{${p}}`;

/**
 * 위험 문자: 제어(Cc)·서식(Cf)·줄/문단 구분자(Zl/Zp)·기본 무시 문자(Default_Ignorable_Code_Point)·짝 없는 서로게이트(Cs).
 * 줄바꿈·방향 제어·폭 0 문자와 유니코드 스테가노그래피에 쓰이는 태그 문자·변형 선택자·채움 문자가 모두 여기에 든다.
 * 정상 이모지 안의 ZWJ·변형 선택자·태그는 inspectText가 이모지 묶음으로 먼저 떼어 보호한다.
 */
const UNSAFE_SET = `[${["Cc", "Cf", "Zl", "Zp", "Default_Ignorable_Code_Point", "Cs"].map(prop).join("")}]`;
const UNSAFE = new RegExp(`^${UNSAFE_SET}$`, "v");
/** 사전 검사: 위험 문자가 하나도 없으면 ③·④ 모두 바꿀 것이 없다 — 긴 본문·로그 적재에서 이모지 분리 비용을 건너뛴다. */
const ANY_UNSAFE = new RegExp(UNSAFE_SET, "v");
const FORMAT = new RegExp(`^${prop("Cf")}$`, "v");
const RGI_ALL = new RegExp(prop("RGI_Emoji"), "gv");
const RGI_ONE = new RegExp(`^${prop("RGI_Emoji")}$`, "v");

export function isUnsafeChar(c: number): boolean {
  return UNSAFE.test(String.fromCodePoint(c));
}

export type FindingKind =
  | "control" | "separator" | "bidi" | "zero_width" | "tag" | "variation_selector"
  | "filler" | "format" | "ignorable" | "surrogate" | "emoji_smuggling";

/** 위험 문자의 종류(탐지 기록용). isUnsafeChar가 참인 문자에만 쓴다. */
export function kindOf(c: number): FindingKind {
  if (c < 0x20 || (c >= 0x7f && c <= 0x9f)) return "control";
  if (c === 0x2028 || c === 0x2029) return "separator";
  if (c === 0x061c || c === 0x200e || c === 0x200f || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069)) return "bidi";
  if ((c >= 0x200b && c <= 0x200d) || (c >= 0x2060 && c <= 0x2064) || c === 0xfeff || c === 0x180e || c === 0x034f) return "zero_width";
  if (c >= 0xe0000 && c <= 0xe007f) return "tag";
  if ((c >= 0xfe00 && c <= 0xfe0f) || (c >= 0xe0100 && c <= 0xe01ef)) return "variation_selector";
  if (c === 0x3164 || c === 0xffa0 || c === 0x115f || c === 0x1160) return "filler";
  if (c >= 0xd800 && c <= 0xdfff) return "surrogate";
  if (FORMAT.test(String.fromCodePoint(c))) return "format";
  return "ignorable";
}

export type Counts = Partial<Record<FindingKind, number>>;
export interface Inspection { text: string; counts: Counts; changed: boolean }

interface Seg { emoji: boolean; text: string }

const NAMED: Record<number, string> = { 0x0a: "n", 0x0d: "r", 0x09: "t" };
const add = (counts: Counts, k: FindingKind, n = 1) => { counts[k] = (counts[k] ?? 0) + n; };
const kept = (c: number, keepLineBreaks: boolean) => keepLineBreaks && (c === 0x0a || c === 0x0d || c === 0x09);
const isControl = (c: number) => c < 0x20 || (c >= 0x7f && c <= 0x9f);
/** 가장 긴 RGI 이모지 시퀀스(약 10 코드포인트)보다 넉넉한 여유 — 앞부분만 잘라 처리해도 max 안의 이모지는 온전하다. */
const EMOJI_SLACK = 32;

/** ①② 이모지 묶음(유니코드 공식 RGI 목록)을 떼어낸다. 순서는 그대로. */
function splitEmoji(s: string): Seg[] {
  const out: Seg[] = [];
  let last = 0;
  for (const m of s.matchAll(RGI_ALL)) {
    if (m.index > last) out.push({ emoji: false, text: s.slice(last, m.index) });
    out.push({ emoji: true, text: m[0] });
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push({ emoji: false, text: s.slice(last) });
  return out;
}

/** ④ 이모지 부분 독립 검사: 묶음이 정확히 RGI 하나인지 다시 확인(아니면 일반 텍스트로 강등)하고, 이모지 바로 뒤에 붙은 위험 문자 연속을 이모지 스머글링으로 센다(줄바꿈 등 제어 문자는 스머글링 수단이 아니라 세지 않는다). */
function inspectEmoji(segs: Seg[], keepLineBreaks: boolean): { segs: Seg[]; counts: Counts } {
  const counts: Counts = {};
  const out = segs.map((g) => (g.emoji && !RGI_ONE.test(g.text) ? { emoji: false, text: g.text } : g));
  for (let i = 1; i < out.length; i++) {
    if (out[i].emoji || !out[i - 1].emoji) continue;
    let run = 0;
    for (const ch of out[i].text) {
      const c = ch.codePointAt(0)!;
      if (!isUnsafeChar(c) || kept(c, keepLineBreaks) || isControl(c)) break;
      run++;
    }
    if (run) add(counts, "emoji_smuggling", run);
  }
  return { segs: out, counts };
}

/** ③ 이모지를 뺀 텍스트 검사: 위험 문자를 보이는 이스케이프(백슬래시+n·r·t 또는 백슬래시+u{대문자 16진수})로 바꾸고 종류별로 센다. */
function scanPlain(text: string, keepLineBreaks: boolean, counts: Counts): string {
  let out = "";
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (!isUnsafeChar(c) || kept(c, keepLineBreaks)) { out += ch; continue; }
    add(counts, kindOf(c));
    out += BACKSLASH + (NAMED[c] ?? `u{${c.toString(16).toUpperCase()}}`);
  }
  return out;
}

/** 감독 검사: ① 이모지 추출 → ② 이모지 제외 → ③ 나머지 검사 / ④ 이모지 독립 검사 → ⑤ 재조립. keepLineBreaks는 메시지 본문용. */
export function inspectText(s: string, opts: { keepLineBreaks?: boolean } = {}): Inspection {
  if (!ANY_UNSAFE.test(s)) return { text: s, counts: {}, changed: false };
  const keep = opts.keepLineBreaks === true;
  const emoji = inspectEmoji(splitEmoji(s), keep);
  const counts: Counts = { ...emoji.counts };
  const text = emoji.segs.map((g) => (g.emoji ? g.text : scanPlain(g.text, keep, counts))).join("");
  return { text, counts, changed: Object.keys(counts).length > 0 };
}

/** 이름·설명용: 위험 문자를 보이는 이스케이프로 바꾼다(정상 이모지는 그대로). 결과를 다시 넣어도 같다(멱등). */
export function escapeControls(s: string): string {
  return inspectText(s).text;
}

/** 코드포인트 기준 max자까지(이모지는 통째로만). plain은 이모지 밖 문자 변환. cut = 잘렸는가. */
function take(s: string, max: number, plain: (ch: string) => string): { out: string; cut: boolean } {
  let head = "";
  let k = 0;
  for (const ch of s) {
    if (k++ >= max + EMOJI_SLACK) break; // 긴 문자열 전체를 펼치지 않는다
    head += ch;
  }
  let out = "";
  let n = 0;
  for (const g of splitEmoji(head)) {
    if (g.emoji && RGI_ONE.test(g.text)) {
      const len = [...g.text].length;
      if (n + len > max) return { out, cut: true };
      out += g.text;
      n += len;
      continue;
    }
    for (const ch of g.text) {
      if (n >= max) return { out, cut: true };
      out += plain(ch);
      n++;
    }
  }
  return { out, cut: head.length < s.length };
}

/** 위험 문자를 공백으로 바꾸고 코드포인트 기준 max자를 넘으면 자른다. 정상 이모지는 깨지 않으며 경계에 걸리면 통째로 뺀다. */
export function oneLine(s: string, max = 200): string {
  if (!ANY_UNSAFE.test(s) && s.length <= max) return s; // 사전 검사(UTF-16 길이 ≤ max면 코드포인트도 ≤ max)
  const r = take(s, max, (ch) => (isUnsafeChar(ch.codePointAt(0)!) ? " " : ch));
  return r.cut ? `${r.out}…` : r.out;
}

/** 코드포인트 기준 max자까지 자른다(문자는 바꾸지 않음, 경계에 걸린 이모지는 통째로 뺌). 보안 기록 미리보기용. */
export function clipText(s: string, max: number): string {
  if (s.length <= max) return s;
  return take(s, max, (ch) => ch).out;
}
