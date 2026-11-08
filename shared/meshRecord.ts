// 방식 3(v3.0 5단계) 망 서명: 기록·목록·명령·중계 요청·경우 알림. 모두 signed.ts 봉투 위에 종류 태그(k)를 넣어
// 한 종류의 서명을 다른 종류로 바꿔 쓸 수 없게 한다. 기록은 (출처 공간, 채널)마다 이어진 사슬(n, prev)을 이룬다(설계 5.4).
import { createHash } from "node:crypto";
import { MAX_STORED_TEXT_LENGTH } from "./protocol.js";
import { canonical, openEnvelope, signEnvelope } from "./signed.js";
import type { SigningKeys } from "./connCrypto.js";

export type MeshKind = "rec" | "cat" | "cmd" | "relay" | "ack" | "case" | "coord" | "vchal" | "vresp" | "bhead";

export interface Signed<T = Record<string, unknown>> {
  body: T & { k: MeshKind };
  signer: string;
  sig: string;
}

/** 망 기록 본문(사슬 한 칸). origin = 출처 통신 서버 공간 ID, n = 사슬 번호(1부터), prev = 직전 기록 해시(첫 칸은 ""). */
export interface RecordBody {
  origin: string;
  ch: string;
  n: number;
  prev: string;
  seq: number;
  ts: number;
  from: string;
  fromName: string;
  hubUser: string;
  /** 중계 쓰기로 들어온 기록이면 거친 서버 공간 이름들. */
  via: string[];
  text: string;
}

/** 망으로 다니는 서명 묶음 하나의 크기 상한(바이트) — 받는 쪽 프레임 상한(1MB) 안에 들어가게. */
export const MAX_SIGNED_BYTES = 512 * 1024;

/** 서명 대상이 아닌 바깥 필드를 버리고 {body, signer, sig}만 새로 만든다. 형식이 틀리면 null. */
export function cleanSigned<T = Record<string, unknown>>(raw: unknown): Signed<T> | null {
  if (!raw || typeof raw !== "object") return null;
  const { body, signer, sig } = raw as { body?: unknown; signer?: unknown; sig?: unknown };
  if (!body || typeof body !== "object" || Array.isArray(body) || typeof signer !== "string" || typeof sig !== "string") return null;
  return { body, signer, sig } as Signed<T>;
}

export function signMesh<T extends object>(kind: MeshKind, body: T, keys: SigningKeys): Signed<T> {
  const b = { ...body, k: kind } as T & { k: MeshKind };
  return JSON.parse(signEnvelope(b, keys.privateKeyPem, keys.publicKeyB64)) as Signed<T>;
}

/** 서명·종류 확인. expectSigner를 주면 그 키로 서명한 것만. 틀리면 null(throw 없음). */
export function openMesh<T = Record<string, unknown>>(kind: MeshKind, obj: unknown, expectSigner?: string): (T & { k: MeshKind }) | null {
  if (!obj || typeof obj !== "object") return null;
  let raw: string;
  try {
    raw = JSON.stringify(obj);
  } catch {
    return null;
  }
  const o = openEnvelope(raw, expectSigner);
  if (!o.ok || o.body.k !== kind) return null;
  return o.body as T & { k: MeshKind };
}

/** 기록 해시(종류 태그 포함 정규화 본문의 SHA-256 hex). 서명은 본문에 묶여 있으므로 본문만 해시한다. */
export function recordHash(b: RecordBody): string {
  return createHash("sha256").update(canonical({ ...b, k: "rec" })).digest("hex");
}

export type ChainResult = "ok" | "dup" | "gap" | "fork";

/** 사슬 확인. head = 이 (출처, 채널)에서 받아들인 마지막 칸. hashAt = 가진 칸의 해시(잘라냈으면 undefined). */
export function checkChain(head: { n: number; hash: string } | undefined, b: RecordBody, hashAt: (n: number) => string | undefined): ChainResult {
  if (!head) return "ok"; // 처음 받는 사슬은 어느 번호에서든 시작(Ruling 2)
  if (b.n <= head.n) {
    const have = hashAt(b.n);
    if (have === undefined) return "dup";
    return have === recordHash(b) ? "dup" : "fork";
  }
  if (b.n === head.n + 1) return b.prev === head.hash ? "ok" : "fork";
  return "gap";
}

const FUTURE_SLACK_MS = 5 * 60_000;
const MAX_VIA = 16;
const isStr = (x: unknown, max: number, allowEmpty = false) => typeof x === "string" && (allowEmpty || x.length > 0) && x.length <= max;
const isPosInt = (x: unknown) => typeof x === "number" && Number.isInteger(x) && x >= 1;

/** 기록 본문 형식·범위(시각이 미래 5분 이내, 글 길이 상한, 번호). */
export function validRecordBody(b: unknown, nowMs: number): b is RecordBody {
  if (!b || typeof b !== "object") return false;
  const x = b as Record<string, unknown>;
  return isStr(x.origin, 64) && isStr(x.ch, 128) && isPosInt(x.n) && isStr(x.prev, 64, true) && isPosInt(x.seq)
    && typeof x.ts === "number" && Number.isFinite(x.ts) && x.ts <= nowMs + FUTURE_SLACK_MS
    && isStr(x.from, 300) && isStr(x.fromName, 256) && isStr(x.hubUser, 256)
    && Array.isArray(x.via) && x.via.length <= MAX_VIA && x.via.every((v) => isStr(v, 256))
    && isStr(x.text, MAX_STORED_TEXT_LENGTH);
}
