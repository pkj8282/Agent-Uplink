import fs from "node:fs";
import path from "node:path";
import { Channel, Message } from "../shared/protocol.js";
import { Guard, plainGuard } from "./securityLog.js";

interface Entry {
  channel: Channel;
  ring: Message[];
  seq: number;
  file: string;
}

export class ChannelStore {
  private readonly dir: string;
  private readonly ringSize: number;
  private entries = new Map<string, Entry>();

  private readonly guard: Guard;

  constructor(opts: { dir: string; ringSize?: number; guard?: Guard }) {
    this.dir = opts.dir;
    this.guard = opts.guard ?? plainGuard;
    this.ringSize = opts.ringSize ?? 1000;
  }

  /** 채널 로그 파일 경로(등록 여부와 무관). */
  pathOf(kind: Channel["kind"], id: string): string {
    return path.join(this.dir, kind === "dm" ? "dm" : "servers", `${id}.jsonl`);
  }

  private pathFor(ch: Channel): string {
    return this.pathOf(ch.kind, ch.id);
  }

  register(ch: Channel): void {
    const existing = this.entries.get(ch.id);
    if (existing) {
      existing.channel = ch; // 메타 갱신(멱등)
      return;
    }
    const file = this.pathFor(ch);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const entry: Entry = { channel: ch, ring: [], seq: 0, file };
    if (fs.existsSync(file)) {
      const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
      for (const line of lines.slice(-this.ringSize)) {
        try {
          const m = JSON.parse(line) as Message;
          // 디스크 입구(v2.1.2): 보낸 이름과 본문(줄바꿈·탭은 유지)
          const at = { source: "disk" as const, where: "log", account: String(m.from) };
          if (typeof m.fromName === "string") m.fromName = this.guard(m.fromName, { ...at, field: "fromName" });
          if (typeof m.text === "string") m.text = this.guard(m.text, { ...at, field: "text", keepLineBreaks: true });
          entry.ring.push(m);
          if (m.seq > entry.seq) entry.seq = m.seq;
        } catch {
          // 손상 줄 무시
        }
      }
    }
    this.entries.set(ch.id, entry);
  }

  getChannel(id: string): Channel | undefined {
    return this.entries.get(id)?.channel;
  }

  append(channelId: string, from: string, fromName: string, text: string): Message {
    const e = this.entries.get(channelId);
    if (!e) throw new Error(`Channel not found: ${channelId}`);
    const msg: Message = { seq: ++e.seq, ts: Date.now(), channelId, from, fromName, text };
    e.ring.push(msg);
    if (e.ring.length > this.ringSize) e.ring.shift();
    try {
      fs.appendFileSync(e.file, JSON.stringify(msg) + "\n");
    } catch {
      // 디스크 오류 시에도 인메모리 유지
    }
    return msg;
  }

  recent(channelId: string, limit: number): Message[] {
    const e = this.entries.get(channelId);
    if (!e) return [];
    return e.ring.slice(-limit);
  }

  /** 채널 메타·인메모리 로그를 제거한다(라우팅 불가). 로그 파일은 휴지통 이동(trashOps)이 맡는다. */
  unregister(channelId: string): boolean {
    return this.entries.delete(channelId);
  }
}
