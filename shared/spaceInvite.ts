// 방식 1 초대·참여 요청(v3.0 4단계): 서버가 없으므로 초대 코드에 서버 위치 대신 저장소 위치(GitHub owner/name)를 담는다.
// 초대는 관리자 Hub가 서명. 참여 요청은 요청자 Hub가 서명하고, 초대 토큰으로 만든 HMAC 증명을 담는다 —
// 증명에 요청자 공개키가 들어가므로 엿본 요청을 다른 Hub가 다시 쓸 수 없다. 토큰 원문은 저장소에 올리지 않는다.
import { isWrapPublicKey } from "./keywrap.js";
import { createHmac, timingSafeEqual } from "node:crypto";
import { fromBase32, signB64, toBase32, verifyB64, type SigningKeys } from "./connCrypto.js";
import { openEnvelope, signEnvelope } from "./signed.js";

export interface SpaceInvite {
  v: 1;
  kind: "space1";
  spaceId: string;
  spaceName: string;
  repo: string;
  branch?: string;
  ownerKey: string;
  inviteId: string;
  token: string;
  expiresAt: number;
  memberName: string;
  hostUser: string;
}

export type SpaceInviteError = "invite_malformed" | "invite_version" | "invite_bad_signature" | "invite_expired" | "invite_not_space";

const TAG = "UPLINKS1-";
const MAX_CODE = 4096;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const BRANCH_RE = /^[\w./-]{1,255}$/;
const isStr = (x: unknown, max = 256): x is string => typeof x === "string" && x.length > 0 && x.length <= max;

function canonical(p: SpaceInvite): SpaceInvite {
  return {
    v: 1, kind: "space1", spaceId: p.spaceId, spaceName: p.spaceName, repo: p.repo, ...(p.branch ? { branch: p.branch } : {}),
    ownerKey: p.ownerKey, inviteId: p.inviteId, token: p.token, expiresAt: p.expiresAt, memberName: p.memberName, hostUser: p.hostUser,
  };
}

const bytes = (p: SpaceInvite) => Buffer.from(`agent-uplink/v3/space1-invite\n${JSON.stringify(canonical(p))}`, "utf8");

export function encodeSpaceInvite(p: SpaceInvite, ownerPrivateKeyPem: string): string {
  return TAG + toBase32(Buffer.from(JSON.stringify({ p: canonical(p), s: signB64(ownerPrivateKeyPem, bytes(p)) }), "utf8"));
}

export function decodeSpaceInvite(code: string, nowMs: number): { ok: true; invite: SpaceInvite } | { ok: false; code: SpaceInviteError } {
  const bad = (c: SpaceInviteError) => ({ ok: false as const, code: c });
  if (typeof code !== "string") return bad("invite_malformed");
  const clean = code.replace(/\s/g, "");
  if (!clean || clean.length > MAX_CODE) return bad("invite_malformed");
  if (!clean.startsWith(TAG)) {
    if (/^UPLINKS\d+-/.test(clean)) return bad("invite_version");
    return clean.startsWith("UPLINK") ? bad("invite_not_space") : bad("invite_malformed");
  }
  const raw = fromBase32(clean.slice(TAG.length));
  if (!raw) return bad("invite_malformed");
  let body: { p?: unknown; s?: unknown };
  try {
    body = JSON.parse(raw.toString("utf8"));
  } catch {
    return bad("invite_malformed");
  }
  const q = body?.p as Record<string, unknown> | undefined;
  if (!q || typeof body.s !== "string") return bad("invite_malformed");
  if (q.v !== 1) return bad("invite_version");
  // spaceId는 PC의 폴더 이름이 되므로 경로에 안전한 문자만(RT-C14와 같은 규칙).
  if (q.kind !== "space1" || typeof q.spaceId !== "string" || !ID_RE.test(q.spaceId) || !isStr(q.spaceName) || typeof q.repo !== "string" || !REPO_RE.test(q.repo)
    || q.repo.endsWith("/.") || q.repo.endsWith("/..") || (q.branch !== undefined && (typeof q.branch !== "string" || !BRANCH_RE.test(q.branch)))
    || !isStr(q.ownerKey, 1024) || typeof q.inviteId !== "string" || !ID_RE.test(q.inviteId) || !isStr(q.token) || typeof q.expiresAt !== "number"
    || !isStr(q.memberName) || !isStr(q.hostUser)) {
    return bad("invite_malformed");
  }
  const invite = canonical(q as unknown as SpaceInvite);
  if (!verifyB64(invite.ownerKey, bytes(invite), body.s)) return bad("invite_bad_signature");
  if (invite.expiresAt <= nowMs) return bad("invite_expired");
  return { ok: true, invite };
}

/** 참여 증명: HMAC-SHA256(토큰, 공간·초대·요청자 공개키·X25519 공개키). */
export function joinProof(token: string, spaceId: string, inviteId: string, hubKey: string, xKey: string): string {
  return createHmac("sha256", token).update(`join|${spaceId}|${inviteId}|${hubKey}|${xKey}`).digest("base64");
}

export interface JoinRequest { v: 1; spaceId: string; inviteId: string; hubKey: string; xKey: string; proof: string; ts: number }

/** 참여 요청 파일(요청자 서명 봉투). */
export function makeJoinRequest(inv: SpaceInvite, keys: SigningKeys, xKey: string, ts: number): string {
  const body: JoinRequest = { v: 1, spaceId: inv.spaceId, inviteId: inv.inviteId, hubKey: keys.publicKeyB64, xKey, proof: joinProof(inv.token, inv.spaceId, inv.inviteId, keys.publicKeyB64, xKey), ts };
  return signEnvelope(body as unknown as object, keys.privateKeyPem, keys.publicKeyB64);
}

/** 관리자가 요청을 확인: 요청자 서명(서명자 = 본문 hubKey) + 그 초대의 토큰으로 만든 증명. */
export function readJoinRequest(raw: string, spaceId: string, tokenOf: (inviteId: string) => string | null): { ok: true; req: JoinRequest } | { ok: false } {
  const env = openEnvelope(raw);
  if (!env.ok) return { ok: false };
  const b = env.body as Partial<JoinRequest>;
  if (b.v !== 1 || b.spaceId !== spaceId || typeof b.inviteId !== "string" || typeof b.hubKey !== "string" || b.hubKey !== env.signer
    || typeof b.xKey !== "string" || !isWrapPublicKey(b.xKey) || typeof b.proof !== "string" || typeof b.ts !== "number") return { ok: false };
  const token = tokenOf(b.inviteId);
  if (!token) return { ok: false };
  const want = Buffer.from(joinProof(token, spaceId, b.inviteId, b.hubKey, b.xKey));
  const got = Buffer.from(b.proof);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return { ok: false };
  return { ok: true, req: b as JoinRequest };
}
