// 삭제·복원·고아 정리: 스토어들을 휴지통 저널(meta.state)로 묶는다. 모든 단계는 멱등이라
// 크래시 후 recoverPending()이 같은 함수를 다시 실행해 마무리한다.
import fs from "node:fs";
import path from "node:path";
import { ChannelStore } from "./channels.js";
import { ServerStore } from "./servers.js";
import { DmStore } from "./dm.js";
import { AccountStore } from "./accounts.js";
import { InboxStore } from "./inbox.js";
import { TrashStore, TrashMeta, isTrashId, isUuidLogName, parseAccountRecord } from "./trash.js";
import { uniqueName } from "./names.js";
import { NameConflict, RestoreReport } from "../shared/protocol.js";
import { hubMsg, type HubKey } from "./messages.js";
import type { Lang } from "../shared/i18n.js";

export type TrashErrorCode = "trash_missing" | "trash_not_restorable" | "trash_bad_id" | "channel_limit" | "trash_busy" | "name_conflict";
export type RestoreResult =
  | { ok: true; report: RestoreReport }
  | { ok: false; code: TrashErrorCode; key: HubKey; params?: object; conflicts?: NameConflict[] };

// 언어 중립: 판단용 code와 문구 키만 돌려준다(문구는 Hub가 현재 언어로 만든다).
const fail = (code: TrashErrorCode, key: HubKey, params?: object, conflicts?: NameConflict[]): RestoreResult =>
  ({ ok: false, code, key, ...(params ? { params } : {}), ...(conflicts ? { conflicts } : {}) });

export interface TrashDeps {
  dataDir: string;
  servers: ServerStore;
  dm: DmStore;
  accounts: AccountStore;
  channels: ChannelStore;
  inbox: InboxStore;
  trash: TrashStore;
  maxChannelsPerServer: () => number;
  /** 콘솔 안내 언어. */
  lang: () => Lang;
}

type By = "admin" | "mcp";

export class TrashOps {
  constructor(private readonly d: TrashDeps) {}

  /** 같은 대상을 다루다 중간에 실패한(state=deleting) 항목. 다시 삭제하면 새 항목 대신 그것을 이어서 끝낸다. */
  private pendingDelete(match: (m: TrashMeta) => boolean): TrashMeta | null {
    for (const it of this.d.trash.list()) {
      const m = this.d.trash.readMeta(it.id);
      if (m && m.state === "deleting" && match(m)) return m;
    }
    return null;
  }

  deleteChannel(channelId: string, by: By): boolean {
    const pending = this.pendingDelete((m) => (m.kind === "channel" || m.kind === "server") && !!m.channels?.some((c) => c.id === channelId));
    if (pending) {
      this.finishDelete(pending);
      return true;
    }
    const found = this.d.servers.findChannel(channelId);
    if (!found) return false;
    const meta = this.d.trash.create("channel", {
      deletedBy: by, name: found.channel.name,
      serverId: found.server.id, serverName: found.server.name,
      channels: [{ id: found.channel.id, name: found.channel.name }],
    });
    this.finishDelete(meta);
    return true;
  }

  deleteServer(serverId: string, by: By): boolean {
    const pending = this.pendingDelete((m) => m.kind === "server" && m.serverId === serverId);
    if (pending) {
      this.finishDelete(pending);
      return true;
    }
    const srv = this.d.servers.getServer(serverId);
    if (!srv) return false;
    const meta = this.d.trash.create("server", {
      deletedBy: by, name: srv.name, serverId: srv.id, serverName: srv.name,
      channels: srv.channels.map((c) => ({ id: c.id, name: c.name })),
    });
    this.finishDelete(meta);
    return true;
  }

  deleteAccount(uuid: string, by: By): boolean {
    const pending = this.pendingDelete((m) => m.kind === "account" && m.account?.uuid === uuid);
    if (pending) {
      this.finishDelete(pending);
      return true;
    }
    const a = this.d.accounts.get(uuid);
    if (!a) return false;
    const dms = this.d.dm.byMember(uuid).map((r) => ({
      channelId: r.channelId,
      peer: r.members[0] === uuid ? r.members[1] : r.members[0],
      label: r.label,
    }));
    const meta = this.d.trash.create("account", { deletedBy: by, name: a.name, account: { uuid }, dms });
    this.finishDelete(meta);
    return true;
  }

  /** 시작 시: 진행 중이던 삭제·복원을 마무리한다(다른 복원·재조정보다 먼저 호출). */
  recoverPending(): void {
    for (const it of this.d.trash.list()) {
      const m = this.d.trash.readMeta(it.id);
      if (!m) continue;
      // 한 항목의 실패(파일 잠김 등)가 Hub 시작 전체를 막지 않게 한다 — 그 항목은 다음 시작이나 재시도 때 마무리.
      try {
        if (m.state === "deleting") this.finishDelete(m);
        else if (m.state === "restoring") this.finishRestore(m);
      } catch (e) {
        process.stderr.write(`${hubMsg(this.d.lang(), "log_trash_defer", { id: m.id, detail: (e as Error).message })}\n`);
      }
    }
  }

  /** 인덱스에 없는 uuid 형식 로그를 orphan 항목으로 옮긴다. 손상된 인덱스 쪽은 opts로 건너뛴다. */
  sweepOrphans(opts: { servers: boolean; dm: boolean }): number {
    const known = {
      servers: new Set(this.d.servers.allChannels().map((c) => c.channelId)),
      dm: new Set(this.d.dm.all().map((r) => r.channelId)),
    };
    let n = 0;
    for (const sub of ["servers", "dm"] as const) {
      if (!opts[sub]) continue;
      let files: string[] = [];
      try {
        files = fs.readdirSync(path.join(this.d.dataDir, sub));
      } catch {
        continue;
      }
      for (const f of files) {
        if (!isUuidLogName(f) || known[sub].has(f.slice(0, -".jsonl".length))) continue;
        const name = `${sub}/${f}`;
        try {
          const meta = this.pendingDelete((m) => m.kind === "orphan" && m.name === name)
            ?? this.d.trash.create("orphan", { deletedBy: "recovery", name });
          this.finishDelete(meta);
          n++;
        } catch (e) {
          process.stderr.write(`${hubMsg(this.d.lang(), "log_orphan_defer", { name, detail: (e as Error).message })}\n`);
        }
      }
    }
    return n;
  }

  private moveLogIn(meta: TrashMeta, kind: "server" | "dm", id: string): void {
    const name = `${id}.jsonl`;
    if (this.d.trash.moveIn(meta.id, this.d.channels.pathOf(kind, id), name) && !meta.files.includes(name)) {
      meta.files.push(name);
    }
  }

  private finishDelete(meta: TrashMeta): void {
    const { trash, channels, servers, dm, accounts, inbox } = this.d;
    switch (meta.kind) {
      case "channel":
      case "server": {
        for (const ch of meta.channels ?? []) {
          channels.unregister(ch.id); // 먼저 라우팅을 끊어 이후 append가 로그를 다시 만들지 않게 한다
          this.moveLogIn(meta, "server", ch.id);
          servers.removeChannel(ch.id);
        }
        if (meta.kind === "server" && meta.serverId) servers.removeServer(meta.serverId);
        break;
      }
      case "account": {
        const uuid = meta.account!.uuid;
        const a = accounts.get(uuid);
        if (a && !meta.files.includes("account.json")) {
          trash.writeFile(meta.id, "account.json", JSON.stringify({
            uuid: a.uuid, name: a.name, createdAt: a.createdAt, description: a.description ?? "",
          }, null, 2));
          meta.files.push("account.json");
          trash.writeMeta(meta); // 계정 원본을 먼저 확보(복원 근거)
        }
        for (const d of meta.dms ?? []) {
          channels.unregister(d.channelId);
          this.moveLogIn(meta, "dm", d.channelId);
          dm.remove(d.channelId);
          accounts.removeDm(d.peer, uuid);
        }
        inbox.remove(uuid);
        accounts.remove(uuid);
        break;
      }
      case "orphan": {
        const [sub, file] = meta.name.split("/");
        if ((sub === "servers" || sub === "dm") && file) {
          if (trash.moveIn(meta.id, path.join(this.d.dataDir, sub, file), file) && !meta.files.includes(file)) {
            meta.files.push(file);
          }
        }
        break;
      }
    }
    meta.state = "done";
    trash.writeMeta(meta);
  }

  /**
   * 휴지통 항목을 복원한다. 무결성(파일 전부 존재)·상태·이름 충돌·채널 한계를 먼저 검사하고(변경 없음),
   * 통과하면 plan(최종 이름)을 저널에 기록한 뒤 finishRestore로 실행한다.
   */
  restore(id: unknown, confirmRename: boolean): RestoreResult {
    if (!isTrashId(id)) return fail("trash_bad_id", "trash_bad_id");
    const meta = this.d.trash.readMeta(id);
    if (!meta) return fail("trash_missing", "trash_missing");
    // 이전 복원이 중간에 실패해 restoring으로 남았으면 기록된 plan대로 이어서 끝낸다(일부 파일은 이미 옮겨져 있음).
    if (meta.state === "restoring") return { ok: true, report: this.finishRestore(meta) };
    if (!this.d.trash.isIntact(meta)) return fail("trash_missing", "trash_missing_or_damaged");
    if (meta.state !== "done") return fail("trash_busy", "trash_finishing");
    if (meta.kind === "orphan") return fail("trash_not_restorable", "trash_not_restorable");

    const renamed: RestoreReport["renamed"] = [];
    if (meta.kind === "channel" || meta.kind === "server") {
      const existing = this.d.servers.getServer(meta.serverId!);
      const conflicts: NameConflict[] = [];
      let serverName = existing?.name ?? meta.serverName!;
      if (!existing) {
        const others = this.d.servers.listServers().map((s) => s.name);
        serverName = uniqueName(meta.serverName!, others);
        if (serverName !== meta.serverName) conflicts.push({ kind: "server", name: meta.serverName!, to: serverName });
      }
      const taken = (existing?.channels ?? []).map((c) => c.name);
      const channelNames: Record<string, string> = {};
      for (const ch of meta.channels ?? []) {
        if (existing?.channels.some((c) => c.id === ch.id)) return fail("trash_busy", "trash_channel_exists");
        const to = uniqueName(ch.name, taken);
        taken.push(to);
        channelNames[ch.id] = to;
        if (to !== ch.name) conflicts.push({ kind: "channel", name: ch.name, to });
      }
      const total = (existing?.channels.length ?? 0) + (meta.channels?.length ?? 0);
      if (total > this.d.maxChannelsPerServer()) {
        return fail("channel_limit", "restore_channel_limit", { max: this.d.maxChannelsPerServer() });
      }
      if (conflicts.length && !confirmRename) return fail("name_conflict", "name_conflict", undefined, conflicts);
      for (const c of conflicts) renamed.push({ kind: c.kind, from: c.name, to: c.to });
      meta.plan = { serverName, channelNames };
    }
    meta.state = "restoring";
    this.d.trash.writeMeta(meta);
    const report = this.finishRestore(meta);
    report.renamed = renamed;
    return { ok: true, report };
  }

  /** 복원 실행(멱등 — 시작 복구가 restoring 항목에 다시 호출한다). */
  private finishRestore(meta: TrashMeta): RestoreReport {
    const { trash, channels, servers, dm, accounts } = this.d;
    const report: RestoreReport = { renamed: [], dmsRestored: 0, dmsLeft: 0, itemRemoved: false };
    if (meta.kind === "channel" || meta.kind === "server") {
      const plan = meta.plan ?? {};
      let srv = servers.getServer(meta.serverId!);
      if (!srv) {
        srv = servers.restoreServer(meta.serverId!, plan.serverName ?? meta.serverName!);
        report.recreatedServer = { id: srv.id, name: srv.name };
      }
      for (const ch of meta.channels ?? []) {
        const name = plan.channelNames?.[ch.id] ?? ch.name;
        const file = `${ch.id}.jsonl`;
        if (meta.files.includes(file)) trash.moveOut(meta.id, file, channels.pathOf("server", ch.id));
        servers.addChannelWithId(srv.id, { id: ch.id, name });
        channels.register({ id: ch.id, kind: "server", label: `${srv.name}/${name}`, members: null });
      }
      trash.remove(meta.id);
      report.itemRemoved = true;
      return report;
    }
    if (meta.kind === "account") {
      const uuid = meta.account!.uuid;
      // 계정이 없으면(처음 복원이든, 일부 복원 뒤 다시 삭제됐든) 원래 정보로 다시 만든다 —
      // 그러지 않으면 아래 setDm이 이름 없는 유령 계정을 만든다.
      if (!accounts.get(uuid)) {
        const rec = parseAccountRecord(trash.readFile(meta.id, "account.json"));
        accounts.restore(rec && rec.uuid === uuid ? rec : { uuid, name: meta.name, createdAt: meta.deletedAt });
      }
      const left: NonNullable<TrashMeta["dms"]> = [];
      for (const d of meta.dms ?? []) {
        const file = `${d.channelId}.jsonl`;
        const already = dm.get(d.channelId); // 크래시 재실행: 이미 붙인 DM
        const canAttach = already || (accounts.get(d.peer) && !dm.findByPair(uuid, d.peer));
        if (!canAttach) {
          left.push(d);
          continue;
        }
        if (meta.files.includes(file)) trash.moveOut(meta.id, file, channels.pathOf("dm", d.channelId));
        if (!already) dm.restore({ channelId: d.channelId, members: [uuid, d.peer], label: d.label });
        channels.register({ id: d.channelId, kind: "dm", label: d.label, members: [uuid, d.peer] });
        accounts.setDm(uuid, d.peer, d.channelId);
        accounts.setDm(d.peer, uuid, d.channelId);
        report.dmsRestored++;
      }
      report.dmsLeft = left.length;
      if (left.length === 0) {
        trash.remove(meta.id);
        report.itemRemoved = true;
        return report;
      }
      // account.json은 남겨 둔다: 계정이 다시 삭제된 뒤 남은 DM을 복원할 때 원래 이름으로 되살리기 위해.
      meta.accountRestored = true;
      meta.dms = left;
      meta.files = [...left.map((d) => `${d.channelId}.jsonl`), "account.json"].filter((f) => trash.has(meta.id, f));
      meta.state = "done";
      trash.writeMeta(meta);
      return report;
    }
    meta.state = "done";
    trash.writeMeta(meta);
    return report;
  }
}
