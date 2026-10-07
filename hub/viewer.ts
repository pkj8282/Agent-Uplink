// 로컬 전용 멀티채널 로그 뷰어. 외부 의존성 없이 인라인. 채널 필터 지원.
// 문구는 Hub 문구표의 고정 문자열뿐이다(사용자 데이터는 페이지 스크립트가 textContent로 넣는다).
import { hubMsg } from "./messages.js";
import type { Lang } from "../shared/i18n.js";

export function renderViewerHtml(lang: Lang): string {
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${hubMsg(lang, "viewer_title")}</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: ui-monospace, Consolas, monospace; margin: 0; padding: 12px; }
  header { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
  h1 { font-size: 14px; opacity: 0.7; margin: 0; }
  select { font: inherit; padding: 2px 4px; }
  #log { display: flex; flex-direction: column; gap: 2px; }
  .row { padding: 3px 6px; border-radius: 4px; background: rgba(127,127,127,0.08); }
  .row.hidden { display: none; }
  .ch { color: #0a8; margin-right: 6px; }
  .meta { opacity: 0.6; margin-right: 6px; }
  #people { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
  .person { padding: 2px 8px; border-radius: 10px; background: rgba(127,127,127,0.12); }
  .person.on::before { content: "● "; color: #0a8; }
  #auth { padding: 6px 8px; border-radius: 4px; background: rgba(200,120,0,0.15); }
</style>
</head>
<body>
<header>
  <h1>${hubMsg(lang, "viewer_heading")}</h1>
  <select id="chan"><option value="">${hubMsg(lang, "viewer_all_channels")}</option></select>
</header>
<p id="auth" hidden>${hubMsg(lang, "viewer_auth_note")}</p>
<div id="people"></div>
<div id="log"></div>
<script>
  const log = document.getElementById("log");
  const chan = document.getElementById("chan");
  const people = document.getElementById("people");
  const seen = new Set();
  let filter = "";
  let byUuid = new Map();

  // Hovering a sender name shows that account's profile description.
  function applyTitles() {
    for (const el of log.querySelectorAll(".meta[data-uuid]")) {
      const p = byUuid.get(el.dataset.uuid);
      el.title = p && p.description ? p.description : "";
    }
  }

  const authNote = document.getElementById("auth");
  const SESSION_KEY = "uplink_viewer_session";
  let peopleTimer = null;
  let es = null;
  let session = null;
  function store(get, value) {
    try { return get ? sessionStorage.getItem(SESSION_KEY) : (value === null ? sessionStorage.removeItem(SESSION_KEY) : sessionStorage.setItem(SESSION_KEY, value)); }
    catch { return null; }
  }
  function showAuth() {
    authNote.hidden = false;
    store(false, null);
    if (es) es.close();
    if (peopleTimer) clearInterval(peopleTimer);
  }
  const q = () => "?s=" + encodeURIComponent(session);

  async function loadPeople() {
    try {
      const res = await fetch("/accounts" + q());
      if (res.status === 401) { showAuth(); return; }
      const list = await res.json();
      byUuid = new Map(list.map((p) => [p.uuid, p]));
      people.replaceChildren(...list.map((p) => {
        const s = document.createElement("span");
        s.className = p.online ? "person on" : "person";
        s.textContent = p.name;
        s.title = p.description || "";
        return s;
      }));
      applyTitles();
    } catch { /* hub restarting etc. — retry next tick */ }
  }


  function applyFilter(row) {
    row.classList.toggle("hidden", filter !== "" && row.dataset.ch !== filter);
  }

  function addChannelOption(label) {
    if (seen.has(label)) return;
    seen.add(label);
    const opt = document.createElement("option");
    opt.value = label; opt.textContent = "#" + label;
    chan.appendChild(opt);
  }

  function fmt(m) {
    const label = m.channelLabel || m.channelId;
    addChannelOption(label);
    const t = new Date(m.ts).toLocaleTimeString();
    const row = document.createElement("div");
    row.className = "row";
    row.dataset.ch = label;
    const ch = document.createElement("span");
    ch.className = "ch"; ch.textContent = "#" + label;
    const meta = document.createElement("span");
    meta.className = "meta"; meta.textContent = "[" + t + " " + m.fromName + "]";
    const uuid = m.fromUuid || m.from;
    if (uuid) {
      meta.dataset.uuid = uuid;
      const p = byUuid.get(uuid);
      meta.title = p && p.description ? p.description : "";
    }
    row.appendChild(ch); row.appendChild(meta);
    row.appendChild(document.createTextNode(" " + m.text));
    applyFilter(row);
    log.appendChild(row);
    if (!row.classList.contains("hidden")) window.scrollTo(0, document.body.scrollHeight);
  }

  chan.addEventListener("change", () => {
    filter = chan.value;
    for (const row of log.children) applyFilter(row);
  });

  // The ticket (#t=) is single-use: exchange it for a session and remove it from the address. The session lives only in this tab's sessionStorage (per origin, including the port).
  async function start() {
    const m = /^#t=([0-9a-f]{64})$/.exec(location.hash);
    if (m) {
      history.replaceState(null, "", "/");
      try {
        const res = await fetch("/session?t=" + m[1]);
        if (res.status === 200) store(false, (await res.json()).session);
      } catch { /* reported below as no session */ }
    }
    session = store(true);
    if (!session) { showAuth(); return; }
    loadPeople();
    peopleTimer = setInterval(loadPeople, 5000);
    es = new EventSource("/events" + q());
    es.addEventListener("init", (e) => JSON.parse(e.data).forEach(fmt));
    es.onmessage = (e) => fmt(JSON.parse(e.data));
    // If reconnecting fails (e.g. the session vanished when the hub restarted), check /accounts for 401 and show the notice.
    es.onerror = () => { void loadPeople(); };
  }
  void start();
</script>
</body>
</html>`;
}

/** DNS rebinding 방어: Host가 루프백 이름 + 실제 포트일 때만 응답한다. */
export function isAllowedHost(host: string | undefined, port: number): boolean {
  if (!host) return false;
  const h = host.toLowerCase();
  return h === `127.0.0.1:${port}` || h === `localhost:${port}` || h === `[::1]:${port}`;
}
