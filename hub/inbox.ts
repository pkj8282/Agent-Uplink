import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "./fsutil.js";
import { InboxItem } from "../shared/protocol.js";

interface Box {
  items: InboxItem[]; // seq 오름차순, 연속(앞에서 compact로 잘려도 내부는 연속)
  seq: number; // 지금까지 부여한 최대 seq(compact해도 유지)
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
    if (b.items.length === 0) return [];
    // seq가 연속이므로 필터 없이 오프셋으로 시작 위치를 계산한다(O(max)).
    const firstSeq = b.items[0].seq;
    const start = Math.max(0, afterSeq - firstSeq + 1);
    if (start >= b.items.length) return [];
    return b.items.slice(start, start + max);
  }

  /** belowSeq 이하(이미 소비된) 항목을 버리고 파일을 원자적으로 다시 쓴다(무한 증가 방지). */
  compact(uuid: string, belowSeq: number): void {
    const b = this.box(uuid);
    const before = b.items.length;
    b.items = b.items.filter((it) => it.seq > belowSeq);
    if (b.items.length === before) return;
    try {
      writeFileAtomic(b.file, b.items.map((it) => JSON.stringify(it)).join("\n") + (b.items.length ? "\n" : ""));
    } catch {
      // 재작성 실패해도 인메모리는 유지(다음 기회에 재시도)
    }
  }

  size(uuid: string): number {
    return this.box(uuid).items.length;
  }

  lastSeq(uuid: string): number {
    return this.box(uuid).seq;
  }

  remove(uuid: string): void {
    this.boxes.delete(uuid);
    try {
      fs.rmSync(path.join(this.dir, `${uuid}.jsonl`), { force: true });
    } catch {
      // 파일 삭제 실패해도 메모리에서는 제거됨
    }
  }
}
