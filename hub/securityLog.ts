// 유니코드 스테가노그래피 감독(v2.1.2, 설계 Part C2): 입구 검사기(inspectText)를 Hub 맥락과 묶고,
// 숨은 문자를 바꾼 경우에만 <dataDir>/security/findings.jsonl에 기록한다(최근 max건).
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { clipText, inspectText, escapeControls } from "../shared/controlChars.js";
import { SecurityFinding } from "../shared/protocol.js";
import { writeFileAtomic } from "./fsutil.js";

export interface GuardCtx {
  source: "request" | "disk";
  where: string;
  field: string;
  account?: string;
  /** 메시지 본문: LF·CR·TAB은 정상 문자로 둔다. */
  keepLineBreaks?: boolean;
}

/** 입구 감독: 정리된 값을 돌려준다(발견을 기록할지는 구현에 따름). */
export type Guard = (text: string, ctx: GuardCtx) => string;

/** 기록 없이 정리만 — 스토어 단독 사용(테스트)·자주 다시 읽는 휴지통 메타용. */
export const plainGuard: Guard = (text, ctx) => inspectText(text, { keepLineBreaks: ctx.keepLineBreaks }).text;

export const SECURITY_LOG_MAX = 500;
/** 디스크 발견 키 최대 개수(파일 약 0.7MB). */
export const DISK_SEEN_MAX = 20000;
const PREVIEW_MAX = 80;

const isStr = (v: unknown): v is string => typeof v === "string";

/** 파일에서 읽은 한 줄이 기록 모양인가(손으로 고친 파일·손상 줄 대비). 미리보기도 다시 정리한다. */
function parseFinding(line: string): SecurityFinding | null {
  try {
    const f = JSON.parse(line) as Partial<SecurityFinding>;
    if (typeof f.ts !== "number" || (f.source !== "request" && f.source !== "disk")) return null;
    if (!isStr(f.where) || !isStr(f.field) || !isStr(f.preview) || (f.account !== undefined && !isStr(f.account))) return null;
    if (!f.counts || typeof f.counts !== "object" || !Object.values(f.counts).every((n) => typeof n === "number")) return null;
    return {
      ts: f.ts, source: f.source, where: escapeControls(f.where), field: escapeControls(f.field),
      ...(f.account !== undefined ? { account: escapeControls(f.account) } : {}),
      // 본문 미리보기는 줄바꿈을 그대로 담는다 — 같은 기준으로 다시 정리해야 디스크 중복 판정이 맞는다.
      counts: f.counts as Record<string, number>, preview: inspectText(f.preview, { keepLineBreaks: true }).text,
    };
  } catch {
    return null;
  }
}

/** 디스크 출처 중복 판정 키(위치·항목·계정·미리보기). */
const diskKey = (f: Pick<SecurityFinding, "where" | "field" | "account" | "preview">) =>
  createHash("sha256").update(JSON.stringify([f.where, f.field, f.account ?? "", f.preview])).digest("hex").slice(0, 32);

export class SecurityLog {
  private readonly file: string;
  private readonly seenFile: string;
  private readonly max: number;
  private items: SecurityFinding[] = [];
  /** 파일에 있는 줄 수(압축 시점 판단). */
  private lines = 0;
  /**
   * 이미 기록한 디스크 발견의 키(v2.1.3) — 최근 max건 밖으로 밀려난 옛 데이터도 다시 기록하지 않도록 security/disk-seen.json에 따로 둔다.
   * 메모리 기록만 보면 서로 다른 옛 발견이 max를 넘을 때 Hub를 켤 때마다 다시 기록돼 요청 출처 기록을 밀어낸다.
   */
  private seen = new Set<string>();
  /** 키 상한 — 넘으면 가장 오래 보지 않은 키부터 뺀다(Set은 넣은 순서, 볼 때마다 뒤로 옮긴다). */
  private readonly seenMax: number;
  /** 시작 적재 중인가(그동안은 모아 두었다가 finishStartupScan에서 한 번에 저장, 그 뒤 새 키는 바로 저장). */
  private starting = true;
  private savePending = false;

  constructor(opts: { dir: string; max?: number; seenMax?: number }) {
    this.max = opts.max ?? SECURITY_LOG_MAX;
    this.seenMax = opts.seenMax ?? DISK_SEEN_MAX;
    this.file = path.join(opts.dir, "security", "findings.jsonl");
    this.seenFile = path.join(opts.dir, "security", "disk-seen.json");
    try {
      const s = JSON.parse(fs.readFileSync(this.seenFile, "utf8")) as { v?: unknown; keys?: unknown };
      if (s.v === 1 && Array.isArray(s.keys)) for (const k of s.keys) if (typeof k === "string") this.seen.add(k);
    } catch {
      // 없음·손상 — 아래 기록 속 디스크 발견으로 채운다(v2.1.2 파일 이전)
    }
    try {
      const raw = fs.readFileSync(this.file, "utf8").split("\n").filter(Boolean);
      this.lines = raw.length;
      for (const line of raw) {
        const f = parseFinding(line);
        if (f) this.items.push(f);
      }
      this.items = this.items.slice(-this.max);
      for (const f of this.items) if (f.source === "disk") this.seen.add(diskKey(f));
    } catch {
      // 파일 없음 — 첫 기록 때 만든다
    }
  }

  /** 입구 감독: 정리된 값을 돌려주고, 숨은 문자를 바꿨으면 기록한다. */
  readonly guard: Guard = (text, ctx) => {
    const r = inspectText(text, { keepLineBreaks: ctx.keepLineBreaks });
    if (r.changed) {
      const base = {
        source: ctx.source, where: ctx.where, field: ctx.field,
        ...(ctx.account !== undefined ? { account: escapeControls(ctx.account) } : {}),
        // 경계에 걸린 이모지는 통째로 뺀다 — 중간에서 자르면 날 ZWJ·태그가 남아 디스크 중복 판정이 깨진다.
        preview: clipText(r.text, PREVIEW_MAX),
      };
      // 디스크 출처는 Hub를 시작할 때마다 같은 옛 데이터를 다시 읽는다 — 같은 기록은 한 번만.
      // 받은편지함·복원한 채널처럼 시작 뒤에 읽히는 데이터도 있어, 시작 때 본 키만 남기는 정리는 하지 않는다.
      const key = ctx.source === "disk" ? diskKey(base) : null;
      const known = key !== null && this.seen.delete(key);
      if (!known) this.record({ ts: Date.now(), ...base, counts: r.counts as Record<string, number> });
      if (key) {
        this.seen.add(key); // 본 순서의 맨 뒤로
        if (this.seen.size > this.seenMax) this.seen.delete(this.seen.values().next().value!);
        if (!known && !this.starting) this.scheduleSaveSeen();
      }
    }
    return r.text;
  };

  /** Hub 시작 적재가 끝났다: 그동안 모은 키를 한 번에 저장한다(본 순서도 함께). */
  finishStartupScan(): void {
    if (!this.starting) return;
    this.starting = false;
    this.saveSeen();
  }

  /**
   * 시작 뒤 새 키는 지금 하는 일(예: 받은편지함 하나 적재)이 끝난 뒤 한 번에 저장한다 — 키마다 파일 전체를 다시 쓰면
   * 옛 데이터가 많은 계정이 로그인할 때 이벤트 루프가 멈춘다(v2.1.3 검증 Minor).
   */
  private scheduleSaveSeen(): void {
    if (this.savePending) return;
    this.savePending = true;
    queueMicrotask(() => {
      this.savePending = false;
      this.saveSeen();
    });
  }

  private saveSeen(): void {
    try {
      fs.mkdirSync(path.dirname(this.seenFile), { recursive: true });
      writeFileAtomic(this.seenFile, JSON.stringify({ v: 1, keys: [...this.seen] }));
    } catch {
      // 디스크 오류여도 메모리 판정은 유지
    }
  }

  /** 최근 n건(오래된 것부터). */
  recent(n: number): SecurityFinding[] {
    return this.items.slice(-n);
  }

  private record(f: SecurityFinding): void {
    this.items.push(f);
    if (this.items.length > this.max) this.items.shift();
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      if (this.lines + 1 > this.max * 2) {
        // 무한 증가 방지: 최근 max건만 남기고 원자적으로 다시 쓴다(드물게).
        writeFileAtomic(this.file, this.items.map((x) => JSON.stringify(x)).join("\n") + "\n");
        this.lines = this.items.length;
      } else {
        fs.appendFileSync(this.file, JSON.stringify(f) + "\n");
        this.lines++;
      }
    } catch {
      // 디스크 오류여도 메모리 기록과 정리는 유지
    }
  }
}
