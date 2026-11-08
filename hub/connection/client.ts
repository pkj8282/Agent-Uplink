// 통신 참여자 클라이언트(v3.0): 다른 PC의 통신 서버에 붙는 쪽.
// 서버 인증서는 자체 서명이라 CA 체인으로 믿을 수 없다 → rejectUnauthorized는 끄되, 이 파일의 checkPeer()가
// 초대 코드의 서버 공개키 지문(SPKI SHA-256)·TLS 1.3·프로필 암호를 확인하기 전에는 한 바이트도 보내지 않는다(공개키 고정).
import tls from "node:tls";
import { createHash } from "node:crypto";
import { boundedWrite, CONN_WRITE_QUEUE } from "../../shared/boundedWrite.js";
import { encodeFrame, FrameDecoder } from "../../shared/framing.js";
import { signB64, spkiFingerprint, type SigningKeys } from "../../shared/connCrypto.js";
import { PROFILES, type ProfileId } from "../../shared/cryptoProfile.js";
import { CONN_EKM_LABEL, CONN_MAGIC, authSigData, joinSigData, type ConnEvent, type ConnRequestBody } from "../../shared/connProtocol.js";
import type { InvitePayload } from "../../shared/invite.js";
import type { JoinedSpace } from "./store.js";

export type ConnectError = "relay_unsupported" | "pin_mismatch" | "cipher_mismatch" | "tls_failed" | "unreachable" | "timeout";
export type JoinError = ConnectError | "join_failed";

/** 서버가 보내는 이벤트·응답은 메시지 상한(이스케이프 뒤 131,072자 ≈ 최대 512KB) + 여유. */
const CLIENT_MAX_FRAME = 4 * 1024 * 1024;

interface Channel {
  sock: tls.TLSSocket;
  req(r: ConnRequestBody): Promise<any>;
  ekm: string;
}

/** 공개키 고정·버전·암호 확인. 맞지 않으면 오류 코드. */
function checkPeer(sock: tls.TLSSocket, serverKey: string, profile: ProfileId): ConnectError | null {
  const cert = sock.getPeerX509Certificate();
  if (!cert) return "pin_mismatch";
  const fp = createHash("sha256").update(cert.publicKey.export({ type: "spki", format: "der" })).digest("hex");
  if (fp !== spkiFingerprint(serverKey)) return "pin_mismatch";
  if (sock.getProtocol() !== "TLSv1.3" || sock.getCipher().standardName !== PROFILES[profile].tlsCipher) return "cipher_mismatch";
  return null;
}

export interface PinnedSocket {
  sock: tls.TLSSocket;
  ekm: string;
  /** 받은 프레임 처리기를 단다(달기 전에 온 프레임은 모아 뒀다가 넘긴다). */
  onFrame(fn: (f: any) => void): void;
}

/** 공개키 고정 TLS 소켓(프레임 단위). 서버 연결(방식 3)은 이 위에 양방향 채널을 올린다. */
export function openPinnedSocket(
  target: { endpoint: InvitePayload["endpoint"]; serverKey: string; profile: ProfileId },
  timeoutMs: number,
  maxFrame = CLIENT_MAX_FRAME,
): Promise<{ ok: true; ps: PinnedSocket } | { ok: false; code: ConnectError }> {
  const ep = target.endpoint;
  if (ep.type !== "direct") return Promise.resolve({ ok: false, code: "relay_unsupported" });
  return new Promise((resolve) => {
    let settled = false;
    const done = (r: { ok: true; ps: PinnedSocket } | { ok: false; code: ConnectError }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!r.ok) sock.destroy();
      resolve(r);
    };
    const sock = tls.connect({
      host: ep.host,
      port: ep.port,
      rejectUnauthorized: false, // 체인 대신 checkPeer()의 공개키 고정 — 통과 전 쓰기 없음
      minVersion: "TLSv1.3",
      maxVersion: "TLSv1.3",
      ciphers: PROFILES[target.profile].tlsCipher,
    });
    const timer = setTimeout(() => done({ ok: false, code: "timeout" }), timeoutMs);
    sock.once("error", (e: NodeJS.ErrnoException) => {
      const code = e.code ?? "";
      done({ ok: false, code: code.startsWith("ERR_SSL") || code.startsWith("ERR_TLS") ? "tls_failed" : "unreachable" });
    });
    sock.once("secureConnect", () => {
      const bad = checkPeer(sock, target.serverKey, target.profile);
      if (bad) return done({ ok: false, code: bad });
      sock.on("error", () => {});
      const dec = new FrameDecoder({ maxFrame });
      let handler: ((f: any) => void) | null = null;
      const queued: any[] = [];
      sock.on("data", (chunk: Buffer) => {
        try {
          dec.push(chunk, (f: any) => { if (handler) handler(f); else queued.push(f); });
        } catch {
          sock.destroy();
        }
      });
      const ekm = sock.exportKeyingMaterial(32, CONN_EKM_LABEL, Buffer.alloc(0)).toString("base64");
      done({
        ok: true,
        ps: { sock, ekm, onFrame: (fn) => { handler = fn; for (const f of queued.splice(0)) fn(f); } },
      });
    });
  });
}

/** 고정된 TLS 연결을 연다. onEvent는 id 없는 프레임(서버 이벤트)을 받는다. */
function openPinned(
  target: { endpoint: InvitePayload["endpoint"]; serverKey: string; profile: ProfileId },
  timeoutMs: number,
  onEvent: (e: ConnEvent) => void,
): Promise<{ ok: true; ch: Channel } | { ok: false; code: ConnectError }> {
  return openPinnedSocket(target, timeoutMs).then((o) => {
    if (!o.ok) return o;
    const { sock, ekm } = o.ps;
    const pending = new Map<number, (r: any) => void>();
    let next = 1;
    o.ps.onFrame((f: any) => {
      if (f && typeof f.id === "number") {
        const p = pending.get(f.id);
        if (p) { pending.delete(f.id); p(f); }
      } else if (f && typeof f.event === "string") {
        onEvent(f as ConnEvent);
      }
    });
    sock.once("close", () => {
      for (const p of pending.values()) p({ ok: false, code: "connection_lost" });
      pending.clear();
    });
    return {
      ok: true as const,
      ch: {
        sock,
        ekm,
        req: (r: ConnRequestBody) => new Promise((res) => {
          if (sock.destroyed) return res({ ok: false, code: "connection_lost" });
          const id = next++;
          pending.set(id, res);
          boundedWrite(sock, encodeFrame({ ...r, id }), CONN_WRITE_QUEUE);
        }),
      },
    };
  });
}

/** 초대 코드로 처음 참여한다. 성공하면 저장할 참여 공간 정보. */
export async function joinSpace(
  invite: InvitePayload,
  keys: SigningKeys,
  userName: string,
  timeoutMs = 10_000,
): Promise<{ ok: true; space: JoinedSpace } | { ok: false; code: JoinError }> {
  const o = await openPinned(invite, timeoutMs, () => {});
  if (!o.ok) return o;
  try {
    const h = await o.ch.req({ op: "c_hello" });
    if (!h.ok || h.magic !== CONN_MAGIC || typeof h.challenge !== "string") return { ok: false, code: "join_failed" };
    const sig = signB64(keys.privateKeyPem, joinSigData(h.challenge, o.ch.ekm, invite.token, keys.publicKeyB64));
    const r = await o.ch.req({ op: "c_join", token: invite.token, hubKey: keys.publicKeyB64, userName, sig });
    if (!r.ok || typeof r.memberId !== "string") return { ok: false, code: "join_failed" };
    return {
      ok: true,
      space: {
        spaceId: invite.spaceId,
        spaceName: typeof r.spaceName === "string" && r.spaceName ? r.spaceName : invite.spaceName,
        endpoint: invite.endpoint,
        serverKey: invite.serverKey,
        profile: invite.profile,
        memberId: r.memberId,
        hostUser: invite.hostUser,
      },
    };
  } finally {
    o.ch.sock.destroy();
  }
}

export interface ConnClientOptions {
  space: JoinedSpace;
  keys: SigningKeys;
  onEvent(e: ConnEvent): void;
  onState(s: "connected" | "disconnected"): void;
  onError?(code: string): void;
  backoffMs?: number[];
  timeoutMs?: number;
}

export class ConnClient {
  private ch: Channel | null = null;
  private stopped = true;
  private attempt = 0;
  private timer: NodeJS.Timeout | null = null;
  private readonly backoff: number[];

  constructor(private readonly opts: ConnClientOptions) {
    this.backoff = opts.backoffMs && opts.backoffMs.length > 0 ? opts.backoffMs : [1000, 2000, 5000, 10_000, 30_000];
  }

  get connected(): boolean {
    return this.ch !== null;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.connectOnce();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const ch = this.ch;
    this.ch = null;
    ch?.sock.destroy();
  }

  async request(req: ConnRequestBody): Promise<any> {
    if (!this.ch) return { ok: false, code: "connection_lost" };
    return this.ch.req(req);
  }

  private schedule(): void {
    if (this.stopped) return;
    const wait = this.backoff[Math.min(this.attempt, this.backoff.length - 1)];
    this.attempt++;
    this.timer = setTimeout(() => { this.timer = null; void this.connectOnce(); }, wait);
  }

  private async connectOnce(): Promise<void> {
    if (this.stopped) return;
    const sp = this.opts.space;
    const o = await openPinned(sp, this.opts.timeoutMs ?? 10_000, (e) => this.opts.onEvent(e));
    if (this.stopped) { if (o.ok) o.ch.sock.destroy(); return; }
    if (!o.ok) {
      this.opts.onError?.(o.code);
      this.schedule();
      return;
    }
    const h = await o.ch.req({ op: "c_hello" });
    const a = h.ok && typeof h.challenge === "string"
      ? await o.ch.req({ op: "c_auth", memberId: sp.memberId, sig: signB64(this.opts.keys.privateKeyPem, authSigData(h.challenge, o.ch.ekm, sp.memberId)) })
      : { ok: false, code: "auth_failed" };
    if (this.stopped) { o.ch.sock.destroy(); return; }
    if (!a.ok) {
      this.opts.onError?.(typeof a.code === "string" ? a.code : "auth_failed");
      o.ch.sock.destroy();
      this.schedule();
      return;
    }
    this.attempt = 0;
    this.ch = o.ch;
    o.ch.sock.once("close", () => {
      if (this.ch !== o.ch) return;
      this.ch = null;
      this.opts.onState("disconnected");
      this.schedule();
    });
    this.opts.onState("connected");
  }
}
