// 통신 초대 코드(v3.0) — 원문 계획의 "참여 키 3요소(암호 체계·서버 위치·접속 인증서)" + 사용자 이름.
// 형식: "UPLINK1-" + base32(UTF-8 JSON { p: 내용, s: 서버 서명 }). 서명은 p.serverKey로 검증해 위변조(주소·프로필 바꿔치기)를 막고,
// 서버 사칭은 TLS 연결 때 p.serverKey 지문 고정이 막는다.
import { fromBase32, signB64, toBase32, verifyB64 } from "./connCrypto.js";
import { isProfileId, type ProfileId } from "./cryptoProfile.js";

export type Endpoint =
  | { type: "direct"; host: string; port: number }
  | { type: "relay"; relay: string; serverId: string };

export interface InvitePayload {
  v: 1;
  kind: "join";
  spaceId: string;
  spaceName: string;
  profile: ProfileId;
  endpoint: Endpoint;
  serverKey: string;
  token: string;
  expiresAt: number;
  hostUser: string;
  /** 참여자 이름 — 서버 A가 초대 때 정한다(사용자 결정 2026-11-06). 참여자가 보낸 이름은 쓰지 않는다. */
  memberName: string;
}

export type InviteError = "invite_malformed" | "invite_version" | "invite_profile_unknown" | "invite_bad_signature" | "invite_expired";

const PREFIX = "UPLINK";
const VERSION_TAG = "UPLINK1-";
const MAX_CODE_LENGTH = 4096;
const MAX_FIELD = 256;
const SPACE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const isStr = (x: unknown, max = MAX_FIELD): x is string => typeof x === "string" && x.length > 0 && x.length <= max;

/** 서명 대상: 키 순서를 고정한 JSON(같은 내용이면 같은 바이트). */
function canonical(p: InvitePayload): InvitePayload {
  const endpoint: Endpoint = p.endpoint.type === "direct"
    ? { type: "direct", host: p.endpoint.host, port: p.endpoint.port }
    : { type: "relay", relay: p.endpoint.relay, serverId: p.endpoint.serverId };
  return {
    v: p.v, kind: p.kind, spaceId: p.spaceId, spaceName: p.spaceName, profile: p.profile, endpoint,
    serverKey: p.serverKey, token: p.token, expiresAt: p.expiresAt, hostUser: p.hostUser, memberName: p.memberName,
  };
}

function signedBytes(p: InvitePayload): Buffer {
  return Buffer.from(JSON.stringify(canonical(p)), "utf8");
}

export function encodeInvite(p: InvitePayload, serverPrivateKeyPem: string): string {
  const s = signB64(serverPrivateKeyPem, signedBytes(p));
  return VERSION_TAG + toBase32(Buffer.from(JSON.stringify({ p: canonical(p), s }), "utf8"));
}

function validEndpoint(e: unknown): e is Endpoint {
  if (!e || typeof e !== "object") return false;
  const x = e as Record<string, unknown>;
  if (x.type === "direct") {
    return isStr(x.host) && typeof x.port === "number" && Number.isInteger(x.port) && x.port >= 1 && x.port <= 65535;
  }
  if (x.type === "relay") return isStr(x.relay) && isStr(x.serverId);
  return false;
}

export function decodeInvite(code: string, nowMs: number): { ok: true; invite: InvitePayload } | { ok: false; code: InviteError } {
  const bad = (c: InviteError) => ({ ok: false as const, code: c });
  if (typeof code !== "string") return bad("invite_malformed");
  const clean = code.replace(/\s/g, "");
  if (clean.length === 0 || clean.length > MAX_CODE_LENGTH) return bad("invite_malformed");
  if (!clean.startsWith(VERSION_TAG)) return clean.startsWith(PREFIX) ? bad("invite_version") : bad("invite_malformed");
  const raw = fromBase32(clean.slice(VERSION_TAG.length));
  if (!raw) return bad("invite_malformed");
  let body: unknown;
  try {
    body = JSON.parse(raw.toString("utf8"));
  } catch {
    return bad("invite_malformed");
  }
  if (!body || typeof body !== "object") return bad("invite_malformed");
  const { p, s } = body as { p?: unknown; s?: unknown };
  if (!p || typeof p !== "object" || typeof s !== "string") return bad("invite_malformed");
  const q = p as Record<string, unknown>;
  if (q.v !== 1) return bad("invite_version");
  // spaceId는 참여자 PC의 폴더 이름(connection/remote/<spaceId>)이 된다 → 경로에 안전한 문자만(RT-C14).
  if (q.kind !== "join" || typeof q.spaceId !== "string" || !SPACE_ID_RE.test(q.spaceId) || !isStr(q.spaceName) || !validEndpoint(q.endpoint)
    || !isStr(q.serverKey, 1024) || !isStr(q.token) || typeof q.expiresAt !== "number" || !isStr(q.hostUser) || !isStr(q.memberName)) {
    return bad("invite_malformed");
  }
  if (!isProfileId(q.profile)) return bad("invite_profile_unknown");
  const invite = canonical(q as unknown as InvitePayload);
  if (!verifyB64(invite.serverKey, signedBytes(invite), s)) return bad("invite_bad_signature");
  if (invite.expiresAt <= nowMs) return bad("invite_expired");
  return { ok: true, invite };
}
