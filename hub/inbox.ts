import fs from "node:fs";
import path from "node:path";
import { InboxItem } from "../shared/protocol.js";

interface Box {
  items: InboxItem[];
  seq: number;
  file: string;
}

export class InboxStore {
  private readonly dir: string;
  private boxes = new Map<string, Box>();

  constructor(opts: { dir: string }) {
    this.dir = path.join(opts.dir, "notifications");
    fs.mkdirSync(this.dir, { recursive: true });
  }

  private box(uuid: string): Box {
    const found = this.boxes.get(uuid);
    if (found) return found;
    const file = path.join(this.dir, `${uuid}.jsonl`);
    const b: Box = { items: [], seq: 0, file };
    if (fs.existsSync(file)) {
      const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          const it = JSON.parse(line) as InboxItem;
          b.items.push(it);
          if (it.seq > b.seq) b.seq = it.seq;
        } catch {
          // 손상 줄 무시
        }
      }
    }
    this.boxes.set(uuid, b);
    return b;
  }

  append(uuid: string, item: Omit<InboxItem, "seq">): InboxItem {
    const b = this.box(uuid);
    const full: InboxItem = { ...item, seq: ++b.seq };
    b.items.push(full);
    try {
      fs.appendFileSync(b.file, JSON.stringify(full) + "\n");
    } catch {
      // 디스크 오류 시에도 인메모리 유지
    }
    return full;
  }

  since(uuid: string, afterSeq: number, max: number): InboxItem[] {
    const b = this.box(uuid);
    return b.items.filter((it) => it.seq > afterSeq).slice(0, max);
  }

  lastSeq(uuid: string): number {
    return this.box(uuid).seq;
  }
}
