import net from "node:net";
import http from "node:http";
import { encodeFrame, FrameDecoder } from "../shared/framing.js";
import { MessageStore } from "./store.js";
import { SessionRegistry, Session } from "./sessions.js";
import { renderViewerHtml } from "./viewer.js";
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
  private http: http.Server;
  private sseClients = new Set<http.ServerResponse>();
  private idleTimer: NodeJS.Timeout | null = null;
  protected opts: HubOptions;

  constructor(opts: HubOptions) {
    this.opts = opts;
    this.store = new MessageStore({ dir: opts.dataDir });
    this.tcp = net.createServer((sock) => this.onConnection(sock));
    this.http = http.createServer((req, res) => this.onHttp(req, res));
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

  startHttp(): Promise<void> {
    return new Promise((resolve) => {
      this.http.once("error", () => resolve()); // 뷰어 포트 실패는 치명적이지 않다
      this.http.listen(this.opts.httpPort, "127.0.0.1", () => resolve());
    });
  }

  get httpAddress(): { port: number } {
    const a = this.http.address();
    if (a && typeof a === "object") return { port: a.port };
    return { port: this.opts.httpPort };
  }

  private onHttp(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.url === "/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(`event: init\ndata: ${JSON.stringify(this.store.recent(200))}\n\n`);
      this.sseClients.add(res);
      const drop = () => this.sseClients.delete(res);
      req.on("close", drop);
      // 뷰어가 비정상 종료되면 write 시 'error'가 발생할 수 있다. 처리기가 없으면
      // uncaught 예외로 Hub 전체가 죽으므로 반드시 붙여 두고 목록에서 제거한다.
      res.on("error", drop);
    } else {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(renderViewerHtml());
    }
  }

  private pushSse(msg: Message): void {
    const data = `data: ${JSON.stringify(msg)}\n\n`;
    for (const res of this.sseClients) {
      if (res.writableEnded || res.destroyed) {
        this.sseClients.delete(res);
        continue;
      }
      try {
        res.write(data);
      } catch {
        // 쓰기 실패한 응답은 목록에서 제거한다(예외로 Hub가 죽지 않게).
        this.sseClients.delete(res);
      }
    }
  }

  stop(): void {
    this.tcp.close();
    this.http.close();
    for (const res of this.sseClients) res.end();
    this.sseClients.clear();
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
      // 재연결로 세션이 더 새 소켓에 넘어갔다면(owner가 이 소켓이 아니면) 제거하지 않는다.
      if (state.session && state.session.owner === sock) this.registry.remove(state.session);
      this.maybeIdle();
    });
    sock.on("error", () => {
      /* close가 뒤따른다 */
    });
  }

  private dispatch(sock: net.Socket, session: Session | null, req: Request): Session | null {
    // 프레임화된 값이 형태 불량(null·숫자·op/id 누락)이면 응답할 수도 없으므로 조용히 버린다.
    const r = req as { op?: unknown; id?: unknown } | null;
    if (!r || typeof r !== "object" || typeof r.op !== "string" || typeof r.id !== "number") {
      return session;
    }
    const reply = (res: Omit<Response, "id">) => sock.write(encodeFrame({ ...res, id: req.id }));
    const ensure = (): Session => {
      if (!session) session = this.registry.create(this.store.lastSeq);
      session.owner = sock;
      return session;
    };

    switch (req.op) {
      case "hello":
        reply({ ok: true, magic: MAGIC, version: PROTOCOL_VERSION });
        return session;

      case "register": {
        // clientId가 있고 기존 세션이 있으면 새 세션을 만들지 않고 그 세션에 이어붙인다
        // (재연결 시 이름·커서 유지, 유령 세션·A-2 방지).
        const existing = req.clientId ? this.registry.byClient(req.clientId) : undefined;
        let s: Session;
        if (existing) {
          s = existing;
          s.owner = sock;
          session = s;
        } else {
          s = ensure();
          if (req.clientId) this.registry.bindClient(s, req.clientId);
        }
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
    this.pushSse(msg);
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
