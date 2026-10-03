import type { AdminApi, AdminConfig, IpcResult, Snapshot } from "../types.js";
import { deleteConfirmMessage, dmCountOf, memberNames, parseConfigForm } from "./view.js";

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

async function refresh(): Promise<void> {
  const r = await window.admin.snapshot();
  if (!r.ok) {
    document.body.dataset.state = r.hubDown ? "hubdown" : "error";
    showBanner(r.hubDown ? r.error : `불러오기 실패: ${r.error}`);
    return;
  }
  document.body.dataset.state = "ready";
  showBanner("");
  renderConfig(r.data.config);
  renderServers(r.data);
  renderAccounts(r.data);
}

function renderConfig(c: AdminConfig): void {
  byId<HTMLInputElement>("cfg-max").value = String(c.maxChannelsPerServer);
  byId<HTMLInputElement>("cfg-batch").value = String(c.inboxMaxBatch);
  byId<HTMLInputElement>("cfg-dev-delete").checked = c.allowDevDelete;
}

/** 확인 대화상자 → 삭제 → 새로고침. 실패 사유는 새로고침 뒤에 배너로 남긴다. */
function deleteButton(label: string, confirmText: string, action: () => Promise<IpcResult<void>>): HTMLButtonElement {
  const b = el("button", label, "danger");
  b.type = "button";
  b.addEventListener("click", async () => {
    if (!window.confirm(confirmText)) return;
    b.disabled = true;
    const r = await action();
    await refresh();
    if (!r.ok) showBanner(`삭제 실패: ${r.error}`);
  });
  return b;
}

function renderServers(s: Snapshot): void {
  const list = byId("server-list");
  list.replaceChildren();
  if (s.servers.length === 0) { list.append(el("li", "서버가 없습니다.", "empty")); return; }
  for (const srv of s.servers) {
    const li = el("li");
    li.dataset.kind = "server";
    const row = el("div", undefined, "row");
    row.append(
      el("span", srv.name, "name"),
      el("span", srv.id, "id"),
      el("span", `채널 ${srv.channels.length}`, "meta"),
      deleteButton("서버 삭제", deleteConfirmMessage({ kind: "server", name: srv.name, channelCount: srv.channels.length }),
        () => window.admin.deleteServer(srv.id)),
    );
    const sub = el("ul");
    for (const ch of srv.channels) {
      const cli = el("li", undefined, "row");
      cli.dataset.kind = "channel";
      cli.append(
        el("span", `# ${ch.name}`, "name"),
        el("span", ch.id, "id"),
        deleteButton("삭제", deleteConfirmMessage({ kind: "channel", name: ch.name, serverName: srv.name }),
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
  if (s.accounts.length === 0) accounts.append(el("li", "계정이 없습니다.", "empty"));
  for (const a of s.accounts) {
    const n = dmCountOf(a.uuid, s.dms);
    const li = el("li", undefined, "row");
    li.dataset.kind = "account";
    li.append(
      el("span", a.name, "name"),
      el("span", a.uuid, "id"),
      el("span", `DM ${n}`, "meta"),
      deleteButton("계정 삭제", deleteConfirmMessage({ kind: "account", name: a.name, uuid: a.uuid, dmCount: n }),
        () => window.admin.deleteAccount(a.uuid)),
    );
    accounts.append(li);
  }
  const dms = byId("dm-list");
  dms.replaceChildren();
  if (s.dms.length === 0) dms.append(el("li", "DM이 없습니다.", "empty"));
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

byId("refresh").addEventListener("click", () => {
  document.body.dataset.state = "loading";
  void refresh();
});

byId<HTMLFormElement>("config-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = byId("config-msg");
  const parsed = parseConfigForm({
    maxChannelsPerServer: byId<HTMLInputElement>("cfg-max").value,
    inboxMaxBatch: byId<HTMLInputElement>("cfg-batch").value,
    allowDevDelete: byId<HTMLInputElement>("cfg-dev-delete").checked,
  });
  if (!parsed.ok) { msg.textContent = parsed.error; msg.className = "msg err"; return; }
  const r = await window.admin.setConfig(parsed.patch);
  if (!r.ok) { msg.textContent = `저장 실패: ${r.error}`; msg.className = "msg err"; return; }
  msg.textContent = "저장했습니다(즉시 반영).";
  msg.className = "msg ok";
  await refresh();
});

void refresh();
