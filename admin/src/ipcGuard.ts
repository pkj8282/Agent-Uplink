/** IPC를 보낸 프레임이 우리 렌더러(index.html)인지 확인한다(쿼리·해시는 무시). */
export function isTrustedSender(senderUrl: string | undefined, indexUrl: string): boolean {
  if (!senderUrl) return false;
  try {
    const u = new URL(senderUrl);
    u.hash = "";
    u.search = "";
    return u.href === new URL(indexUrl).href;
  } catch {
    return false;
  }
}
