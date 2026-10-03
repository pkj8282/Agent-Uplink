// 로컬 전용 멀티채널 로그 뷰어. 외부 의존성 없이 인라인.
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
  .ch { color: #0a8; margin-right: 6px; }
  .meta { opacity: 0.6; margin-right: 6px; }
</style>
</head>
<body>
<h1>Agent-Uplink 로그 (127.0.0.1)</h1>
<div id="log"></div>
<script>
  const log = document.getElementById("log");
  function fmt(m) {
    const t = new Date(m.ts).toLocaleTimeString();
    const row = document.createElement("div");
    row.className = "row";
    const ch = document.createElement("span");
    ch.className = "ch"; ch.textContent = "#" + (m.channelLabel || m.channelId);
    const meta = document.createElement("span");
    meta.className = "meta"; meta.textContent = "[" + t + " " + m.fromName + "]";
    row.appendChild(ch); row.appendChild(meta);
    row.appendChild(document.createTextNode(" " + m.text));
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
