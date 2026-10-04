// 뷰어 티켓 URL 검사: Hub가 주는 형식(http://127.0.0.1:<포트>/#t=<64 hex>)만 브라우저로 연다.
// 티켓은 URL 조각(#)에 있어 서버 로그·Referer로 나가지 않는다.
// 관리 앱 사본: admin/src/auth.ts(isViewerUrl) — 바꾸면 같이 바꾼다.
export function isViewerUrl(u: unknown): u is string {
  if (typeof u !== "string" || !u.startsWith("http://127.0.0.1:")) return false;
  let url: URL;
  try {
    url = new URL(u);
  } catch {
    return false;
  }
  return (
    url.protocol === "http:" &&
    url.hostname === "127.0.0.1" &&
    url.port !== "" &&
    url.username === "" &&
    url.password === "" &&
    url.pathname === "/" &&
    url.search === "" &&
    /^#t=[0-9a-f]{64}$/.test(url.hash)
  );
}
