// 삭제·복원·고아 정리: 스토어들을 휴지통 저널(meta.state)로 묶는다. 모든 단계는 멱등이라
// 크래시 후 recoverPending()이 같은 함수를 다시 실행해 마무리한다.
import path from "node:path";
import { ChannelStore } from "./channels.js";
import { ServerStore } from "./servers.js";
import { DmStore } from "./dm.js";
import { AccountStore } from "./accounts.js";
import { InboxStore } from "./inbox.js";
import { TrashStore, TrashMeta } from "./trash.js";

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

  // 복원은 Task 4에서 구현한다(이 단계에서는 restoring 상태를 만드는 경로가 없다).
  private finishRestore(_meta: TrashMeta): void {}
}
