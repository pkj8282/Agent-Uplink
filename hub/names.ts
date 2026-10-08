// 서버·채널 이름 비교와 충돌 회피(복원 시 '이름 (n)'), 이름 길이 검사.
import { NAME_MAX } from "../shared/protocol.js";
import { escapeControls } from "../shared/controlChars.js";

export function nameKey(s: string): string {
  return s.trim().toLowerCase();
}

function isDigits(s: string): boolean {
  if (s.length === 0) return false;
  for (const c of s) if (c < "0" || c > "9") return false;
  return true;
}

/**
 * base가 taken과 겹치지 않으면 그대로, 겹치면 'base (n)'.
 * n은 "base와 같거나 'base (숫자)' 꼴인 이름" 개수 + 1에서 시작하고, 이미 쓰이면 1씩 올린다
 * (개수만 쓰면 'base'·'base (3)'이 있을 때 'base (3)'이 충돌한다). 비교 대상이 k개면 k+1번 안에 끝난다.
 */
export function uniqueName(base: string, taken: string[]): string {
  const keys = new Set(taken.map(nameKey));
  const b = nameKey(base);
  if (!keys.has(b)) return base;
  const prefix = `${b} (`;
  let n = 0;
  for (const k of keys) {
    if (k === b) n++;
    else if (k.startsWith(prefix) && k.endsWith(")") && isDigits(k.slice(prefix.length, -1))) n++;
  }
  for (let i = n + 1; ; i++) {
    const cand = `${base} (${i})`;
    if (!keys.has(nameKey(cand))) return cand;
  }
}

export type NameKind = "account" | "server" | "channel";

/**
 * 서버·채널·계정 이름: 앞뒤 공백을 지운 뒤 1~NAME_MAX 코드포인트(원래 문자열 기준). 통과하면 위장 문자를
 * 이스케이프한 이름(v2.1.2 입력 경계 — Hub는 clean에 감독 기록을 넘긴다). 실패는 언어 중립 값(문구는 Hub가 만든다).
 */
export function validateName(
  raw: unknown,
  kind: NameKind,
  clean: (s: string) => string = escapeControls,
): { ok: true; name: string } | { ok: false; code: "name_invalid"; params: { kind: NameKind; max: number } } {
  const name = typeof raw === "string" ? raw.trim() : "";
  const len = [...name].length;
  if (len === 0 || len > NAME_MAX) return { ok: false, code: "name_invalid", params: { kind, max: NAME_MAX } };
  return { ok: true, name: clean(name) };
}
