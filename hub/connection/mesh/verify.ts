// 서버 인정용 쌍별 인증 코드(독립 리뷰 M5, 사용자 설계).
// X_YVerify = X가 관리하며 Y를 확인하는 코드. X의 주인이 만들어 Y의 주인에게 직접 건넨다.
// X는 Verify_Management(managed)에 두고 맞춰 보고, Y는 Verify_Code_List(held)에서 꺼내 답한다.
// 중간 서버는 코드를 모른다: 답은 코드 안의 암호화 키로 암호화해 보내고, 질문값·양쪽 ID·답하는 서버의 키를 함께 묶어 재전송·옮겨 쓰기를 막는다.
import fs from "node:fs";
import path from "node:path";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { seal, unseal } from "../../../shared/keywrap.js";
import { writeSecretFile } from "../../fsutil.js";

const PREFIX = "uplink-verify-1.";
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const B64URL_RE = /^[A-Za-z0-9_-]+$/;
const MAX_CODES = 256;

export interface VerifySecrets {
  /** 답을 암호화하는 키(32바이트, base64). */
  enc: string;
  /** 답 안에 넣어 맞춰 보는 확인값(20바이트, base64). */
  check: string;
}

export interface VerifyCode extends VerifySecrets {
  /** 코드를 만든(확인하는) 서버의 망 ID. */
  issuer: string;
  cid: string;
}

export interface VerifyContext {
  verifierId: string;
  proverId: string;
  proverKey: string;
  challenge: string;
}

export interface Sealed {
  nonce: string;
  ct: string;
}

export function newVerifySecrets(): VerifySecrets {
  return { enc: randomBytes(32).toString("base64"), check: randomBytes(20).toString("base64") };
}

export function encodeVerifyCode(c: VerifyCode): string {
  return PREFIX + Buffer.from(JSON.stringify({ i: c.issuer, c: c.cid, e: c.enc, k: c.check }), "utf8").toString("base64url");
}

export function decodeVerifyCode(code: string): VerifyCode | null {
  if (typeof code !== "string" || !code.startsWith(PREFIX)) return null;
  const rest = code.slice(PREFIX.length);
  if (!B64URL_RE.test(rest)) return null;
  try {
    const j = JSON.parse(Buffer.from(rest, "base64url").toString("utf8")) as { i?: unknown; c?: unknown; e?: unknown; k?: unknown };
    if (typeof j.i !== "string" || !ID_RE.test(j.i) || typeof j.c !== "string" || !ID_RE.test(j.c) || typeof j.e !== "string" || typeof j.k !== "string") return null;
    if (Buffer.from(j.e, "base64").length !== 32 || Buffer.from(j.k, "base64").length !== 20) return null;
    return { issuer: j.i, cid: j.c, enc: j.e, check: j.k };
  } catch {
    return null;
  }
}

const aadOf = (cid: string) => `agent-uplink/v3/verify|${cid}`;

export function sealVerifyAnswer(s: VerifySecrets & { cid: string }, ctx: VerifyContext): Sealed {
  return seal(Buffer.from(s.enc, "base64"), aadOf(s.cid), { check: s.check, ...ctx });
}

export function openVerifyAnswer(s: VerifySecrets & { cid: string }, ctx: VerifyContext, sealed: { nonce?: unknown; ct?: unknown }): boolean {
  const o = unseal(Buffer.from(s.enc, "base64"), aadOf(s.cid), sealed) as (Partial<VerifyContext> & { check?: unknown }) | null;
  if (!o || typeof o.check !== "string") return false;
  const want = Buffer.from(s.check, "utf8");
  const got = Buffer.from(o.check, "utf8");
  return want.length === got.length && timingSafeEqual(want, got)
    && o.verifierId === ctx.verifierId && o.proverId === ctx.proverId && o.proverKey === ctx.proverKey && o.challenge === ctx.challenge;
}

interface Managed extends VerifySecrets {
  cid: string;
  label: string;
  createdAt: number;
  /** 처음 맞힌 서버 — 이 코드는 그 서버만 쓸 수 있다. */
  boundTo?: string;
}

interface Held extends VerifySecrets {
  issuer: string;
  cid: string;
  addedAt: number;
}

/** 코드 저장(비밀 파일). 처음 코드가 생길 때까지 파일을 만들지 않는다. */
export class VerifyStore {
  private managed: Managed[] = [];
  private held: Held[] = [];

  constructor(private readonly dir: string) {
    try {
      const j = JSON.parse(fs.readFileSync(this.file, "utf8")) as { verifyManagement?: Managed[]; verifyCodeList?: Held[] };
      if (Array.isArray(j.verifyManagement)) this.managed = j.verifyManagement;
      if (Array.isArray(j.verifyCodeList)) this.held = j.verifyCodeList;
    } catch {
      // 처음
    }
  }

  private get file(): string {
    return path.join(this.dir, "verify.json");
  }

  private save(): void {
    fs.mkdirSync(this.dir, { recursive: true });
    writeSecretFile(this.file, JSON.stringify({ verifyManagement: this.managed, verifyCodeList: this.held }));
  }

  get hasManaged(): boolean {
    return this.managed.length > 0;
  }

  issue(issuer: string, label: string, now: number): string {
    if (this.managed.length >= MAX_CODES) throw new Error("verify_too_many");
    const cid = randomUUID();
    const secrets = newVerifySecrets();
    this.managed.push({ cid, label, createdAt: now, ...secrets });
    this.save();
    return encodeVerifyCode({ issuer, cid, ...secrets });
  }

  /** 받은 코드를 Verify_Code_List에(같은 cid면 바꿈). */
  add(c: VerifyCode, now: number): boolean {
    const rest = this.held.filter((h) => h.cid !== c.cid);
    if (rest.length >= MAX_CODES) return false;
    this.held = [...rest, { issuer: c.issuer, cid: c.cid, enc: c.enc, check: c.check, addedAt: now }];
    this.save();
    return true;
  }

  heldFor(issuer: string): Held | undefined {
    return [...this.held].reverse().find((h) => h.issuer === issuer); // 가장 최근에 받은 코드
  }

  findManaged(cid: string): Managed | undefined {
    return this.managed.find((m) => m.cid === cid);
  }

  bind(cid: string, origin: string): void {
    const m = this.findManaged(cid);
    if (m && m.boundTo !== origin) {
      m.boundTo = origin;
      this.save();
    }
  }

  /** 지운 관리 코드(묶인 서버가 있으면 돌려준다)·없으면 null. */
  removeManaged(cid: string): Managed | null {
    const m = this.findManaged(cid);
    if (!m) return null;
    this.managed = this.managed.filter((x) => x.cid !== cid);
    this.save();
    return m;
  }

  removeHeld(cid: string): boolean {
    if (!this.held.some((h) => h.cid === cid)) return false;
    this.held = this.held.filter((h) => h.cid !== cid);
    this.save();
    return true;
  }

  /** 화면용 목록 — 비밀은 넣지 않는다. */
  list(): { managed: { cid: string; label: string; createdAt: number; boundTo: string | null }[]; held: { cid: string; issuer: string; addedAt: number }[] } {
    return {
      managed: this.managed.map((m) => ({ cid: m.cid, label: m.label, createdAt: m.createdAt, boundTo: m.boundTo ?? null })),
      held: this.held.map((h) => ({ cid: h.cid, issuer: h.issuer, addedAt: h.addedAt })),
    };
  }
}
