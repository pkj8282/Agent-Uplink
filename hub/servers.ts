import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { writeFileAtomic } from "./fsutil.js";

export interface ServerChannel {
  id: string;
  name: string;
}

export interface ServerRecord {
  id: string;
  name: string;
  channels: ServerChannel[];
}

export class ServerStore {
  private readonly file: string;
  private servers = new Map<string, ServerRecord>();

  constructor(opts: { dir: string }) {
    const dir = path.join(opts.dir, "servers");
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, "index.json");
    if (fs.existsSync(this.file)) {
      try {
        const obj = JSON.parse(fs.readFileSync(this.file, "utf8")) as Record<string, ServerRecord>;
        for (const [id, rec] of Object.entries(obj)) {
          rec.channels ??= [];
          this.servers.set(id, rec);
        }
      } catch {
        // 손상 시 빈 상태(개별 채널 로그는 보존됨)
      }
    }
  }

  private save(): void {
    const obj: Record<string, ServerRecord> = {};
    for (const [id, rec] of this.servers) obj[id] = rec;
    try {
      writeFileAtomic(this.file, JSON.stringify(obj, null, 2));
    } catch {
      // 쓰기 실패해도 메모리 유지
    }
  }

  createServer(name: string): ServerRecord {
    const rec: ServerRecord = { id: randomUUID(), name, channels: [] };
    this.servers.set(rec.id, rec);
    this.save();
    return rec;
  }

  getServer(serverId: string): ServerRecord | undefined {
    return this.servers.get(serverId);
  }

  listServers(): ServerRecord[] {
    return [...this.servers.values()];
  }

  addChannel(serverId: string, name: string): ServerChannel {
    const srv = this.servers.get(serverId);
    if (!srv) throw new Error(`서버가 없습니다: ${serverId}`);
    const ch: ServerChannel = { id: randomUUID(), name };
    srv.channels.push(ch);
    this.save();
    return ch;
  }

  channelCount(serverId: string): number {
    return this.servers.get(serverId)?.channels.length ?? 0;
  }

  findChannel(channelId: string): { server: ServerRecord; channel: ServerChannel } | undefined {
    for (const server of this.servers.values()) {
      const channel = server.channels.find((c) => c.id === channelId);
      if (channel) return { server, channel };
    }
    return undefined;
  }

  removeChannel(channelId: string): boolean {
    for (const server of this.servers.values()) {
      const i = server.channels.findIndex((c) => c.id === channelId);
      if (i >= 0) {
        server.channels.splice(i, 1);
        this.save();
        return true;
      }
    }
    return false;
  }

  removeServer(serverId: string): boolean {
    const existed = this.servers.delete(serverId);
    if (existed) this.save();
    return existed;
  }

  allChannels(): { channelId: string; serverName: string; channelName: string }[] {
    const out: { channelId: string; serverName: string; channelName: string }[] = [];
    for (const server of this.servers.values()) {
      for (const ch of server.channels) {
        out.push({ channelId: ch.id, serverName: server.name, channelName: ch.name });
      }
    }
    return out;
  }
}
