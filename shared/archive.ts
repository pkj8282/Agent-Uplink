// 백업 조각 형식(v3.0 3단계): 저장소(GitHub 등)에 올리는 통신 대화 묶음.
// 내용은 공간 열쇠에서 HKDF로 유도한 조각 키로 AEAD 암호화하고(저장소 제공자가 읽지 못함, 설계 5.5),
// 머리에 직전 조각 해시를 넣어 Hub 신원 키로 서명한다(바뀌거나 빠진 조각 감지, 설계 5.4).
//
// 파일: "UPLINKFRAG1" \n 머리 JSON \n 서명(b64) \n 암호문(b64, 태그 포함)
// 서명 대상 = 머리 JSON 바이트 ‖ SHA-256(암호문 b64 문자열). AAD = 머리 JSON 바이트.
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, type CipherGCM, type DecipherGCM } from "node:crypto";
import { signB64, verifyB64 } from "./connCrypto.js";
import { isProfileId, PROFILES, type ProfileId } from "./cryptoProfile.js";
import type { Message } from "./protocol.js";

export const FRAGMENT_MAGIC = "UPLINKFRAG1";
/** 조각 하나의 평문 상한(초과분은 다음 조각으로) — 암호문 b64가 GitHub GET 1MB 한도 안에 들어오게. */
export const MAX_FRAGMENT_PLAINTEXT = 512 * 1024;

export interface FragmentHeader {
  v: 1;
  spaceId: string;
  hubKey: string;
  profile: ProfileId;
  epoch: number;
  index: number;
  /** 직전 조각의 해시(SHA-256 hex). 첫 조각은 "". */
  prevHash: string;
  createdAt: number;
  /** AEAD nonce(12바이트, b64). */
  nonce: string;
}

export interface FragmentBody {
  messages: Message[];
}

export type FragmentError = "frag_malformed" | "frag_bad_signature" | "frag_hub_mismatch" | "frag_decrypt_failed" | "frag_profile_unknown";

const TAG_LEN = 16;

function fragmentKey(spaceKey: Buffer, h: { spaceId: string; epoch: number; index: number }): Buffer {
  return Buffer.from(hkdfSync("sha256", spaceKey, "agent-uplink/v3/frag", `${h.spaceId}/${h.epoch}/${h.index}`, 32));
}

function sigData(headerJson: string, ctB64: string): Buffer {
  return Buffer.concat([Buffer.from(headerJson, "utf8"), createHash("sha256").update(ctB64, "utf8").digest()]);
}

const sha256hex = (b: Buffer) => createHash("sha256").update(b).digest("hex");

export function encodeFragment(o: {
  header: Omit<FragmentHeader, "v" | "nonce">;
  body: FragmentBody;
  spaceKey: Buffer;
  privateKeyPem: string;
}): { bytes: Buffer; hash: string } {
  const nonce = randomBytes(12);
  const header: FragmentHeader = { v: 1, ...o.header, nonce: nonce.toString("base64") };
  const headerJson = JSON.stringify(header);
  const cipher = createCipheriv(PROFILES[header.profile].aead, fragmentKey(o.spaceKey, header), nonce, { authTagLength: TAG_LEN } as never) as unknown as CipherGCM; // GCM·ChaCha20-Poly1305 모두 AEAD(setAAD·getAuthTag)
  cipher.setAAD(Buffer.from(headerJson, "utf8"));
  const ct = Buffer.concat([cipher.update(JSON.stringify(o.body), "utf8"), cipher.final(), cipher.getAuthTag()]);
  const ctB64 = ct.toString("base64");
  const sig = signB64(o.privateKeyPem, sigData(headerJson, ctB64));
  const bytes = Buffer.from([FRAGMENT_MAGIC, headerJson, sig, ctB64].join("\n"), "utf8");
  return { bytes, hash: sha256hex(bytes) };
}

function validHeader(h: unknown): h is Omit<FragmentHeader, "profile"> & { profile: unknown } {
  const x = h as Record<string, unknown>;
  return !!x && typeof x === "object" && x.v === 1 && typeof x.spaceId === "string" && typeof x.hubKey === "string"
    && Number.isSafeInteger(x.epoch) && Number.isSafeInteger(x.index) && (x.index as number) >= 0
    && typeof x.prevHash === "string" && typeof x.createdAt === "number" && typeof x.nonce === "string";
}

export function decodeFragment(bytes: Buffer, o: { spaceKey: Buffer; expectHubKey?: string }):
  { ok: true; header: FragmentHeader; body: FragmentBody; hash: string } | { ok: false; code: FragmentError } {
  const bad = (code: FragmentError) => ({ ok: false as const, code });
  const L = bytes.toString("utf8").split("\n");
  if (L.length !== 4 || L[0] !== FRAGMENT_MAGIC) return bad("frag_malformed");
  const [, headerJson, sig, ctB64] = L;
  let h: unknown;
  try {
    h = JSON.parse(headerJson);
  } catch {
    return bad("frag_malformed");
  }
  if (!validHeader(h)) return bad("frag_malformed");
  if (!isProfileId(h.profile)) return bad("frag_profile_unknown");
  const header = h as FragmentHeader;
  if (o.expectHubKey !== undefined && header.hubKey !== o.expectHubKey) return bad("frag_hub_mismatch");
  let sigOk = false;
  try {
    sigOk = verifyB64(header.hubKey, sigData(headerJson, ctB64), sig);
  } catch {
    sigOk = false;
  }
  if (!sigOk) return bad("frag_bad_signature");
  let body: FragmentBody;
  try {
    const ct = Buffer.from(ctB64, "base64");
    const nonce = Buffer.from(header.nonce, "base64");
    if (ct.length < TAG_LEN || nonce.length !== 12) return bad("frag_malformed");
    const d = createDecipheriv(PROFILES[header.profile].aead, fragmentKey(o.spaceKey, header), nonce, { authTagLength: TAG_LEN } as never) as unknown as DecipherGCM;
    d.setAAD(Buffer.from(headerJson, "utf8"));
    d.setAuthTag(ct.subarray(ct.length - TAG_LEN));
    const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - TAG_LEN)), d.final()]).toString("utf8");
    body = JSON.parse(plain) as FragmentBody;
  } catch {
    return bad("frag_decrypt_failed");
  }
  if (!body || !Array.isArray(body.messages)) return bad("frag_malformed");
  return { ok: true, header, body, hash: sha256hex(bytes) };
}

/**
 * 사슬 검사: 번호마다 이전 번호 조각이 있고 그 해시가 prevHash와 같아야 한다(0번은 prevHash ""). 순서는 상관없다.
 * breaks = 이어지지 않은 조각 번호. 같은 번호가 둘이면(갈라짐) ok:false.
 */
export function checkChain(list: { index: number; prevHash: string; hash: string }[]): { ok: boolean; breaks: number[] } {
  const byIndex = new Map<number, { prevHash: string; hash: string }[]>();
  for (const x of list) byIndex.set(x.index, [...(byIndex.get(x.index) ?? []), x]);
  const breaks: number[] = [];
  let forked = false;
  for (const [index, items] of [...byIndex].sort((a, b) => a[0] - b[0])) {
    if (items.length > 1) forked = true;
    const prev = byIndex.get(index - 1);
    const ok = items.every((it) => (index === 0 ? it.prevHash === "" : !!prev && prev.some((p) => p.hash === it.prevHash)));
    if (!ok || items.length > 1) breaks.push(index);
  }
  return { ok: breaks.length === 0 && !forked, breaks };
}

/**
 * 서명·형식만 확인하고 머리를 돌려준다(복호화하지 않음, v3.0 4단계 방식 1).
 * 열쇠가 없는 옛 세대 조각도 사슬(이전 해시)을 이어 가기 위해 쓴다.
 */
export function peekFragment(bytes: Buffer, expectHubKey: string): { ok: true; header: FragmentHeader; hash: string } | { ok: false; code: FragmentError } {
  const bad = (code: FragmentError) => ({ ok: false as const, code });
  const L = bytes.toString("utf8").split("\n");
  if (L.length !== 4 || L[0] !== FRAGMENT_MAGIC) return bad("frag_malformed");
  let h: unknown;
  try {
    h = JSON.parse(L[1]);
  } catch {
    return bad("frag_malformed");
  }
  if (!validHeader(h)) return bad("frag_malformed");
  if (!isProfileId(h.profile)) return bad("frag_profile_unknown");
  const header = h as FragmentHeader;
  if (header.hubKey !== expectHubKey) return bad("frag_hub_mismatch");
  let ok = false;
  try {
    ok = verifyB64(header.hubKey, sigData(L[1], L[3]), L[2]);
  } catch {
    ok = false;
  }
  return ok ? { ok: true, header, hash: sha256hex(bytes) } : bad("frag_bad_signature");
}

/** 메시지를 조각 평문 상한 안으로 나눈다. */
export function chunkMessages<T>(msgs: T[]): T[][] {
  const out: T[][] = [];
  let cur: T[] = [];
  let size = 0;
  for (const m of msgs) {
    const n = Buffer.byteLength(JSON.stringify(m)) + 1;
    if (cur.length > 0 && size + n > MAX_FRAGMENT_PLAINTEXT) {
      out.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(m);
    size += n;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}
