import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { writeFileAtomic } from "./fsutil.js";

export interface DmRecord {
  channelId: string;
  members: [string, string];
  label: string;
}

export class DmStore {
  private readonly file: string;
  private records = new Map<string, DmRecord>(); // channelId → record

  constructor(opts: { dir: string }) {
    const dir = path.join(opts.dir, "dm");
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, "index.json");
    if (fs.existsSync(this.file)) {
      try {
        const obj = JSON.parse(fs.readFileSync(this.file, "utf8")) as Record<string, DmRecord>;
        for (const [id, rec] of Object.entries(obj)) this.records.set(id, rec);
      } catch {
        // 손상 시 빈 상태로 시작(개별 DM 로그는 보존됨)
      }
    }
  }

  private save(): void {
    const obj: Record<string, DmRecord> = {};
    for (const [id, rec] of this.records) obj[id] = rec;
    try {
      writeFileAtomic(this.file, JSON.stringify(obj, null, 2));
    } catch {
      // 쓰기 실패해도 메모리 유지
    }
  }

  get(channelId: string): DmRecord | undefined {
    return this.records.get(channelId);
  }

  findByPair(a: string, b: string): DmRecord | undefined {
    for (const rec of this.records.values()) {
      if ((rec.members[0] === a && rec.members[1] === b) || (rec.members[0] === b && rec.members[1] === a)) {
        return rec;
      }
    }
    return undefined;
  }

  create(a: string, b: string, label: string): DmRecord {
    const rec: DmRecord = { channelId: randomUUID(), members: [a, b], label };
    this.records.set(rec.channelId, rec);
    this.save();
    return rec;
  }

  all(): DmRecord[] {
    return [...this.records.values()];
  }

  remove(channelId: string): boolean {
    const existed = this.records.delete(channelId);
    if (existed) this.save();
    return existed;
  }

  byMember(uuid: string): DmRecord[] {
    return [...this.records.values()].filter((r) => r.members[0] === uuid || r.members[1] === uuid);
  }
}
