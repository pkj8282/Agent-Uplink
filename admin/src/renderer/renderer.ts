import type { AdminApi, AdminConfig, ConnStatus, IpcResult, SecurityFinding, Snapshot, SnapshotServer, TrashItem } from "../types.js";
import {
  ConfigFormState, LatestOnly, accountMeta, conflictConfirmMessage, deleteConfirmMessage, displayName, dmCountOf,
  emptyTrashConfirmMessage, emptyTrashTargets, findingCounts, findingSource, formatBytes, memberNames, opErrorMessage, parseConfigForm, restoreConfirmMessage,
  restoreResultMessage, trashFlags, trashKindLabel, trashSummary, trashTitle, unseenCount,
  parseServerForm, parseInviteForm, parseJoinCode, serverEnableConfirmMessage, inviteConfirmMessage, revokeConfirmMessage,
  connEventLine, connErrorMessage, connUnsupportedMessage, saveBlockedMessage, ChangeGate, parseStorageForm, parseSupabaseForm, parseS1CreateForm, parseS1JoinForm, space1StateLabel, space1RevokeConfirm, space1LeaveConfirm, storageStatusLine, verifyResultMessage, parsePruneForm,
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
  connGate.reset();
  setState("loading");
  const [r, c] = await Promise.all([window.admin.snapshot(), window.admin.connStatus()]);
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
  renderSecurity(r.data);
  renderSaveBlocked(r.data);
  renderConn(c);
  lastServers = r.data.servers;
  renderSpace1(c, lastServers);
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
  byId<HTMLButtonElement>("empty-trash").disabled = !s.trash || emptyTrashTargets(s.trash).count === 0;
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
  const leftoverOnly = t.dmLeftover !== undefined;
  showOpMsg(r.ok ? { text: restoreResultMessage(r.data, { leftoverOnly }), kind: "ok" } : { text: opErrorMessage(r.code, r.error), kind: "err" });
}

byId("empty-trash").addEventListener("click", async () => {
  const b = byId<HTMLButtonElement>("empty-trash");
  const target = emptyTrashTargets(trashItems ?? []);
  if (target.count === 0) return;
  if (!window.confirm(emptyTrashConfirmMessage(target.count, target.bytes))) return;
  showOpMsg(null);
  b.disabled = true; // 작업 중 두 번 누르지 않게 — 끝나면 refresh가 다시 정한다
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
    const names = memberNames(d, s.accounts);
    li.append(
      el("span", names, "name"), el("span", d.label, "meta"), el("span", d.channelId, "id"),
      deleteButton(tr("btn_delete_dm"), deleteConfirmMessage({ kind: "dm", names }), () => window.admin.deleteDm(d.channelId)),
    );
    dms.append(li);
  }
}

// --- 저장 멈춤 경고(v3 Minor ①) ---

function renderSaveBlocked(s: Snapshot): void {
  const box = byId("save-blocked");
  const files = s.saveBlocked ?? [];
  box.textContent = files.length > 0 ? saveBlockedMessage(files) : "";
  box.hidden = files.length === 0;
}

// --- 통신(v3.0) ---
// 원격·사용자 데이터(이름·주소·사건 내용)는 textContent로만. 초대 코드는 화면에만 두고 저장하지 않는다.

/** 사용자가 고쳤지만 아직 제출하지 않은 통신 입력 — 새로고침이 덮어쓰지 않는다. */
const connDirty = new Set<Element>();
/** 바뀐 목록만 다시 그린다 — 자동 갱신이 입력 중인 채널 이름·포커스를 지우지 않게. 전체 새로고침은 다시 그린다. */
const connGate = new ChangeGate();
/** 공유 체크를 바꿨지만 저장하지 않은 상태(null = Hub 값대로). */
let pendingShared: Set<string> | null = null;

for (const id of ["conn-user-form", "conn-server-form", "conn-invite-form", "storage-form", "supabase-form", "storage-kind-form", "prune-form", "s1-create-form", "s1-join-form"]) {
  byId(id).addEventListener("input", (e) => { if (e.target instanceof Element) connDirty.add(e.target); });
  byId(id).addEventListener("change", (e) => { if (e.target instanceof Element) connDirty.add(e.target); });
}

function setIfClean(e: HTMLInputElement | HTMLSelectElement, value: string): void {
  if (!connDirty.has(e)) e.value = value;
}

function clearDirty(form: HTMLElement): void {
  for (const e of [...connDirty]) if (form.contains(e)) connDirty.delete(e);
}

/** 통신 작업 공통: 오류는 code로 문구를 고르고, 끝나면 새로고침. */
async function connRun<T>(b: HTMLButtonElement | null, action: () => Promise<IpcResult<T>>, onOk?: (data: T) => string | void): Promise<boolean> {
  showOpMsg(null);
  if (b) b.disabled = true;
  const r = await action();
  // 성공 처리(입력 비우기·공유 대기 해제 등)는 새로고침 전에 — 새로 그린 화면이 그 상태를 따른다.
  const okText = r.ok ? onOk?.(r.data) : undefined;
  if (b) b.disabled = false; // 새로고침 전에 — 상태에 따른 비활성(끄기·초대 버튼)은 새로 그릴 때 정한다
  await refresh();
  if (!r.ok) {
    showOpMsg({ text: tr("conn_failed", { detail: connErrorMessage(r.code, r.error) }), kind: "err" });
    return false;
  }
  showOpMsg({ text: okText || tr("conn_done"), kind: "ok" });
  return true;
}

function renderConn(c: IpcResult<ConnStatus>): void {
  const unsupported = byId("conn-unsupported");
  const body = byId("conn-body");
  if (!c.ok) {
    unsupported.textContent = c.code === "old_hub_no_op" ? connUnsupportedMessage() : tr("conn_failed", { detail: c.error });
    unsupported.hidden = false;
    body.hidden = true;
    return;
  }
  unsupported.hidden = true;
  body.hidden = false;
  const s = c.data;
  const enabled = s.server?.enabled === true;

  setIfClean(byId<HTMLInputElement>("conn-user"), s.userName ?? "");

  const st = byId("conn-server-state");
  st.textContent = enabled && s.server
    ? tr("conn_state_on", { port: s.server.port, profile: s.server.profile }) + (s.server.listening ? "" : tr("conn_state_not_listening"))
    : tr("conn_state_off");
  if (s.server) {
    setIfClean(byId<HTMLInputElement>("conn-port"), String(s.server.port));
    setIfClean(byId<HTMLSelectElement>("conn-profile"), s.server.profile);
    setIfClean(byId<HTMLInputElement>("conn-space"), s.server.spaceName);
    const burn = byId<HTMLInputElement>("conn-burn");
    if (!connDirty.has(burn)) burn.checked = s.server.burnOnJoin;
  }
  byId<HTMLButtonElement>("conn-disable").disabled = !enabled;
  byId<HTMLButtonElement>("conn-inv-submit").disabled = !enabled;
  byId("conn-inv-needs").hidden = enabled;

  // 저장소(백업)
  const sto = s.storage;
  byId("storage-state").textContent = sto ? storageStatusLine(sto) : tr("storage_off");
  for (const id of ["storage-upload", "storage-verify", "storage-clear"]) byId<HTMLButtonElement>(id).disabled = !sto?.configured;
  byId<HTMLButtonElement>("prune-form").querySelector("button")!.disabled = !sto?.configured;
  if (sto?.configured && sto.prune) {
    const pe = byId<HTMLInputElement>("prune-enabled");
    if (!connDirty.has(pe)) pe.checked = sto.prune.enabled;
    setIfClean(byId<HTMLInputElement>("prune-days"), String(sto.prune.days));
  }
  // 연결된 종류를 선택 상자에 반영(사용자가 바꾸는 중이면 그대로).
  const kindSel = byId<HTMLSelectElement>("storage-kind");
  if (sto?.configured && sto.kind && !connDirty.has(kindSel) && kindSel.value !== sto.kind) {
    kindSel.value = sto.kind;
    showStorageKind(sto.kind);
  }
  if (sto?.configured && sto.kind === "supabase") {
    setIfClean(byId<HTMLInputElement>("supabase-url"), sto.url ?? "");
    setIfClean(byId<HTMLInputElement>("supabase-bucket"), sto.bucket ?? "");
    setIfClean(byId<HTMLInputElement>("supabase-interval"), String(sto.intervalMin ?? 5));
  }
  if (sto?.configured && sto.kind !== "supabase") {
    setIfClean(byId<HTMLInputElement>("storage-repo"), sto.repo ?? "");
    setIfClean(byId<HTMLInputElement>("storage-interval"), String(sto.intervalMin ?? 5));
  }

  // 통신 서버·채널 + 공유 체크
  const shared = pendingShared ?? new Set(s.server?.shared ?? []);
  if (connGate.changed("comms", [s.comms, [...shared].sort()])) {
    const comms = byId("conn-comms");
    comms.replaceChildren();
    if (s.comms.length === 0) comms.append(el("li", tr("conn_no_comms"), "empty"));
    for (const srv of s.comms) {
      const li = el("li");
      li.dataset.kind = "conn-server";
      const row = el("div", undefined, "row");
      const share = el("label", undefined, "check");
      const box = el("input");
      box.type = "checkbox";
      box.checked = shared.has(srv.serverId);
      box.addEventListener("change", () => {
        pendingShared ??= new Set(shared);
        if (box.checked) pendingShared.add(srv.serverId);
        else pendingShared.delete(srv.serverId);
      });
      share.append(box, el("span", tr("conn_share")));
      const chName = el("input");
      chName.type = "text";
      chName.maxLength = 64;
      chName.placeholder = tr("conn_new_channel_ph");
      const add = el("button", tr("btn_conn_add_channel"));
      add.type = "button";
      add.addEventListener("click", () => {
        const name = chName.value.trim();
        if (!name) { showOpMsg({ text: tr("form_name_empty"), kind: "err" }); return; }
        void connRun(add, () => window.admin.connCreateChannel(srv.serverId, name));
      });
      row.append(el("span", srv.name, "name"), el("span", srv.serverId, "id"), share, chName, add,
      deleteButton(tr("btn_delete_server"), deleteConfirmMessage({ kind: "server", name: srv.name, channelCount: srv.channels.length }),
        () => window.admin.connDeleteServer(srv.serverId)));
      const sub = el("ul");
      for (const ch of srv.channels) {
        const cli = el("li", undefined, "row");
        cli.dataset.kind = "conn-channel";
        cli.append(el("span", `# ${ch.name}`, "name"), el("span", ch.channelId, "id"),
        deleteButton(tr("btn_delete"), deleteConfirmMessage({ kind: "channel", name: ch.name, serverName: srv.name }),
          () => window.admin.connDeleteChannel(ch.channelId)));
        sub.append(cli);
      }
      li.append(row, sub);
      comms.append(li);
    }
  }

  // 구성원
  if (connGate.changed("members", s.members)) {
    const members = byId("conn-members");
    members.replaceChildren();
    if (s.members.length === 0) members.append(el("li", tr("conn_no_members"), "empty"));
    for (const m of s.members) {
      const li = el("li", undefined, "row");
      li.dataset.kind = "conn-member";
      const state = m.revoked ? tr("conn_member_revoked") : m.online ? tr("conn_member_online") : tr("conn_member_offline");
      li.append(
        el("span", m.userName, "name"),
        el("span", `${new Date(m.joinedAt).toLocaleString(localeOf(getLang()))} · ${state}`, m.online && !m.revoked ? "meta online" : "meta"),
      );
      if (!m.revoked) {
        const b = el("button", tr("btn_conn_revoke"), "danger");
        b.type = "button";
        b.addEventListener("click", () => {
          if (!window.confirm(revokeConfirmMessage(m.userName))) return;
          void connRun(b, () => window.admin.connRevoke(m.memberId));
        });
        li.append(b);
      }
      members.append(li);
    }
  }

  // 참여한 공간
  if (connGate.changed("joined", s.joined)) {
    const joined = byId("conn-joined");
    joined.replaceChildren();
    if (s.joined.length === 0) joined.append(el("li", tr("conn_no_joined"), "empty"));
    for (const j of s.joined) {
      const li = el("li", undefined, "row");
      li.dataset.kind = "conn-joined";
      li.append(
        el("span", j.spaceName, "name"),
        el("span", tr("conn_joined_meta", { host: j.hostUser, state: tr(j.connected ? "conn_connected" : "conn_disconnected") }), j.connected ? "meta online" : "meta"),
      );
      joined.append(li);
    }
  }

  // 최근 통신 사건(최근이 위)
  if (connGate.changed("events", s.events)) {
    const events = byId("conn-events");
    events.replaceChildren();
    if (s.events.length === 0) events.append(el("li", tr("conn_no_events"), "empty"));
    for (const e of [...s.events].reverse()) {
      const li = el("li", undefined, "row");
      li.dataset.kind = "conn-event";
      li.append(el("span", new Date(e.ts).toLocaleString(localeOf(getLang())), "meta"), el("span", connEventLine(e), "name"));
      events.append(li);
    }
  }
}

// 통신 탭 자동 갱신: 탭이 보이고 화면이 준비됐을 때 2초마다 통신 상태만 다시 받는다(다른 PC 쪽 변화 — 참여·끊김·퇴출).
// 전체 새로고침(로딩·inert)은 하지 않는다. Hub가 꺼졌으면 전체 새로고침으로 넘겨 hubdown 화면을 띄운다.
let connPolling = false;
setInterval(async () => {
  if (connPolling || document.hidden || (byId("tab-conn").hidden && byId("tab-space1").hidden) || document.body.dataset.state !== "ready") return;
  connPolling = true;
  try {
    const t = snapshotSeq.begin();
    const r = await window.admin.connStatus();
    if (!snapshotSeq.isLatest(t) || document.body.dataset.state !== "ready") return; // 그사이 전체 새로고침이 시작됨
    if (!r.ok && r.hubDown) { void refresh(); return; }
    renderConn(r);
    renderSpace1(r, lastServers);
  } finally {
    connPolling = false;
  }
}, 2000);

// --- 공간(방식 1, v3.0 4단계) ---

let lastServers: SnapshotServer[] = [];

function renderSpace1(c: IpcResult<ConnStatus>, servers: SnapshotServer[]): void {
  // 공유할 로컬 서버 고르기(바뀌었을 때만 다시 — 고른 값 유지)
  const sel = byId<HTMLSelectElement>("s1-server");
  if (connGate.changed("s1servers", servers.map((s) => [s.id, s.name]))) {
    const keep = sel.value;
    sel.replaceChildren(...servers.map((s) => { const o = el("option", s.name); o.value = s.id; return o; }));
    if (servers.some((s) => s.id === keep)) sel.value = keep;
  }
  const list = byId("s1-list");
  if (!c.ok) {
    if (connGate.changed("s1", c.error)) list.replaceChildren(el("li", c.code === "old_hub_no_op" ? connUnsupportedMessage() : tr("conn_failed", { detail: c.error }), "empty"));
    return;
  }
  const spaces = c.data.spaces1;
  if (!connGate.changed("s1", spaces)) return;
  list.replaceChildren();
  if (spaces.length === 0) list.append(el("li", tr("s1_no_spaces"), "empty"));
  for (const sp of spaces) {
    const li = el("li");
    li.dataset.kind = "s1-space";
    const row = el("div", undefined, "row");
    const at = sp.lastSyncAt ? new Date(sp.lastSyncAt).toLocaleString(localeOf(getLang())) : tr("s1_never");
    row.append(el("span", sp.spaceName, "name"), el("span", space1StateLabel(sp.role, sp.state), sp.state === "active" ? "meta online" : "meta"), el("span", tr("s1_meta", { repo: sp.repo, epoch: sp.epoch, at }), "meta"));
    if (sp.lastError) row.append(el("span", connErrorMessage(sp.lastError, sp.lastError), "flag"));
    const sync = el("button", tr("btn_s1_sync"));
    sync.type = "button";
    sync.addEventListener("click", () => void connRun(sync, () => window.admin.connS1SyncNow(sp.spaceId)));
    row.append(sync);
    if (sp.role === "owner" && sp.state === "active") {
      const label = el("input");
      label.type = "text";
      label.maxLength = 64;
      label.placeholder = tr("s1_invite_label_ph");
      const inv = el("button", tr("btn_s1_invite"));
      inv.type = "button";
      inv.addEventListener("click", () => {
        const name = label.value.trim();
        if (!name) { showOpMsg({ text: tr("form_label_invalid"), kind: "err" }); return; }
        void connRun(inv, () => window.admin.connS1Invite(sp.spaceId, name, 7 * 86_400_000), (code) => {
          byId<HTMLTextAreaElement>("s1-invite-code").value = code;
          byId("s1-invite-copy-msg").textContent = "";
          byId("s1-invite-out").hidden = false;
        });
      });
      row.append(label, inv);
    }
    const leave = el("button", tr("btn_s1_leave"), "danger");
    leave.type = "button";
    leave.addEventListener("click", () => {
      if (!window.confirm(space1LeaveConfirm(sp.spaceName))) return;
      void connRun(leave, () => window.admin.connS1Leave(sp.spaceId));
    });
    row.append(leave);
    const sub = el("ul");
    for (const m of sp.members) {
      const mli = el("li", undefined, "row");
      mli.dataset.kind = "s1-member";
      mli.append(el("span", `${m.userName}${m.me ? ` ${tr("s1_me")}` : ""}`, "name"), el("span", m.hubId, "id"));
      if (m.revoked) mli.append(el("span", tr("s1_state_revoked"), "flag"));
      else if (sp.role === "owner" && !m.me) {
        const b = el("button", tr("btn_s1_revoke"), "danger");
        b.type = "button";
        b.addEventListener("click", () => {
          if (!window.confirm(space1RevokeConfirm(m.userName))) return;
          void connRun(b, () => window.admin.connS1Revoke(sp.spaceId, m.hubId));
        });
        mli.append(b);
      }
      sub.append(mli);
    }
    li.append(row, sub);
    list.append(li);
  }
}

byId("s1-invite-copy").addEventListener("click", () => void copyBox("s1-invite-code", "s1-invite-copy-msg"));

byId<HTMLFormElement>("s1-create-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const tokenBox = byId<HTMLInputElement>("s1-token");
  const parsed = parseS1CreateForm({
    spaceName: byId<HTMLInputElement>("s1-name").value, localServerId: byId<HTMLSelectElement>("s1-server").value,
    repo: byId<HTMLInputElement>("s1-repo").value, token: tokenBox.value, intervalSec: byId<HTMLInputElement>("s1-interval").value,
  });
  if (!parsed.ok) { showOpMsg({ text: parsed.error, kind: "err" }); return; }
  clearDirty(byId("s1-create-form"));
  void connRun(submitter(e), () => window.admin.connS1Create(parsed.value), () => { tokenBox.value = ""; byId<HTMLInputElement>("s1-name").value = ""; });
});

byId<HTMLFormElement>("s1-join-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const tokenBox = byId<HTMLInputElement>("s1-join-token");
  const codeBox = byId<HTMLTextAreaElement>("s1-join-code");
  const parsed = parseS1JoinForm({ code: codeBox.value, token: tokenBox.value });
  if (!parsed.ok) { showOpMsg({ text: parsed.error, kind: "err" }); return; }
  clearDirty(byId("s1-join-form"));
  void connRun(submitter(e), () => window.admin.connS1Join(parsed.value), () => { tokenBox.value = ""; codeBox.value = ""; return tr("s1_join_ok"); });
});

function submitter(e: SubmitEvent): HTMLButtonElement | null {
  return e.submitter instanceof HTMLButtonElement ? e.submitter : null;
}

byId<HTMLFormElement>("conn-user-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const name = byId<HTMLInputElement>("conn-user").value.trim();
  if (!name) { showOpMsg({ text: tr("form_name_empty"), kind: "err" }); return; }
  clearDirty(byId("conn-user-form"));
  void connRun(submitter(e), () => window.admin.connSetUser(name));
});

byId<HTMLFormElement>("conn-server-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const parsed = parseServerForm({
    port: byId<HTMLInputElement>("conn-port").value,
    profile: byId<HTMLSelectElement>("conn-profile").value,
    spaceName: byId<HTMLInputElement>("conn-space").value,
    burnOnJoin: byId<HTMLInputElement>("conn-burn").checked,
  });
  if (!parsed.ok) { showOpMsg({ text: parsed.error, kind: "err" }); return; }
  // IP 경고(설계 5.6-1): 켜기 전에 확인받는다.
  if (!window.confirm(serverEnableConfirmMessage(parsed.value.port))) return;
  clearDirty(byId("conn-server-form"));
  void connRun(submitter(e), () => window.admin.connEnableServer(parsed.value));
});

byId("conn-disable").addEventListener("click", () => {
  if (!window.confirm(tr("conn_disable_confirm"))) return;
  void connRun(byId<HTMLButtonElement>("conn-disable"), () => window.admin.connDisableServer());
});

byId<HTMLFormElement>("conn-add-server-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = byId<HTMLInputElement>("conn-new-server");
  const name = input.value.trim();
  if (!name) { showOpMsg({ text: tr("form_name_empty"), kind: "err" }); return; }
  void connRun(submitter(e), () => window.admin.connCreateServer(name), () => { input.value = ""; });
});

byId("conn-save-shared").addEventListener("click", () => {
  const ids = pendingShared ? [...pendingShared] : null;
  if (!ids) { showOpMsg({ text: tr("conn_done"), kind: "ok" }); return; }
  void connRun(byId<HTMLButtonElement>("conn-save-shared"), () => window.admin.connSetShared(ids), () => { pendingShared = null; });
});

byId<HTMLFormElement>("conn-invite-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const parsed = parseInviteForm({
    label: byId<HTMLInputElement>("conn-inv-label").value,
    host: byId<HTMLInputElement>("conn-inv-host").value,
    days: byId<HTMLInputElement>("conn-inv-days").value,
  });
  if (!parsed.ok) { showOpMsg({ text: parsed.error, kind: "err" }); return; }
  // IP 경고(설계 5.6-1): 초대를 만들 때마다 확인받는다.
  if (!window.confirm(inviteConfirmMessage(parsed.value.label, parsed.value.host))) return;
  void connRun(submitter(e), () => window.admin.connCreateInvite(parsed.value), (d) => {
    byId<HTMLTextAreaElement>("conn-inv-code").value = d.code;
    byId("conn-inv-copy-msg").textContent = "";
    byId("conn-inv-out").hidden = false;
    byId<HTMLInputElement>("conn-inv-label").value = "";
  });
});

/** 읽기 전용 상자의 내용을 복사한다(실패하면 선택해 두고 직접 복사하라고 알림). */
async function copyBox(areaId: string, msgId: string): Promise<void> {
  const area = byId<HTMLTextAreaElement>(areaId);
  const m = byId(msgId);
  let ok = false;
  try {
    await navigator.clipboard.writeText(area.value);
    ok = true;
  } catch {
    area.select();
    try { ok = document.execCommand("copy"); } catch { ok = false; }
  }
  m.textContent = tr(ok ? "copied" : "copy_failed");
  m.className = `msg ${ok ? "ok" : "err"}`;
}

byId("storage-recovery-copy").addEventListener("click", () => void copyBox("storage-recovery-key", "storage-recovery-msg"));

function showRecoveryKey(key: string): void {
  byId<HTMLTextAreaElement>("storage-recovery-key").value = key;
  byId("storage-recovery-msg").textContent = "";
  byId("storage-recovery").hidden = false;
}

byId<HTMLFormElement>("prune-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const parsed = parsePruneForm({ enabled: byId<HTMLInputElement>("prune-enabled").checked, days: byId<HTMLInputElement>("prune-days").value });
  if (!parsed.ok) { showOpMsg({ text: parsed.error, kind: "err" }); return; }
  // 켤 때만 확인창(휴지통을 거치지 않는 삭제).
  if (parsed.value.enabled && !window.confirm(tr("prune_confirm", { days: parsed.value.days }))) return;
  clearDirty(byId("prune-form"));
  void connRun(submitter(e), () => window.admin.connStoragePruneSet(parsed.value));
});

/** 저장소 종류에 맞는 입력만 보여 준다(GitHub: 저장소·토큰·주기 / Supabase: 별도 폼). 지금 올리기·검증·해제 버튼은 공통. */
function showStorageKind(kind: string): void {
  const supa = kind === "supabase";
  byId("supabase-form").hidden = !supa;
  byId("storage-form").querySelectorAll<HTMLElement>("label").forEach((l) => { l.hidden = supa; });
  byId("storage-form").querySelector<HTMLButtonElement>("button[type=submit]")!.hidden = supa;
}

byId<HTMLSelectElement>("storage-kind").addEventListener("change", (e) => showStorageKind((e.target as HTMLSelectElement).value));
showStorageKind(byId<HTMLSelectElement>("storage-kind").value); // 처음 화면도 고른 종류의 칸만

byId<HTMLFormElement>("supabase-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const keyBox = byId<HTMLInputElement>("supabase-key");
  const parsed = parseSupabaseForm({
    url: byId<HTMLInputElement>("supabase-url").value, key: keyBox.value,
    bucket: byId<HTMLInputElement>("supabase-bucket").value, intervalMin: byId<HTMLInputElement>("supabase-interval").value,
  });
  if (!parsed.ok) { showOpMsg({ text: parsed.error, kind: "err" }); return; }
  clearDirty(byId("supabase-form"));
  clearDirty(byId("storage-kind-form"));
  void connRun(submitter(e), () => window.admin.connStorageSetSupabase(parsed.value), (d) => {
    keyBox.value = ""; // 키는 화면에 남기지 않는다
    showRecoveryKey(d.recoveryKey);
  });
});

byId<HTMLFormElement>("storage-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const tokenBox = byId<HTMLInputElement>("storage-token");
  const parsed = parseStorageForm({ repo: byId<HTMLInputElement>("storage-repo").value, token: tokenBox.value, intervalMin: byId<HTMLInputElement>("storage-interval").value });
  if (!parsed.ok) { showOpMsg({ text: parsed.error, kind: "err" }); return; }
  clearDirty(byId("storage-form"));
  void connRun(submitter(e), () => window.admin.connStorageSet(parsed.value), (d) => {
    tokenBox.value = ""; // 토큰은 화면에 남기지 않는다
    showRecoveryKey(d.recoveryKey);
  });
});

byId("storage-upload").addEventListener("click", () => {
  void connRun(byId<HTMLButtonElement>("storage-upload"), () => window.admin.connStorageUploadNow(), (d) => tr("storage_uploaded_ok", d));
});

byId("storage-verify").addEventListener("click", () => {
  const out = byId("storage-verify-result");
  out.textContent = "";
  void connRun(byId<HTMLButtonElement>("storage-verify"), () => window.admin.connStorageVerify(), (d) => {
    out.textContent = verifyResultMessage(d);
    return verifyResultMessage(d);
  });
});

byId("storage-clear").addEventListener("click", () => {
  if (!window.confirm(tr("storage_clear_confirm"))) return;
  void connRun(byId<HTMLButtonElement>("storage-clear"), () => window.admin.connStorageClear(), () => { byId("storage-recovery").hidden = true; });
});

byId("conn-inv-copy").addEventListener("click", async () => {
  const area = byId<HTMLTextAreaElement>("conn-inv-code");
  const m = byId("conn-inv-copy-msg");
  let ok = false;
  try {
    await navigator.clipboard.writeText(area.value);
    ok = true;
  } catch {
    area.select();
    try { ok = document.execCommand("copy"); } catch { ok = false; }
  }
  m.textContent = tr(ok ? "copied" : "copy_failed");
  m.className = `msg ${ok ? "ok" : "err"}`;
});

byId<HTMLFormElement>("conn-join-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const area = byId<HTMLTextAreaElement>("conn-join-code");
  const code = parseJoinCode(area.value);
  if (!code) { showOpMsg({ text: tr("form_code_empty"), kind: "err" }); return; }
  void connRun(submitter(e), () => window.admin.connJoin(code), () => { area.value = ""; return tr("conn_joined_ok"); });
});

// --- 보안 기록(v2.1.2) ---

let securityFindings: SecurityFinding[] | undefined;
const SEEN_KEY = "agent-uplink.securitySeen";

/** 마지막으로 보안 탭을 본 시각(이 관리 앱의 저장소). 읽을 수 없으면 0 — 모두 새 기록으로 본다. */
function lastSeen(): number {
  try { return Number(localStorage.getItem(SEEN_KEY)) || 0; } catch { return 0; }
}

function updateBadge(): void {
  const n = unseenCount(securityFindings, lastSeen());
  const b = byId("security-badge");
  b.textContent = String(n);
  b.hidden = n === 0;
}

function markSecuritySeen(): void {
  const latest = Math.max(0, ...(securityFindings ?? []).map((f) => f.ts));
  try { localStorage.setItem(SEEN_KEY, String(latest)); } catch { /* 저장 못 해도 표시만 영향 */ }
  updateBadge();
}

function renderSecurity(s: Snapshot): void {
  securityFindings = s.findings;
  const list = byId("security-list");
  list.replaceChildren();
  if (!s.findings) list.append(el("li", tr("security_unsupported"), "empty"));
  else if (s.findings.length === 0) list.append(el("li", tr("security_empty"), "empty"));
  else {
    for (const f of [...s.findings].reverse()) { // 최근 기록이 위
      const li = el("li", undefined, "row");
      li.dataset.kind = "finding";
      li.append(
        el("span", new Date(f.ts).toLocaleString(localeOf(getLang())), "meta"),
        el("span", findingSource(f, s.accounts), "name"),
        el("span", findingCounts(f.counts), "flag"),
        el("span", displayName(f.preview, 80), "desc"),
      );
      list.append(li);
    }
  }
  if (byId("tab-security").hidden) updateBadge();
  else markSecuritySeen();
}

function selectTab(name: string): void {
  for (const b of document.querySelectorAll<HTMLButtonElement>("[data-tab]")) {
    b.setAttribute("aria-selected", String(b.dataset.tab === name));
  }
  for (const p of document.querySelectorAll<HTMLElement>(".panel")) p.hidden = p.id !== `tab-${name}`;
  byId("lang-bar").hidden = name !== "settings";
  if (name === "security") markSecuritySeen();
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
  for (const e of document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("[data-i18n-ph]")) e.placeholder = tr(e.dataset.i18nPh as AdminKey);
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
  // 이미 표시된 문구도 새 언어로: 폼 상태 문구는 다시 만들고, 다시 만들 수 없는 것(실패 문구·지난 작업 결과)은 지운다.
  const fm = formState.message();
  if (fm) showFormMessage(fm);
  else showFormMessage({ text: "", kind: "ok" });
  showOpMsg(null);
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
