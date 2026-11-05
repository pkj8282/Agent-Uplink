// 통신 TLS 리스너(v3.0): 다른 PC의 Hub(참여자)가 붙는 입구. 로컬 리스너(127.0.0.1·client.key)와 코드 경로가 분리돼 있고,
// 통신 op 허용 목록만 처리한다 — 로컬·관리 op는 이름이 같아도 처리하지 않는다.
// 참여: 서버가 서명한 초대의 1회용 토큰 + 참여자 Hub 키 서명. 인증: 등록된 Hub 키 서명. 두 서명 모두 이 연결의 도전값과
// TLS 키 재료(EKM)에 묶여 다른 연결로 옮겨 쓸 수 없다.
import tls from "node:tls";
import { randomBytes, randomUUID } from "node:crypto";
import { encodeFrame, FrameDecoder, FrameTooLargeError } from "../../shared/framing.js";
import { selfSignedCertPem } from "../../shared/x509.js";
import { verifyB64 } from "../../shared/connCrypto.js";
import { DEFAULT_PROFILE, PROFILES } from "../../shared/cryptoProfile.js";
import {
  CONN_EKM_LABEL, CONN_MAGIC, CONN_OPS_AFTER_AUTH, CONN_VERSION, authSigData, joinSigData,
  type ConnEvent, type ConnRequest,
} from "../../shared/connProtocol.js";
import { validateName } from "../names.js";
import type { ConnectionStore } from "./store.js";

export interface ConnLimits {
  maxConnections: number;
  preAuthTimeoutMs: number;
  preAuthMaxFrame: number;
  maxFrame: number;
  attemptsPerIpPerMinute: number;
  /** 한 IP가 동시에 가질 수 있는 인증 전 연결 수 — 전체 자리를 한 곳이 차지해 구성원이 못 붙는 일을 막는다(RT-C15). */
  maxPreAuthPerIp: number;
}

export const DEFAULT_CONN_LIMITS: ConnLimits = {
  maxConnections: 32,
  preAuthTimeoutMs: 10_000,
  preAuthMaxFrame: 16 * 1024,
  maxFrame: 1024 * 1024,
  attemptsPerIpPerMinute: 10,
  maxPreAuthPerIp: 4,
};

export interface ConnPeer {
  memberId: string;
  userName: string;
  send(e: ConnEvent): void;
  close(): void;
}

export interface ConnListenerDeps {
  store: ConnectionStore;
  limits?: Partial<ConnLimits>;
  onPeer(p: ConnPeer): void;
  onPeerGone(p: ConnPeer): void;
  handle(p: ConnPeer, req: ConnRequest, reply: (r: object) => void): void;
  log(code: string, detail: object): void;
  /** 원격 이름 감독(숨은 문자 이스케이프) — 없으면 validateName 기본 정리. */
  cleanName?: (s: string) => string;
  /** 시험용: 이 리스너가 내보내는 모든 프레임(응답·이벤트)을 본다. */
  tap?: (obj: object) => void;
}

const AFTER_AUTH = new Set<string>(CONN_OPS_AFTER_AUTH);

export class ConnListener {
  private readonly limits: ConnLimits;
  private srv: tls.Server | null = null;
  private socketsByMember = new Map<string, Set<tls.TLSSocket>>();
  private attempts = new Map<string, number[]>();
  private preAuthByIp = new Map<string, number>();

  constructor(private readonly deps: ConnListenerDeps) {
    this.limits = { ...DEFAULT_CONN_LIMITS, ...deps.limits };
  }

  listen(port: number, host = "0.0.0.0"): Promise<number> {
    const keys = this.deps.store.identity();
    const profile = this.deps.store.serverConfig()?.profile ?? DEFAULT_PROFILE;
    const srv = tls.createServer({
      key: keys.privateKeyPem,
      cert: selfSignedCertPem(keys, "agent-uplink", Date.now()),
      minVersion: "TLSv1.3",
      maxVersion: "TLSv1.3",
      ciphers: PROFILES[profile].tlsCipher,
      handshakeTimeout: this.limits.preAuthTimeoutMs,
    });
    srv.maxConnections = this.limits.maxConnections;
    srv.on("secureConnection", (s) => this.onSocket(s));
    srv.on("tlsClientError", (_e, s) => s.destroy());
    this.srv = srv;
    return new Promise((resolve, reject) => {
      srv.once("error", reject);
      srv.listen(port, host, () => {
        srv.off("error", reject);
        resolve((srv.address() as { port: number }).port);
      });
    });
  }

  close(): Promise<void> {
    const srv = this.srv;
    this.srv = null;
    for (const set of this.socketsByMember.values()) for (const s of set) s.destroy();
    if (!srv) return Promise.resolve();
    return new Promise((r) => srv.close(() => r()));
  }

  disconnect(memberId: string): void {
    for (const s of this.socketsByMember.get(memberId) ?? []) s.destroy();
  }

  /** IP별 분당 참여·인증 시도 상한. 넘으면 false. */
  private allowAttempt(ip: string): boolean {
    const now = Date.now();
    const list = (this.attempts.get(ip) ?? []).filter((t) => now - t < 60_000);
    if (list.length >= this.limits.attemptsPerIpPerMinute) {
      this.attempts.set(ip, list);
      return false;
    }
    list.push(now);
    this.attempts.set(ip, list);
    return true;
  }

  private onSocket(sock: tls.TLSSocket): void {
    const ip = sock.remoteAddress ?? "?";
    const challenge = randomBytes(32).toString("base64");
    const ekm = sock.exportKeyingMaterial(32, CONN_EKM_LABEL, Buffer.alloc(0)).toString("base64");
    const held = this.preAuthByIp.get(ip) ?? 0;
    if (held >= this.limits.maxPreAuthPerIp) {
      this.deps.log("preauth_per_ip", { ip });
      sock.destroy();
      return;
    }
    this.preAuthByIp.set(ip, held + 1);
    let preAuthHeld = true;
    const releasePreAuth = () => {
      if (!preAuthHeld) return;
      preAuthHeld = false;
      const n = (this.preAuthByIp.get(ip) ?? 1) - 1;
      if (n <= 0) this.preAuthByIp.delete(ip);
      else this.preAuthByIp.set(ip, n);
    };
    let peer: ConnPeer | null = null;
    let decoder = new FrameDecoder({ maxFrame: this.limits.preAuthMaxFrame });
    const timer = setTimeout(() => { if (!peer) sock.destroy(); }, this.limits.preAuthTimeoutMs);
    sock.setNoDelay(true);
    sock.on("error", () => {});
    sock.on("close", () => {
      releasePreAuth();
      clearTimeout(timer);
      if (peer) {
        this.socketsByMember.get(peer.memberId)?.delete(sock);
        this.deps.onPeerGone(peer);
      }
    });

    const send = (obj: object) => {
      if (sock.destroyed) return;
      this.deps.tap?.(obj);
      sock.write(encodeFrame(obj));
    };
    const becomePeer = (memberId: string, userName: string) => {
      peer = {
        memberId,
        userName,
        send: (e) => send(e),
        close: () => sock.destroy(),
      };
      clearTimeout(timer);
      releasePreAuth();
      decoder = new FrameDecoder({ maxFrame: this.limits.maxFrame });
      let set = this.socketsByMember.get(memberId);
      if (!set) this.socketsByMember.set(memberId, (set = new Set()));
      set.add(sock);
      this.deps.onPeer(peer);
    };

    const onFrame = (f: unknown) => {
      if (sock.destroyed) return;
      const r = f as { op?: unknown; id?: unknown } | null;
      if (!r || typeof r !== "object" || typeof r.op !== "string" || typeof r.id !== "number") {
        sock.destroy();
        return;
      }
      const id = r.id;
      const reply = (res: object) => send({ ...res, id });
      const fail = (code: string, close = false) => {
        reply({ ok: false, code });
        if (close) sock.end();
      };

      if (peer) {
        if (!AFTER_AUTH.has(r.op)) return fail("op_not_allowed");
        this.deps.handle(peer, f as ConnRequest, reply);
        return;
      }
      switch (r.op) {
        case "c_hello":
          reply({ ok: true, magic: CONN_MAGIC, version: CONN_VERSION, challenge });
          return;
        case "c_join": {
          if (!this.allowAttempt(ip)) { this.deps.log("rate_limited", { ip }); return fail("rate_limited", true); }
          const q = f as { token?: unknown; hubKey?: unknown; userName?: unknown; sig?: unknown };
          const name = validateName(q.userName, "account", this.deps.cleanName);
          if (typeof q.token !== "string" || typeof q.hubKey !== "string" || typeof q.sig !== "string" || !name.ok
            || !verifyB64(q.hubKey, joinSigData(challenge, ekm, q.token, q.hubKey), q.sig)) {
            this.deps.log("join_failed", { ip });
            return fail("join_failed");
          }
          const store = this.deps.store;
          const existing = store.members().find((m) => m.hubKey === q.hubKey);
          if (existing?.revoked) { this.deps.log("join_failed", { ip }); return fail("join_failed"); }
          const use = store.useInvite(q.token, q.hubKey, Date.now(), store.serverConfig()?.burnOnJoin === true);
          if (use !== "ok") { this.deps.log("join_failed", { ip, reason: use }); return fail("join_failed"); }
          const memberId = existing?.memberId ?? randomUUID();
          store.addMember({ memberId, hubKey: q.hubKey, userName: name.name, joinedAt: existing?.joinedAt ?? Date.now(), revoked: false });
          becomePeer(memberId, name.name);
          reply({ ok: true, memberId, spaceName: store.serverConfig()?.spaceName ?? "" });
          return;
        }
        case "c_auth": {
          if (!this.allowAttempt(ip)) { this.deps.log("rate_limited", { ip }); return fail("rate_limited", true); }
          const q = f as { memberId?: unknown; sig?: unknown };
          const m = typeof q.memberId === "string" ? this.deps.store.member(q.memberId) : undefined;
          if (!m || m.revoked || typeof q.sig !== "string" || !verifyB64(m.hubKey, authSigData(challenge, ekm, m.memberId), q.sig)) {
            this.deps.log("auth_failed", { ip });
            return fail("auth_failed");
          }
          becomePeer(m.memberId, m.userName);
          reply({ ok: true, memberId: m.memberId, spaceName: this.deps.store.serverConfig()?.spaceName ?? "" });
          return;
        }
        default:
          return fail("auth_required", true);
      }
    };

    sock.on("data", (chunk: Buffer) => {
      try {
        decoder.push(chunk, onFrame);
      } catch (e) {
        if (e instanceof FrameTooLargeError) this.deps.log("frame_too_large", { ip, length: e.length });
        sock.destroy();
      }
    });
  }
}
