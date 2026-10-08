// 유니코드 스테가노그래피 감독(v2.1.2, 설계 Part C2): 입구 검사기(inspectText)를 Hub 맥락과 묶고,
// 숨은 문자를 바꾼 경우에만 <dataDir>/security/findings.jsonl에 기록한다(최근 max건).
import fs from "node:fs";
import path from "node:path";
import { inspectText, escapeControls } from "../shared/controlChars.js";
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

const sameDiskKey = (a: SecurityFinding, b: Omit<SecurityFinding, "ts" | "counts">) =>
  a.source === "disk" && a.where === b.where && a.field === b.field && a.account === b.account && a.preview === b.preview;

export class SecurityLog {
  private readonly file: string;
  private readonly max: number;
  private items: SecurityFinding[] = [];
  /** 파일에 있는 줄 수(압축 시점 판단). */
  private lines = 0;

  constructor(opts: { dir: string; max?: number }) {
    this.max = opts.max ?? SECURITY_LOG_MAX;
    this.file = path.join(opts.dir, "security", "findings.jsonl");
    try {
      const raw = fs.readFileSync(this.file, "utf8").split("\n").filter(Boolean);
      this.lines = raw.length;
      for (const line of raw) {
        const f = parseFinding(line);
        if (f) this.items.push(f);
      }
      this.items = this.items.slice(-this.max);
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
        preview: [...r.text].slice(0, PREVIEW_MAX).join(""),
      };
      // 디스크 출처는 Hub를 시작할 때마다 같은 옛 데이터를 다시 읽는다 — 같은 기록은 한 번만.
      if (!(ctx.source === "disk" && this.items.some((f) => sameDiskKey(f, base)))) {
        this.record({ ts: Date.now(), ...base, counts: r.counts as Record<string, number> });
      }
    }
    return r.text;
  };

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
