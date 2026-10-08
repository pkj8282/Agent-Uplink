import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { backupCorrupt, writeFileAtomic } from "./fsutil.js";
import { escapeControls } from "../shared/controlChars.js";

export interface DmRecord {
  channelId: string;
  members: [string, string];
  label: string;
}

export class DmStore {
  private readonly file: string;
  private records = new Map<string, DmRecord>(); // channelId → record
  /** index.json을 읽지 못했는가(계정 역색인으로 재구성 — recovery.ts). */
  corrupt = false;

  constructor(opts: { dir: string }) {
    const dir = path.join(opts.dir, "dm");
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, "index.json");
    if (fs.existsSync(this.file)) {
      try {
        const obj = JSON.parse(fs.readFileSync(this.file, "utf8")) as Record<string, DmRecord>;
        for (const [id, rec] of Object.entries(obj)) {
          if (rec && typeof rec.label === "string") rec.label = escapeControls(rec.label); // 디스크 입구(v2.1.2)
          this.records.set(id, rec);
        }
      } catch {
        // 손상: 원본을 보존하고 빈 상태로 시작 → Hub가 계정 역색인으로 재구성한다(개별 DM 로그는 보존)
        backupCorrupt(this.file);
        this.corrupt = true;
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

  /** 복원: 지정 레코드를 넣는다(같은 channelId가 있으면 무시). */
  restore(rec: DmRecord): void {
    if (this.records.has(rec.channelId)) return;
    this.records.set(rec.channelId, { channelId: rec.channelId, members: [rec.members[0], rec.members[1]], label: rec.label });
    this.save();
  }

  /** 손상 복구: 전체를 교체하고 저장한다. */
  replaceAll(recs: DmRecord[]): void {
    this.records = new Map(recs.map((r) => [r.channelId, r]));
    this.save();
  }

  byMember(uuid: string): DmRecord[] {
    return [...this.records.values()].filter((r) => r.members[0] === uuid || r.members[1] === uuid);
  }
}
