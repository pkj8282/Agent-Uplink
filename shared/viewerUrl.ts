// 뷰어 티켓 URL 검사: Hub가 주는 형식(http://127.0.0.1:<포트>/?t=<64 hex>)만 브라우저로 연다.
// 관리 앱 사본: admin/src/auth.ts(isViewerUrl) — 바꾸면 같이 바꾼다.
export function isViewerUrl(u: unknown): u is string {
  if (typeof u !== "string" || !u.startsWith("http://127.0.0.1:")) return false;
  let url: URL;
  try {
    url = new URL(u);
  } catch {
    return false;
  }
  const keys = [...url.searchParams.keys()];
  return (
    url.protocol === "http:" &&
    url.hostname === "127.0.0.1" &&
    url.port !== "" &&
    url.username === "" &&
    url.password === "" &&
    url.pathname === "/" &&
    keys.length === 1 &&
    keys[0] === "t" &&
    /^[0-9a-f]{64}$/.test(url.searchParams.get("t") ?? "")
  );
}
