// 표시 위장 문자의 유일한 기준: Hub 입구 이스케이프(escapeControls)와 MCP·관리 앱 출력 한 줄 정리(oneLine).
// admin/src/text.ts는 이 파일의 복제본이다(첫 줄 제외) — admin/src/text.test.ts가 일치를 검사한다.

/**
 * 표시를 위장할 수 있는 문자: C0·DEL·C1 제어문자(줄바꿈 포함), 줄·문단 구분자(U+2028/2029),
 * 방향 제어(U+202A–202E, U+2066–2069, LRM/RLM, ALM), 폭 0 문자(U+200B–200D, U+FEFF).
 * 정규식 이스케이프 대신 코드포인트로 판정한다(도구 경유 입력에서 이스케이프가 원문자로 바뀐 사례가 있음).
 */
export function isUnsafeChar(c: number): boolean {
  return (
    c < 0x20 ||
    (c >= 0x7f && c <= 0x9f) ||
    c === 0x2028 ||
    c === 0x2029 ||
    (c >= 0x202a && c <= 0x202e) ||
    (c >= 0x2066 && c <= 0x2069) ||
    c === 0x200e ||
    c === 0x200f ||
    c === 0x061c ||
    (c >= 0x200b && c <= 0x200d) ||
    c === 0xfeff
  );
}

const BACKSLASH = String.fromCharCode(92);
const NAMED: Record<number, string> = { 0x0a: "n", 0x0d: "r", 0x09: "t" };

/** 위장 문자를 보이는 이스케이프로 바꾼다: LF·CR·TAB은 백슬래시+n·r·t, 나머지는 백슬래시+u{대문자 16진수}. 결과에는 위장 문자가 없다(멱등). */
export function escapeControls(s: string): string {
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    out += isUnsafeChar(c) ? BACKSLASH + (NAMED[c] ?? `u{${c.toString(16).toUpperCase()}}`) : ch;
  }
  return out;
}

/** 위장 문자를 공백으로 바꾸고, 코드포인트 기준 max자를 넘으면 자른다. */
export function oneLine(s: string, max = 200): string {
  const cps = [...s].map((ch) => (isUnsafeChar(ch.codePointAt(0)!) ? " " : ch));
  return cps.length > max ? `${cps.slice(0, max).join("")}…` : cps.join("");
}
