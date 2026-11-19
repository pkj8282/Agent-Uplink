import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "./fsutil.js";
import { Guard, plainGuard } from "./securityLog.js";
import { InboxItem } from "../shared/protocol.js";

/** 격리 이유(2026-11-20): 채널이 목록에서 빠짐 / Hub 시작 때 없음 / check 때 없음. */
export type QuarantineReason = "channel_removed" | "startup_missing" | "check_missing";

/**
 * 받은편지함 원본 항목. 격리·전달 표시는 Hub 내부용이라 AI에게 줄 때는 publicItem()으로 뺀다.
 * 내부 연산(커서·압축·해제)은 원본(격리 포함) 기준이다.
 */
export interface StoredInboxItem extends InboxItem {
  /** 채널을 확인할 수 없어 보류 중. 채널이 다시 등록되면 떼어 원래 순서로 나온다. */
  quarantined?: { reason: QuarantineReason; at: number };
  /** 커서 뒤에서 이미 처리(전달·버림)한 항목 — 격리 항목 때문에 커서가 멈춰 있을 때만 붙는다. */
  delivered?: true;
}

/** AI에게 보낼 모양(내부 표시 제거). */
export function publicItem(it: StoredInboxItem): InboxItem {
  const { quarantined: _q, delivered: _d, ...rest } = it;
  return rest;
}

interface Box {
  items: StoredInboxItem[]; // seq 오름차순(압축이 전달된 항목을 빼서 중간에 빈칸이 있을 수 있음)
  seq: number; // 지금까지 부여한 최대 seq(compact해도 유지)
  file: string;
}

export class InboxStore {
  private readonly dir: string;
  private boxes = new Map<string, Box>();

  private readonly guard: Guard;

  constructor(opts: { dir: string; guard?: Guard }) {
    this.dir = path.join(opts.dir, "notifications");
    this.guard = opts.guard ?? plainGuard;
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
          const it = JSON.parse(line) as StoredInboxItem;
          // 디스크 입구(v2.1.2): 보낸 이름·채널 라벨·본문(줄바꿈·탭은 유지)
          const at = { source: "disk" as const, where: "inbox", account: uuid };
          if (typeof it.fromName === "string") it.fromName = this.guard(it.fromName, { ...at, field: "fromName" });
          if (typeof it.channelLabel === "string") it.channelLabel = this.guard(it.channelLabel, { ...at, field: "channelLabel" });
          if (typeof it.text === "string") it.text = this.guard(it.text, { ...at, field: "text", keepLineBreaks: true });
          // 내부 표시는 알려진 모양만 받는다(손으로 고친 파일 등)
          const q = it.quarantined as unknown;
          if (q !== undefined && !(q && typeof q === "object" && typeof (q as { reason?: unknown }).reason === "string" && typeof (q as { at?: unknown }).at === "number")) delete it.quarantined;
          if (it.delivered !== undefined && it.delivered !== true) delete it.delivered;
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

  /** afterSeq 뒤의 원본 항목(격리·전달 표시 포함, 같은 객체 — 표시를 바꾸면 save로 저장). */
  since(uuid: string, afterSeq: number, max: number): StoredInboxItem[] {
    const b = this.box(uuid);
    // 압축이 중간 항목을 빼므로 seq가 연속이라고 가정하지 않고 이진 탐색으로 시작 위치를 찾는다.
    let lo = 0, hi = b.items.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (b.items[mid].seq <= afterSeq) lo = mid + 1;
      else hi = mid;
    }
    return b.items.slice(lo, lo + max);
  }

  /** 표시(격리·전달)를 바꾼 뒤 파일을 원자적으로 다시 쓴다. */
  save(uuid: string): void {
    const b = this.box(uuid);
    try {
      writeFileAtomic(b.file, b.items.map((it) => JSON.stringify(it)).join("\n") + (b.items.length ? "\n" : ""));
    } catch {
      // 재작성 실패해도 인메모리는 유지(다음 기회에 재시도)
    }
  }

  /**
   * 원본 관점 압축: 처리가 끝난 항목(belowSeq 이하, 또는 전달 표시)을 버리고 파일을 다시 쓴다(무한 증가 방지).
   * 격리 항목과 아직 주지 않은 항목은 남긴다.
   */
  compact(uuid: string, belowSeq: number): void {
    const b = this.box(uuid);
    const before = b.items.length;
    b.items = b.items.filter((it) => it.seq > belowSeq && !it.delivered);
    if (b.items.length === before) return;
    this.save(uuid);
  }

  /**
   * 번호(seq) 바닥을 올린다. 압축으로 파일이 비면 다시 켤 때 seq를 파일에서 되살릴 수 없어 1부터 다시 매기는데,
   * 그러면 커서(이미 받은 번호)보다 작은 번호의 새 항목이 since()에서 안 보인다 → 시작 때 커서로 바닥을 맞춘다.
   */
  raiseSeq(uuid: string, floor: number): void {
    const b = this.box(uuid);
    if (floor > b.seq) b.seq = floor;
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
