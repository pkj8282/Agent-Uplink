// 로컬 전용 멀티채널 로그 뷰어. 외부 의존성 없이 인라인. 채널 필터 지원.
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
  <h1>Agent-Uplink 로그 (127.0.0.1)</h1>
  <select id="chan"><option value="">전체 채널</option></select>
</header>
<p id="auth" hidden>이 뷰어는 같은 Windows 사용자만 열 수 있습니다. 관리 앱의 '뷰어 열기' 버튼이나 터미널의 agent-uplink-viewer 명령으로 여세요. Hub가 재시작되면(유휴 종료 등) 다시 열어야 합니다.</p>
<div id="people"></div>
<div id="log"></div>
<script>
  const log = document.getElementById("log");
  const chan = document.getElementById("chan");
  const people = document.getElementById("people");
  const seen = new Set();
  let filter = "";
  let byUuid = new Map();

  // 발신자 이름에 마우스를 올리면 그 계정의 프로필 설명을 보여준다.
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
    } catch { /* Hub 재시작 중 등 — 다음 주기에 재시도 */ }
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

  // 티켓(#t=)은 1회용 — 세션으로 바꾸고 주소에서 지운다. 세션은 이 탭의 sessionStorage에만 둔다(포트까지 포함한 origin 단위).
  async function start() {
    const m = /^#t=([0-9a-f]{64})$/.exec(location.hash);
    if (m) {
      history.replaceState(null, "", "/");
      try {
        const res = await fetch("/session?t=" + m[1]);
        if (res.status === 200) store(false, (await res.json()).session);
      } catch { /* 아래에서 세션 없음으로 안내 */ }
    }
    session = store(true);
    if (!session) { showAuth(); return; }
    loadPeople();
    peopleTimer = setInterval(loadPeople, 5000);
    es = new EventSource("/events" + q());
    es.addEventListener("init", (e) => JSON.parse(e.data).forEach(fmt));
    es.onmessage = (e) => fmt(JSON.parse(e.data));
    // 재연결 실패(Hub 재시작으로 세션 소멸 등)면 /accounts로 401 여부를 확인해 안내한다.
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
