import fs from "node:fs";
import path from "node:path";
import { Message } from "../shared/protocol.js";

export interface StoreOptions {
  dir: string;
  ringSize?: number;
  rotateBytes?: number;
}

export class MessageStore {
  private ring: Message[] = [];
  private readonly ringSize: number;
  private readonly rotateBytes: number;
  private seq = 0;
  private readonly file: string;

  constructor(opts: StoreOptions) {
    this.ringSize = opts.ringSize ?? 1000;
    this.rotateBytes = opts.rotateBytes ?? 10 * 1024 * 1024;
    this.file = path.join(opts.dir, "messages.jsonl");
    fs.mkdirSync(opts.dir, { recursive: true });
    this.restore();
  }

  private restore(): void {
    if (!fs.existsSync(this.file)) return;
    const lines = fs.readFileSync(this.file, "utf8").split("\n").filter(Boolean);
    for (const line of lines.slice(-Math.max(this.ringSize, 200))) {
      try {
        const m = JSON.parse(line) as Message;
        this.ring.push(m);
        if (m.seq > this.seq) this.seq = m.seq;
      } catch {
        // 손상된 줄은 무시
      }
    }
    if (this.ring.length > this.ringSize) this.ring = this.ring.slice(-this.ringSize);
  }

  append(from: string, to: string | null, text: string): Message {
    const msg: Message = { seq: ++this.seq, ts: Date.now(), from, to, text };
    this.ring.push(msg);
    if (this.ring.length > this.ringSize) this.ring.shift();
    this.writeLine(msg);
    return msg;
  }

  private writeLine(msg: Message): void {
    try {
      if (fs.existsSync(this.file) && fs.statSync(this.file).size > this.rotateBytes) {
        fs.renameSync(this.file, this.file + ".1");
      }
      fs.appendFileSync(this.file, JSON.stringify(msg) + "\n");
    } catch {
      // 디스크 오류 시에도 인메모리 링은 유지한다
    }
  }

  since(afterSeq: number, name: string): Message[] {
    return this.ring.filter(
      (m) => m.seq > afterSeq && m.from !== name && (m.to === null || m.to === name),
    );
  }

  recent(limit: number): Message[] {
    return this.ring.slice(-limit);
  }

  get lastSeq(): number {
    return this.seq;
  }
}
