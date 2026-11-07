// 서버 연결(방식 3, v3.0 5단계): 통신 서버끼리 잇는 양방향 채널.
// 연결 하나에서 양쪽 모두 요청({op,id})·응답({id,ok})·이벤트({event})를 보낸다. 받는 쪽(리스너)과 거는 쪽(LinkDialer)이 같은 LinkChannel을 쓴다.
import { encodeFrame } from "../../../shared/framing.js";
import { signB64, type SigningKeys } from "../../../shared/connCrypto.js";
import { CONN_MAGIC, LINK_OPS_AFTER_AUTH, linkAuthSigData, linkJoinSigData } from "../../../shared/connProtocol.js";
import type { InvitePayload } from "../../../shared/invite.js";
import { openPinnedSocket, type PinnedSocket } from "../client.js";
import type { LinkRecord } from "../store.js";

export interface LinkSelf {
  keys: SigningKeys;
  spaceId: string;
  spaceName: string;
}

export interface LinkHandlers {
  onRequest(req: { op: string; [k: string]: unknown }, reply: (r: object) => void): void;
  onEvent(e: { event: string; [k: string]: unknown }): void;
}

const REQUEST_TIMEOUT_MS = 30_000;
export const LINK_OPS: ReadonlySet<string> = new Set<string>(LINK_OPS_AFTER_AUTH);

export class LinkChannel {
  private pending = new Map<number, (r: any) => void>();
  private next = 1;
  private closed = false;
  /** 처리기를 달기 전에 온 요청·이벤트는 모아 둔다(상대가 붙자마자 보내도 잃지 않게). */
  private handlers: LinkHandlers | null = null;
  private queued: unknown[] = [];
  private readonly closeListeners: (() => void)[] = [];

  /** allowedOps를 주면 그 밖의 요청은 처리기에 넘기지 않고 op_not_allowed. */
  constructor(private readonly io: { write(obj: object): void; close(): void; allowedOps?: ReadonlySet<string> }) {}

  setHandlers(h: LinkHandlers): void {
    this.handlers = h;
    for (const f of this.queued.splice(0)) this.feed(f);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  onClose(fn: () => void): void {
    if (this.closed) fn();
    else this.closeListeners.push(fn);
  }

  /** 전송 계층이 받은 프레임 하나. */
  feed(f: unknown): void {
    if (this.closed || !f || typeof f !== "object") return;
    const x = f as { op?: unknown; id?: unknown; event?: unknown };
    if (typeof x.op === "string" && typeof x.id === "number") {
      const id = x.id;
      const reply = (r: object) => { if (!this.closed) this.io.write({ ...r, id }); };
      if (this.io.allowedOps && !this.io.allowedOps.has(x.op)) return reply({ ok: false, code: "op_not_allowed" });
      if (!this.handlers) { if (this.queued.length < 10_000) this.queued.push(f); return; }
      try {
        this.handlers.onRequest(f as { op: string }, reply);
      } catch {
        reply({ ok: false, code: "internal" });
      }
      return;
    }
    if (typeof x.id === "number" && x.op === undefined) {
      const p = this.pending.get(x.id);
      if (p) { this.pending.delete(x.id); p(f); }
      return;
    }
    if (typeof x.event === "string") {
      if (!this.handlers) { if (this.queued.length < 10_000) this.queued.push(f); return; }
      try {
        this.handlers.onEvent(f as { event: string });
      } catch {
        // 처리기 오류가 연결을 깨지 않게
      }
    }
  }

  request(body: { op: string; [k: string]: unknown }): Promise<any> {
    if (this.closed) return Promise.resolve({ ok: false, code: "connection_lost" });
    const id = this.next++;
    return new Promise((res) => {
      const t = setTimeout(() => { if (this.pending.delete(id)) res({ ok: false, code: "timeout" }); }, REQUEST_TIMEOUT_MS);
      t.unref?.();
      this.pending.set(id, (r) => { clearTimeout(t); res(r); });
      this.io.write({ ...body, id });
    });
  }

  event(e: { event: string; [k: string]: unknown }): void {
    if (!this.closed) this.io.write(e);
  }

  close(): void {
    if (this.closed) return;
    this.io.close();
    this.notifyClosed();
  }

  /** 전송 계층이 닫혔을 때. */
  notifyClosed(): void {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) p({ ok: false, code: "connection_lost" });
    this.pending.clear();
    for (const fn of this.closeListeners.splice(0)) fn();
  }

  /** 시험·망 엔진 단위 시험용: 메모리로 이은 채널 한 쌍(전달은 다음 틱). */
  static memoryPair(tap?: (from: "a" | "b", obj: any) => boolean): [LinkChannel, LinkChannel] {
    let a: LinkChannel;
    let b: LinkChannel;
    const send = (to: () => LinkChannel, obj: object) => {
      if (tap && !tap(to() === b ? "a" : "b", obj)) return; // 시험: false면 이 프레임을 버림
      const copy = JSON.parse(JSON.stringify(obj));
      setImmediate(() => to().feed(copy));
    };
    a = new LinkChannel({ write: (o) => send(() => b, o), close: () => setImmediate(() => b.notifyClosed()) });
    b = new LinkChannel({ write: (o) => send(() => a, o), close: () => setImmediate(() => a.notifyClosed()) });
    return [a, b];
  }
}

function overSocket(ps: PinnedSocket): LinkChannel {
  const ch = new LinkChannel({ write: (o) => { if (!ps.sock.destroyed) ps.sock.write(encodeFrame(o)); }, close: () => ps.sock.destroy(), allowedOps: LINK_OPS });
  ps.onFrame((f) => ch.feed(f));
  ps.sock.once("close", () => ch.notifyClosed());
  return ch;
}

export type LinkJoinError = "relay_unsupported" | "pin_mismatch" | "cipher_mismatch" | "tls_failed" | "unreachable" | "timeout" | "link_join_failed" | "not_link_invite";

/** 서버 연결 인증서로 처음 잇는다(C 주인의 승인 = 이 호출). 성공하면 저장할 연결 정보. */
export async function joinLink(invite: InvitePayload, self: LinkSelf, timeoutMs = 10_000): Promise<{ ok: true; link: LinkRecord } | { ok: false; code: LinkJoinError }> {
  if (invite.kind !== "link") return { ok: false, code: "not_link_invite" };
  const o = await openPinnedSocket(invite, timeoutMs);
  if (!o.ok) return o;
  const ch = overSocket(o.ps);
  try {
    const h = await ch.request({ op: "c_hello" });
    if (!h.ok || h.magic !== CONN_MAGIC || typeof h.challenge !== "string") return { ok: false, code: "link_join_failed" };
    const sig = signB64(self.keys.privateKeyPem, linkJoinSigData(h.challenge, o.ps.ekm, invite.token, self.keys.publicKeyB64, self.spaceId));
    const r = await ch.request({ op: "l_join", token: invite.token, serverKey: self.keys.publicKeyB64, spaceId: self.spaceId, spaceName: self.spaceName, sig });
    if (!r.ok) return { ok: false, code: "link_join_failed" };
    return {
      ok: true,
      link: {
        spaceId: invite.spaceId,
        spaceName: invite.spaceName,
        serverKey: invite.serverKey,
        dir: "out",
        endpoint: invite.endpoint,
        profile: invite.profile,
        addedAt: Date.now(),
        removed: false,
      },
    };
  } finally {
    ch.close();
  }
}

export interface LinkDialerOptions {
  link: LinkRecord;
  self: LinkSelf;
  onUp(ch: LinkChannel): void;
  onDown(): void;
  onError?(code: string): void;
  backoffMs?: number[];
  timeoutMs?: number;
}

/** 내가 거는 쪽 서버 연결 — 끊기면 다시 건다(ConnClient와 같은 지연). */
export class LinkDialer {
  private ch: LinkChannel | null = null;
  private stopped = true;
  private attempt = 0;
  private timer: NodeJS.Timeout | null = null;
  private readonly backoff: number[];

  constructor(private readonly opts: LinkDialerOptions) {
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
    ch?.close();
  }

  private schedule(): void {
    if (this.stopped) return;
    const wait = this.backoff[Math.min(this.attempt, this.backoff.length - 1)];
    this.attempt++;
    this.timer = setTimeout(() => { this.timer = null; void this.connectOnce(); }, wait);
  }

  private async connectOnce(): Promise<void> {
    if (this.stopped) return;
    const l = this.opts.link;
    if (!l.endpoint || !l.profile) { this.opts.onError?.("no_endpoint"); return; }
    const o = await openPinnedSocket({ endpoint: l.endpoint, serverKey: l.serverKey, profile: l.profile }, this.opts.timeoutMs ?? 10_000);
    if (this.stopped) { if (o.ok) o.ps.sock.destroy(); return; }
    if (!o.ok) { this.opts.onError?.(o.code); this.schedule(); return; }
    const ch = overSocket(o.ps);
    const h = await ch.request({ op: "c_hello" });
    const a = h.ok && typeof h.challenge === "string"
      ? await ch.request({ op: "l_auth", spaceId: this.opts.self.spaceId, sig: signB64(this.opts.self.keys.privateKeyPem, linkAuthSigData(h.challenge, o.ps.ekm, this.opts.self.spaceId)) })
      : { ok: false };
    if (this.stopped) { ch.close(); return; }
    if (!a.ok) {
      this.opts.onError?.("link_auth_failed");
      ch.close();
      this.schedule();
      return;
    }
    this.attempt = 0;
    this.ch = ch;
    ch.onClose(() => {
      if (this.ch !== ch) return;
      this.ch = null;
      this.opts.onDown();
      this.schedule();
    });
    this.opts.onUp(ch);
  }
}
