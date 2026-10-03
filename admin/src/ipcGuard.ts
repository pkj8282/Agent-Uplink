/** URL을 비교용으로 정규화: 쿼리·해시 제거, 경로의 퍼센트 인코딩 해제(~ 와 %7E 등은 같은 파일). */
function canonical(raw: string): string {
  const u = new URL(raw);
  return `${u.protocol}//${u.host}${decodeURIComponent(u.pathname)}`;
}

/** IPC를 보낸 프레임이 우리 렌더러(index.html)인지 확인한다. */
export function isTrustedSender(senderUrl: string | undefined, indexUrl: string): boolean {
  if (!senderUrl) return false;
  try {
    return canonical(senderUrl) === canonical(indexUrl);
  } catch {
    return false;
  }
}
