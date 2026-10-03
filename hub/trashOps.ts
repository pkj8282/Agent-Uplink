// 삭제·복원·고아 정리: 스토어들을 휴지통 저널(meta.state)로 묶는다. 모든 단계는 멱등이라
// 크래시 후 recoverPending()이 같은 함수를 다시 실행해 마무리한다.
import path from "node:path";
import { ChannelStore } from "./channels.js";
import { ServerStore } from "./servers.js";
import { DmStore } from "./dm.js";
import { AccountStore } from "./accounts.js";
import { InboxStore } from "./inbox.js";
import { TrashStore, TrashMeta, isTrashId } from "./trash.js";
import { uniqueName } from "./names.js";
import { NameConflict, RestoreReport } from "../shared/protocol.js";

export type TrashErrorCode = "trash_missing" | "trash_not_restorable" | "trash_bad_id" | "channel_limit" | "trash_busy" | "name_conflict";
export type RestoreResult =
  | { ok: true; report: RestoreReport }
  | { ok: false; code: TrashErrorCode; error: string; conflicts?: NameConflict[] };

const fail = (code: TrashErrorCode, error: string, conflicts?: NameConflict[]): RestoreResult =>
  conflicts ? { ok: false, code, error, conflicts } : { ok: false, code, error };

export interface TrashDeps {
  dataDir: string;
  servers: ServerStore;
  dm: DmStore;
  accounts: AccountStore;
  channels: ChannelStore;
  inbox: InboxStore;
  trash: TrashStore;
  maxChannelsPerServer: () => number;
}

type By = "admin" | "mcp";

export class TrashOps {
  constructor(private readonly d: TrashDeps) {}

  deleteChannel(channelId: string, by: By): boolean {
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
      if (m.state === "deleting") this.finishDelete(m);
      else if (m.state === "restoring") this.finishRestore(m);
    }
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
    if (!isTrashId(id)) return fail("trash_bad_id", "잘못된 휴지통 항목 ID입니다.");
    const meta = this.d.trash.readMeta(id);
    if (!meta || !this.d.trash.isIntact(meta)) return fail("trash_missing", "휴지통 항목 파일이 없습니다(이미 지워진 것 같습니다).");
    if (meta.state !== "done") return fail("trash_busy", "이 항목은 처리 중입니다. Hub를 재시작한 뒤 다시 시도하세요.");
    if (meta.kind === "orphan") return fail("trash_not_restorable", "고아 로그는 복원할 위치 정보가 없습니다.");

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
        if (existing?.channels.some((c) => c.id === ch.id)) return fail("trash_busy", "같은 채널이 이미 있습니다.");
        const to = uniqueName(ch.name, taken);
        taken.push(to);
        channelNames[ch.id] = to;
        if (to !== ch.name) conflicts.push({ kind: "channel", name: ch.name, to });
      }
      const total = (existing?.channels.length ?? 0) + (meta.channels?.length ?? 0);
      if (total > this.d.maxChannelsPerServer()) {
        return fail("channel_limit", `복원하면 서버당 채널 수 한계(${this.d.maxChannelsPerServer()})를 넘습니다.`);
      }
      if (conflicts.length && !confirmRename) return fail("name_conflict", "같은 이름이 이미 있습니다.", conflicts);
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
      if (!meta.accountRestored && !accounts.get(uuid)) {
        const raw = trash.readFile(meta.id, "account.json");
        const rec = raw ? (JSON.parse(raw) as { uuid: string; name: string; createdAt: number; description?: string }) : null;
        accounts.restore(rec ?? { uuid, name: meta.name, createdAt: meta.deletedAt });
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
      trash.deleteFile(meta.id, "account.json");
      meta.accountRestored = true;
      meta.dms = left;
      meta.files = left.map((d) => `${d.channelId}.jsonl`).filter((f) => trash.has(meta.id, f));
      meta.state = "done";
      trash.writeMeta(meta);
      return report;
    }
    meta.state = "done";
    trash.writeMeta(meta);
    return report;
  }
}
