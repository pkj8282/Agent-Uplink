import fs from "node:fs";
import path from "node:path";
import { Channel, Message, MessageOrigin } from "../shared/protocol.js";
import { Guard, plainGuard } from "./securityLog.js";
import { writeFileAtomic } from "./fsutil.js";

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

  /** file: 로그 파일을 직접 정할 때(v3.0 통신 채널 — connection/ 아래). */
  register(ch: Channel, file?: string): void {
    const existing = this.entries.get(ch.id);
    if (existing) {
      existing.channel = ch; // 메타 갱신(멱등)
      return;
    }
    file ??= this.pathFor(ch);
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
          if (m.origin && typeof m.origin === "object") {
            m.origin = {
              scope: "remote",
              spaceName: this.guard(String(m.origin.spaceName ?? ""), { ...at, field: "spaceName" }),
              hubUser: this.guard(String(m.origin.hubUser ?? ""), { ...at, field: "hubUser" }),
            };
          }
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

  append(channelId: string, from: string, fromName: string, text: string, origin?: MessageOrigin): Message {
    const e = this.entries.get(channelId);
    if (!e) throw new Error(`Channel not found: ${channelId}`);
    const msg: Message = { seq: ++e.seq, ts: Date.now(), channelId, from, fromName, text, ...(origin ? { origin } : {}) };
    e.ring.push(msg);
    if (e.ring.length > this.ringSize) e.ring.shift();
    try {
      fs.appendFileSync(e.file, JSON.stringify(msg) + "\n");
    } catch {
      // 디스크 오류 시에도 인메모리 유지
    }
    return msg;
  }

  /**
   * 원격 거울(v3.0): 통신 서버가 정한 seq를 그대로 저장한다. 이미 가진 seq 이하면 버리고 null(재접속 중복 제거).
   */
  appendExternal(channelId: string, m: Omit<Message, "channelId">): Message | null {
    const e = this.entries.get(channelId);
    if (!e || !Number.isSafeInteger(m.seq) || m.seq <= e.seq) return null;
    const msg: Message = { ...m, channelId };
    e.seq = m.seq;
    e.ring.push(msg);
    if (e.ring.length > this.ringSize) e.ring.shift();
    try {
      fs.appendFileSync(e.file, JSON.stringify(msg) + "\n");
    } catch {
      // 디스크 오류 시에도 인메모리 유지
    }
    return msg;
  }

  /**
   * 로컬 정리(v3.0): keep이 false인 메시지를 로그 파일과 메모리 링에서 지운다. 지운 개수를 돌려준다.
   * 동기 처리라 같은 스레드의 append와 섞이지 않는다. seq는 그대로 이어 간다(지운 뒤에도 다음 seq는 커진다).
   */
  prune(channelId: string, keep: (m: Message) => boolean): number {
    const e = this.entries.get(channelId);
    if (!e) return 0;
    let lines: string[] = [];
    try {
      lines = fs.readFileSync(e.file, "utf8").split("\n").filter(Boolean);
    } catch {
      return 0;
    }
    const out: string[] = [];
    let removed = 0;
    for (const line of lines) {
      let m: Message | null = null;
      try {
        m = JSON.parse(line) as Message;
      } catch {
        // 손상 줄은 그대로 둔다(판단할 수 없으므로 지우지 않음)
      }
      if (m && typeof m.seq === "number" && !keep(m)) removed++;
      else out.push(line);
    }
    if (removed === 0) return 0;
    writeFileAtomic(e.file, out.length ? `${out.join("\n")}\n` : "");
    e.ring = e.ring.filter(keep);
    return removed;
  }

  /** 등록된 채널 ID 목록. */
  ids(): string[] {
    return [...this.entries.keys()];
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
