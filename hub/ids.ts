// 파일 이름으로 쓰이는 식별자 검사(경로 조작 차단). 계정 uuid는 역할 계정의 randomUUID 외에
// UPLINK_ACCOUNT로 고정한 임의 문자열도 있어, 경로에 안전한 문자만 허용한다.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ACCOUNT_ID_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;

/** 서버·채널·DM 채널 id(Hub가 randomUUID로 만든다). */
export function isUuid(s: unknown): s is string {
  return typeof s === "string" && UUID_RE.test(s);
}

/** 계정 id: 영숫자·'-'·'_'·'.'(첫 글자는 '.' 불가), 128자 이하, '..' 없음. */
export function isSafeAccountId(s: unknown): s is string {
  return typeof s === "string" && ACCOUNT_ID_RE.test(s) && !s.includes("..");
}
