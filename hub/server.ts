import net from "node:net";
import { encodeFrame, FrameDecoder } from "../shared/framing.js";
import { MessageStore } from "./store.js";
import { SessionRegistry, Session } from "./sessions.js";
import { MAGIC, PROTOCOL_VERSION, Message, Request, Response } from "../shared/protocol.js";

export interface HubOptions {
  tcpPort: number;
  httpPort: number;
  dataDir: string;
  idleShutdownMs: number; // 0이면 자동 종료 안 함
}

export class Hub {
  protected store: MessageStore;
  private registry = new SessionRegistry();
  private tcp: net.Server;
  private idleTimer: NodeJS.Timeout | null = null;
  protected opts: HubOptions;

  constructor(opts: HubOptions) {
    this.opts = opts;
    this.store = new MessageStore({ dir: opts.dataDir });
    this.tcp = net.createServer((sock) => this.onConnection(sock));
  }

  startTcp(): Promise<void> {
    return new Promise((resolve, reject) => {
      const onErr = (e: Error) => reject(e);
      this.tcp.once("error", onErr);
      this.tcp.listen(this.opts.tcpPort, "127.0.0.1", () => {
        this.tcp.off("error", onErr);
        resolve();
      });
    });
  }

  get tcpAddress(): { port: number } {
    const a = this.tcp.address();
    if (a && typeof a === "object") return { port: a.port };
    return { port: this.opts.tcpPort };
  }

  stop(): void {
    this.tcp.close();
    for (const s of this.registry.all()) this.registry.remove(s);
  }

  private onConnection(sock: net.Socket): void {
    this.cancelIdle();
    const dec = new FrameDecoder();
    const state: { session: Session | null } = { session: null };
    sock.on("data", (chunk) => {
      dec.push(chunk, (req: Request) => {
        state.session = this.dispatch(sock, state.session, req);
      });
    });
    sock.on("close", () => {
      if (state.session) this.registry.remove(state.session);
      this.maybeIdle();
    });
    sock.on("error", () => {
      /* close가 뒤따른다 */
    });
  }

  private dispatch(sock: net.Socket, session: Session | null, req: Request): Session | null {
    const reply = (r: Omit<Response, "id">) => sock.write(encodeFrame({ ...r, id: req.id }));
    const ensure = (): Session => {
      if (!session) session = this.registry.create(this.store.lastSeq);
      return session;
    };

    switch (req.op) {
      case "hello":
        reply({ ok: true, magic: MAGIC, version: PROTOCOL_VERSION });
        return session;

      case "register": {
        const s = ensure();
        const name = req.name ? this.registry.rename(s, req.name) : s.name;
        reply({ ok: true, sessionId: name, name });
        return s;
      }

      case "send": {
        const s = ensure();
        if (typeof req.text !== "string" || req.text.length === 0) {
          reply({ ok: false, error: "text는 비어있지 않은 문자열이어야 합니다" });
          return s;
        }
        const to = req.to && req.to.length ? req.to : null;
        const msg = this.store.append(s.name, to, req.text);
        reply({ ok: true, seq: msg.seq });
        this.broadcast(msg);
        return s;
      }

      case "check": {
        const s = ensure();
        const msgs = this.store.since(s.lastDeliveredSeq, s.name);
        if (msgs.length) s.lastDeliveredSeq = msgs[msgs.length - 1].seq;
        reply({ ok: true, messages: msgs });
        return s;
      }

      case "wait": {
        const s = ensure();
        const msgs = this.store.since(s.lastDeliveredSeq, s.name);
        if (msgs.length) {
          s.lastDeliveredSeq = msgs[msgs.length - 1].seq;
          reply({ ok: true, messages: msgs });
          return s;
        }
        const timeoutMs = Math.min(Math.max(req.timeoutMs ?? 30000, 1000), 120000);
        if (s.waiter) {
          clearTimeout(s.waiter.timer);
          s.waiter = null;
        }
        const timer = setTimeout(() => {
          s.waiter = null;
          reply({ ok: true, messages: [] });
        }, timeoutMs);
        s.waiter = {
          resolve: (m: Message[]) => reply({ ok: true, messages: m }),
          timer,
        };
        return s;
      }

      case "who": {
        const s = ensure();
        reply({ ok: true, sessions: this.registry.list() });
        return s;
      }

      default:
        reply({ ok: false, error: "알 수 없는 op" });
        return session;
    }
  }

  protected broadcast(msg: Message): void {
    for (const s of this.registry.all()) {
      if (s.waiter && s.name !== msg.from && (msg.to === null || msg.to === s.name)) {
        const w = s.waiter;
        s.waiter = null;
        clearTimeout(w.timer);
        s.lastDeliveredSeq = msg.seq;
        w.resolve([msg]);
      }
    }
  }

  private maybeIdle(): void {
    if (this.opts.idleShutdownMs <= 0) return;
    if (this.registry.all().length > 0) return;
    this.idleTimer = setTimeout(() => this.stop(), this.opts.idleShutdownMs);
    this.idleTimer.unref();
  }

  private cancelIdle(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }
}
