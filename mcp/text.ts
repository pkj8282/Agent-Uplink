// 에이전트가 정한 이름·설명을 MCP 텍스트 출력(한 줄 목록)에 안전하게 넣기 위한 정리.

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

/** 위장 문자를 공백으로 바꾸고, 코드포인트 기준 max자를 넘으면 자른다. */
export function oneLine(s: string, max = 200): string {
  const cps = [...s].map((ch) => (isUnsafeChar(ch.codePointAt(0)!) ? " " : ch));
  return cps.length > max ? `${cps.slice(0, max).join("")}…` : cps.join("");
}
