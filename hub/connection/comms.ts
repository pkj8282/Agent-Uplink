// Connection Communications(v3.0): 통신 서버가 공유할 수 있는 통신 전용 서버·채널. 로컬 서버와 따로 connection/comms/에 저장한다.
// 처음 쓸 때만 폴더를 만든다(통신을 안 켠 Hub에는 흔적 없음).
import fs from "node:fs";
import path from "node:path";
import { ServerStore, type ServerRecord } from "../servers.js";
import type { Guard } from "../securityLog.js";
import type { SharedServer } from "../../shared/connProtocol.js";

export class CommsStore {
  private readonly dir: string;
  private store: ServerStore | null = null;

  constructor(private readonly opts: { dataDir: string; guard: Guard }) {
    this.dir = path.join(opts.dataDir, "connection", "comms");
  }

  /** 이미 통신 서버가 있으면(폴더가 있으면) 연다. 없으면 만들지 않는다. */
  private open(create: boolean): ServerStore | null {
    if (this.store) return this.store;
    if (!create && !fs.existsSync(path.join(this.dir, "servers"))) return null;
    this.store = new ServerStore({ dir: this.dir, guard: this.opts.guard });
    return this.store;
  }

  /** 채널 로그 파일 위치. */
  logPath(channelId: string): string {
    return path.join(this.dir, "servers", `${channelId}.jsonl`);
  }

  createServer(name: string): ServerRecord {
    return this.open(true)!.createServer(name);
  }

  addChannel(serverId: string, name: string): { id: string; name: string } {
    return this.open(true)!.addChannel(serverId, name);
  }

  getServer(serverId: string): ServerRecord | undefined {
    return this.open(false)?.getServer(serverId);
  }

  servers(): ServerRecord[] {
    return this.open(false)?.listServers() ?? [];
  }

  findChannel(channelId: string): { server: ServerRecord; channel: { id: string; name: string } } | undefined {
    return this.open(false)?.findChannel(channelId);
  }

  /** 공유 목록에 든 서버만 프로토콜 형태로. */
  shared(serverIds: string[]): SharedServer[] {
    const want = new Set(serverIds);
    return this.servers()
      .filter((s) => want.has(s.id))
      .map((s) => ({ serverId: s.id, name: s.name, channels: s.channels.map((c) => ({ channelId: c.id, name: c.name })) }));
  }
}
