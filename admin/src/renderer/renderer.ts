import type { AdminApi, AdminConfig, IpcResult, Snapshot, TrashItem } from "../types.js";
import {
  ConfigFormState, LatestOnly, accountMeta, conflictConfirmMessage, deleteConfirmMessage, displayName, dmCountOf,
  emptyTrashConfirmMessage, formatBytes, memberNames, opErrorMessage, parseConfigForm, restoreConfirmMessage,
  restoreResultMessage, trashFlags, trashKindLabel, trashSummary, trashTitle,
} from "./view.js";
import type { FormMessage } from "./view.js";
import { getLang, setLang, tr } from "./lang.js";
import { PICKER, type AdminKey } from "../messages.js";
import { localeOf, type Lang } from "../i18n.js";

const formState = new ConfigFormState();
const snapshotSeq = new LatestOnly();

declare global {
  interface Window { admin: AdminApi }
}

// 이름 등 사용자 데이터는 에이전트가 정한 임의 문자열이다 → textContent로만 넣는다(innerHTML 금지).
function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, cls?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (cls) e.className = cls;
  return e;
}

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function showBanner(text: string): void {
  const b = byId("banner");
  b.textContent = text;
  b.hidden = text === "";
}

// 작업 결과·오류: Hub 상태 배너와 분리 — 새로고침이 지우지 않고, 다음 작업 시작이나 닫기로만 지운다.
function showOpMsg(m: { text: string; kind: "ok" | "err" } | null): void {
  const box = byId("op-msg");
  if (!m) { box.hidden = true; return; }
  byId("op-msg-text").textContent = m.text;
  box.className = `opmsg ${m.kind}`;
  box.hidden = false;
}
byId("op-msg-close").addEventListener("click", () => showOpMsg(null));

type ViewState = "loading" | "ready" | "hubdown" | "error" | "lang";

let lastFocus: HTMLElement | null = null;

/** 화면 상태: ready가 아니면 본문을 inert로 막아 마우스·키보드 조작을 모두 차단한다. 막기 직전 포커스를 기억한다. */
function setState(state: ViewState): void {
  const main = document.querySelector("main")!;
  if (state !== "ready" && !main.inert) {
    const a = document.activeElement;
    lastFocus = a instanceof HTMLElement && main.contains(a) ? a : null;
  }
  document.body.dataset.state = state;
  main.inert = state !== "ready";
  byId("status").textContent = state === "loading" ? tr("status_loading") : "";
}

/** 다시 그린 뒤 포커스 복원: 원래 요소가 남아 있으면 그것, 다시 그려져 사라졌거나 비활성이면 현재 탭 버튼. */
function restoreFocus(): void {
  if (!lastFocus) return;
  const keep = lastFocus.isConnected && !(lastFocus as HTMLButtonElement).disabled;
  const target = keep ? lastFocus : document.querySelector<HTMLElement>('[data-tab][aria-selected="true"]');
  lastFocus = null;
  target?.focus();
}

async function refresh(): Promise<void> {
  const t = snapshotSeq.begin();
  setState("loading");
  const r = await window.admin.snapshot();
  if (!snapshotSeq.isLatest(t)) return; // 더 나중에 시작한 새로고침이 있으면 이 결과는 버린다
  if (!r.ok) {
    setState(r.hubDown ? "hubdown" : "error");
    showBanner(r.hubDown ? r.error : tr("load_failed", { detail: r.error }));
    return;
  }
  setState("ready");
  showBanner("");
  if (formState.acceptsRefresh()) renderConfig(r.data.config); // 저장 안 된 수정은 덮어쓰지 않는다
  renderServers(r.data);
  renderAccounts(r.data);
  renderTrash(r.data);
  restoreFocus();
}

function renderConfig(c: AdminConfig): void {
  byId<HTMLInputElement>("cfg-max").value = String(c.maxChannelsPerServer);
  byId<HTMLInputElement>("cfg-batch").value = String(c.inboxMaxBatch);
  byId<HTMLInputElement>("cfg-dev-delete").checked = c.allowDevDelete;
}

/** 확인 대화상자 → 삭제(휴지통으로) → 새로고침. 결과는 작업 메시지 영역에 남긴다(배너와 분리). */
function deleteButton(label: string, confirmText: string, action: () => Promise<IpcResult<void>>): HTMLButtonElement {
  const b = el("button", label, "danger");
  b.type = "button";
  b.addEventListener("click", async () => {
    if (!window.confirm(confirmText)) return;
    showOpMsg(null);
    b.disabled = true;
    const r = await action();
    await refresh();
    showOpMsg(r.ok
      ? { text: tr("deleted_ok"), kind: "ok" }
      : { text: tr("delete_failed", { detail: opErrorMessage(r.code, r.error) }), kind: "err" });
  });
  return b;
}

let trashItems: TrashItem[] | undefined;

function renderTrash(s: Snapshot): void {
  trashItems = s.trash;
  byId("trash-summary").textContent = trashSummary(s.trash);
  byId<HTMLButtonElement>("empty-trash").disabled = !s.trash || s.trash.length === 0;
  const list = byId("trash-list");
  list.replaceChildren();
  if (!s.trash) return;
  if (s.trash.length === 0) { list.append(el("li", tr("trash_is_empty"), "empty")); return; }
  for (const t of [...s.trash].reverse()) { // 최근 삭제가 위
    const li = el("li", undefined, "row");
    li.dataset.kind = "trash";
    li.append(
      el("span", trashKindLabel(t.kind), "meta"),
      el("span", trashTitle(t) || t.id, "name"),
      el("span", `${new Date(t.deletedAt).toLocaleString(localeOf(getLang()))} · ${formatBytes(t.bytes)} · ${t.deletedBy}`, "meta"),
    );
    for (const f of trashFlags(t)) li.append(el("span", f, "flag"));
    const b = el("button", tr("btn_restore"));
    b.type = "button";
    b.disabled = !t.restorable;
    b.addEventListener("click", () => void restoreFlow(t, b));
    li.append(b);
    list.append(li);
  }
}

/** 복원: 확인 → 이름이 겹치면 확인 입력 창 → 예일 때만 번호를 붙여 복원. */
async function restoreFlow(t: TrashItem, b: HTMLButtonElement): Promise<void> {
  if (!window.confirm(restoreConfirmMessage(t))) return;
  showOpMsg(null);
  b.disabled = true;
  let r = await window.admin.restoreTrash(t.id, false);
  if (!r.ok && r.code === "name_conflict" && r.conflicts) {
    if (!window.confirm(conflictConfirmMessage(r.conflicts))) { await refresh(); return; }
    r = await window.admin.restoreTrash(t.id, true);
  }
  await refresh();
  showOpMsg(r.ok ? { text: restoreResultMessage(r.data), kind: "ok" } : { text: opErrorMessage(r.code, r.error), kind: "err" });
}

byId("empty-trash").addEventListener("click", async () => {
  const items = trashItems ?? [];
  if (items.length === 0) return;
  if (!window.confirm(emptyTrashConfirmMessage(items.length, items.reduce((s, t) => s + t.bytes, 0)))) return;
  showOpMsg(null);
  const r = await window.admin.emptyTrash();
  await refresh();
  showOpMsg(r.ok ? { text: tr("trash_emptied", { count: r.data.removed }), kind: "ok" } : { text: opErrorMessage(r.code, r.error), kind: "err" });
});

function renderServers(s: Snapshot): void {
  const list = byId("server-list");
  list.replaceChildren();
  if (s.servers.length === 0) { list.append(el("li", tr("no_servers"), "empty")); return; }
  for (const srv of s.servers) {
    const li = el("li");
    li.dataset.kind = "server";
    const row = el("div", undefined, "row");
    row.append(
      el("span", srv.name, "name"),
      el("span", srv.id, "id"),
      el("span", tr("server_channels", { count: srv.channels.length }), "meta"),
      deleteButton(tr("btn_delete_server"), deleteConfirmMessage({ kind: "server", name: srv.name, channelCount: srv.channels.length }),
        () => window.admin.deleteServer(srv.id)),
    );
    const sub = el("ul");
    for (const ch of srv.channels) {
      const cli = el("li", undefined, "row");
      cli.dataset.kind = "channel";
      cli.append(
        el("span", `# ${ch.name}`, "name"),
        el("span", ch.id, "id"),
        deleteButton(tr("btn_delete"), deleteConfirmMessage({ kind: "channel", name: ch.name, serverName: srv.name }),
          () => window.admin.deleteChannel(ch.id)),
      );
      sub.append(cli);
    }
    li.append(row, sub);
    list.append(li);
  }
}

function renderAccounts(s: Snapshot): void {
  const accounts = byId("account-list");
  accounts.replaceChildren();
  if (s.accounts.length === 0) accounts.append(el("li", tr("no_accounts"), "empty"));
  for (const a of s.accounts) {
    const n = dmCountOf(a.uuid, s.dms);
    const li = el("li", undefined, "row");
    li.dataset.kind = "account";
    li.append(
      el("span", a.name, "name"),
      el("span", a.uuid, "id"),
      el("span", accountMeta(a.online, n), a.online ? "meta online" : "meta"),
    );
    if (a.description) li.append(el("span", displayName(a.description, 120), "desc"));
    li.append(
      deleteButton(tr("btn_delete_account"), deleteConfirmMessage({ kind: "account", name: a.name, uuid: a.uuid, dmCount: n }),
        () => window.admin.deleteAccount(a.uuid)),
    );
    accounts.append(li);
  }
  const dms = byId("dm-list");
  dms.replaceChildren();
  if (s.dms.length === 0) dms.append(el("li", tr("no_dms"), "empty"));
  for (const d of s.dms) {
    const li = el("li", undefined, "row");
    li.dataset.kind = "dm";
    li.append(el("span", memberNames(d, s.accounts), "name"), el("span", d.label, "meta"), el("span", d.channelId, "id"));
    dms.append(li);
  }
}

function selectTab(name: string): void {
  for (const b of document.querySelectorAll<HTMLButtonElement>("[data-tab]")) {
    b.setAttribute("aria-selected", String(b.dataset.tab === name));
  }
  for (const p of document.querySelectorAll<HTMLElement>(".panel")) p.hidden = p.id !== `tab-${name}`;
}

for (const b of document.querySelectorAll<HTMLButtonElement>("[data-tab]")) {
  b.addEventListener("click", () => selectTab(b.dataset.tab!));
}

byId("refresh").addEventListener("click", () => void refresh());

byId("open-viewer").addEventListener("click", async () => {
  showOpMsg(null);
  const r = await window.admin.openViewer();
  if (!r.ok) showOpMsg({ text: tr("viewer_open_failed", { detail: r.error }), kind: "err" });
});

function showFormMessage(m: FormMessage): void {
  const msg = byId("config-msg");
  msg.textContent = m.text;
  msg.className = `msg ${m.kind}`;
}

// 값이 바뀌면 이전 "저장했습니다"를 지우고 미저장 상태로 표시한다.
byId<HTMLFormElement>("config-form").addEventListener("input", () => showFormMessage(formState.edit()));

byId<HTMLFormElement>("config-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const parsed = parseConfigForm({
    maxChannelsPerServer: byId<HTMLInputElement>("cfg-max").value,
    inboxMaxBatch: byId<HTMLInputElement>("cfg-batch").value,
    allowDevDelete: byId<HTMLInputElement>("cfg-dev-delete").checked,
  });
  if (!parsed.ok) { showFormMessage(formState.failed(parsed.error)); return; }
  const r = await window.admin.setConfig(parsed.patch);
  if (!r.ok) { showFormMessage(formState.failed(tr("save_failed", { detail: r.error }))); return; }
  showFormMessage(formState.saved());
  await refresh();
});

// --- 언어 ---

/** index.html의 고정 라벨(data-i18n)과 창 제목·lang을 현재 언어로 채운다. 언어 이름은 두 언어 공통(PICKER). */
function applyStatic(): void {
  for (const e of document.querySelectorAll<HTMLElement>("[data-i18n]")) e.textContent = tr(e.dataset.i18n as AdminKey);
  for (const e of document.querySelectorAll<HTMLElement>("[data-i18n-aria]")) e.setAttribute("aria-label", tr(e.dataset.i18nAria as AdminKey));
  document.title = tr("window_title");
  document.documentElement.lang = getLang();
  const sel = byId<HTMLSelectElement>("cfg-lang");
  for (const o of sel.options) o.textContent = o.value === "ko" ? PICKER.ko : PICKER.en;
  sel.value = getLang();
}

/** 첫 실행(config.json의 language가 N/A): 언어를 고를 때까지 다른 화면을 숨긴다. 저장 실패는 진행한 뒤 알린다(다음 실행 때 다시 묻는다). */
function pickLanguage(): Promise<string | null> {
  return new Promise((resolve) => {
    document.body.dataset.state = "lang";
    document.body.removeAttribute("data-i18n-pending");
    const box = byId("lang-picker");
    byId("lang-picker-title").textContent = PICKER.title;
    const buttons = [byId<HTMLButtonElement>("lang-ko"), byId<HTMLButtonElement>("lang-en")];
    buttons[0].textContent = PICKER.ko;
    buttons[1].textContent = PICKER.en;
    box.hidden = false;
    const choose = async (lang: Lang) => {
      for (const b of buttons) b.disabled = true;
      setLang(lang);
      const r = await window.admin.setLanguage(lang);
      box.hidden = true;
      resolve(r.ok ? null : r.error);
    };
    buttons[0].addEventListener("click", () => void choose("ko"), { once: true });
    buttons[1].addEventListener("click", () => void choose("en"), { once: true });
    buttons[0].focus();
  });
}

// 설정 탭 언어: 다른 설정과 따로 바로 저장한다(Hub가 꺼져 있어도 바꿀 수 있어야 한다).
byId<HTMLSelectElement>("cfg-lang").addEventListener("change", async (e) => {
  const lang: Lang = (e.target as HTMLSelectElement).value === "ko" ? "ko" : "en";
  const r = await window.admin.setLanguage(lang);
  setLang(lang);
  applyStatic();
  const m = byId("lang-msg");
  m.textContent = r.ok ? tr("lang_changed_notice") : r.error;
  m.className = `msg ${r.ok ? "ok" : "err"}`;
  await refresh(); // 목록·상태 문구를 새 언어로 다시 그린다(Hub 오류도 같은 설정을 따른다)
});

async function boot(): Promise<void> {
  const g = await window.admin.getLanguage();
  const setting = g.ok ? g.data : "N/A";
  let saveError: string | null = null;
  if (setting === "N/A") saveError = await pickLanguage();
  else setLang(setting);
  applyStatic();
  document.body.removeAttribute("data-i18n-pending");
  await refresh(); // 그다음 Hub 확인
  if (saveError) showOpMsg({ text: saveError, kind: "err" });
}

void boot();
