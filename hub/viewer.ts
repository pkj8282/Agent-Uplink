// 로컬 전용 로그 뷰어 페이지. 외부 의존성 없이 인라인 HTML/CSS/JS.
export function renderViewerHtml(): string {
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Agent-Uplink 로그</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: ui-monospace, Consolas, monospace; margin: 0; padding: 12px; }
  h1 { font-size: 14px; opacity: 0.7; margin: 0 0 8px; }
  #log { display: flex; flex-direction: column; gap: 2px; }
  .row { padding: 3px 6px; border-radius: 4px; background: rgba(127,127,127,0.08); }
  .meta { opacity: 0.6; margin-right: 6px; }
  .to { color: #d08; }
</style>
</head>
<body>
<h1>Agent-Uplink 로그 (127.0.0.1)</h1>
<div id="log"></div>
<script>
  const log = document.getElementById("log");
  // 세션 이름(from/to)과 본문은 에이전트가 보낸 신뢰할 수 없는 값이므로
  // innerHTML을 쓰지 않고 전부 textContent/DOM 노드로 넣어 XSS를 막는다.
  function fmt(m) {
    const t = new Date(m.ts).toLocaleTimeString();
    const target = m.to ? m.to : "ALL";
    const row = document.createElement("div");
    row.className = "row";
    const meta = document.createElement("span");
    meta.className = "meta";
    meta.appendChild(document.createTextNode('[' + t + ' ' + m.from + '→'));
    const to = document.createElement("span");
    to.className = "to";
    to.textContent = target;
    meta.appendChild(to);
    meta.appendChild(document.createTextNode(']'));
    row.appendChild(meta);
    row.appendChild(document.createTextNode(' ' + m.text));
    log.appendChild(row);
    window.scrollTo(0, document.body.scrollHeight);
  }
  const es = new EventSource("/events");
  es.addEventListener("init", (e) => JSON.parse(e.data).forEach(fmt));
  es.onmessage = (e) => fmt(JSON.parse(e.data));
</script>
</body>
</html>`;
}
