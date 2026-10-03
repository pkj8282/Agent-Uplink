import net from "node:net";
import http from "node:http";
import { encodeFrame, FrameDecoder } from "../shared/framing.js";
import { renderViewerHtml } from "./viewer.js";
import { loadConfig, Config } from "./config.js";
import { ChannelStore } from "./channels.js";
import { AccountStore } from "./accounts.js";
import { InboxStore } from "./inbox.js";
import {
  MAGIC,
  PROTOCOL_VERSION,
  LOBBY_CHANNEL_ID,
  Channel,
  InboxItem,
  Request,
  Response,
} from "../shared/protocol.js";

export interface HubOptions {
  tcpPort: number;
  httpPort: number;
  dataDir: string;
  idleShutdownMs: number;
}

interface Waiter {
  resolve: (items: InboxItem[]) => void;
  timer: NodeJS.Timeout;
}

export class Hub {
  protected opts: HubOptions;
  protected config: Config;
  protected channels: ChannelStore;
  protected accounts: AccountStore;
  protected inbox: InboxStore;
  private tcp: net.Server;
  private http: http.Server;
  private sseClients = new Set<http.ServerResponse>();
  private connections = new Set<net.Socket>();
  private waiters = new Map<string, Set<Waiter>>(); // uuid → 대기자들
  private idleTimer: NodeJS.Timeout | null = null;

  constructor(opts: HubOptions) {
    this.opts = opts;
    this.config = loadConfig(opts.dataDir);
    this.channels = new ChannelStore({ dir: opts.dataDir });
    this.accounts = new AccountStore({ dir: opts.dataDir });
    this.inbox = new InboxStore({ dir: opts.dataDir });
    // 1단계 검증용 lobby 채널(전체 공개)
    this.channels.register({ id: LOBBY_CHANNEL_ID, kind: "server", label: "main/lobby", members: null });
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
    return a && typeof a === "object" ? { port: a.port } : { port: this.opts.tcpPort };
  }

  startHttp(): Promise<void> {
    return new Promise((resolve) => {
      this.http.once("error", () => resolve()); // 뷰어 포트 실패는 치명적이지 않다
      this.http.listen(this.opts.httpPort, "127.0.0.1", () => resolve());
    });
  }

  get httpAddress(): { port: number } {
    const a = this.http.address();
    return a && typeof a === "object" ? { port: a.port } : { port: this.opts.httpPort };
  }

  private onHttp(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.url === "/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      res.write(`event: init\ndata: ${JSON.stringify(this.channels.recent(LOBBY_CHANNEL_ID, 200))}\n\n`);
      this.sseClients.add(res);
      const drop = () => this.sseClients.delete(res);
      req.on("close", drop);
      res.on("error", drop);
    } else {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(renderViewerHtml());
    }
  }

  private pushSse(label: string, m: { ts: number; channelId: string; fromName: string; text: string }): void {
    const data = `data: ${JSON.stringify({ ...m, channelLabel: label })}\n\n`;
    for (const res of this.sseClients) {
      if (res.writableEnded || res.destroyed) {
        this.sseClients.delete(res);
        continue;
      }
      try {
        res.write(data);
      } catch {
        this.sseClients.delete(res);
      }
    }
  }

  stop(): void {
    this.tcp.close();
    this.http.close();
    for (const res of this.sseClients) res.end();
    this.sseClients.clear();
    for (const s of this.connections) s.destroy();
    this.connections.clear();
  }

  private onConnection(sock: net.Socket): void {
    this.cancelIdle();
    this.connections.add(sock);
    const dec = new FrameDecoder();
    const state: { uuid: string | null; waiter: Waiter | null } = { uuid: null, waiter: null };
    sock.on("data", (chunk) => dec.push(chunk, (req: Request) => this.dispatch(sock, state, req)));
    sock.on("close", () => {
      this.connections.delete(sock);
      if (state.uuid && state.waiter) this.removeWaiter(state.uuid, state.waiter);
      this.maybeIdle();
    });
    sock.on("error", () => {
      /* close 뒤따름 */
    });
  }

  private dispatch(
    sock: net.Socket,
    state: { uuid: string | null; waiter: Waiter | null },
    req: Request,
  ): void {
    const r = req as { op?: unknown; id?: unknown } | null;
    if (!r || typeof r !== "object" || typeof r.op !== "string" || typeof r.id !== "number") return;
    const reply = (res: Omit<Response, "id">) => sock.write(encodeFrame({ ...res, id: req.id }));
    const needLogin = (): string | null => {
      if (!state.uuid) {
        reply({ ok: false, error: "먼저 login 하세요(계정 맥락 없음)." });
        return null;
      }
      return state.uuid;
    };

    switch (req.op) {
      case "hello":
        reply({ ok: true, magic: MAGIC, version: PROTOCOL_VERSION });
        return;

      case "login": {
        if (typeof req.uuid !== "string" || req.uuid.length === 0) {
          reply({ ok: false, error: "login에는 uuid가 필요합니다." });
          return;
        }
        const acc = this.accounts.getOrCreate(req.uuid, req.name);
        state.uuid = acc.uuid;
        reply({ ok: true, uuid: acc.uuid, name: acc.name });
        return;
      }

      case "whoami": {
        const uuid = needLogin();
        if (!uuid) return;
        const a = this.accounts.get(uuid)!;
        reply({ ok: true, uuid: a.uuid, name: a.name });
        return;
      }

      case "set_name": {
        const uuid = needLogin();
        if (!uuid) return;
        if (typeof req.name !== "string" || req.name.length === 0) {
          reply({ ok: false, error: "name이 필요합니다." });
          return;
        }
        reply({ ok: true, name: this.accounts.setName(uuid, req.name) });
        return;
      }

      case "list_accounts": {
        if (!needLogin()) return;
        reply({ ok: true, accounts: this.accounts.list() });
        return;
      }

      case "send": {
        const uuid = needLogin();
        if (!uuid) return;
        if (typeof req.text !== "string" || req.text.length === 0) {
          reply({ ok: false, error: "text는 비어있지 않은 문자열이어야 합니다." });
          return;
        }
        const ch = this.channels.getChannel(req.channelId);
        if (!ch) {
          reply({ ok: false, error: `채널이 없습니다: ${req.channelId}` });
          return;
        }
        if (ch.members && !ch.members.includes(uuid)) {
          reply({ ok: false, error: "이 채널에 접근할 수 없습니다." });
          return;
        }
        const name = this.accounts.get(uuid)!.name;
        const msg = this.channels.append(ch.id, uuid, name, req.text);
        reply({ ok: true, seq: msg.seq });
        this.fanout(ch, msg.from, name, req.text, msg.ts);
        return;
      }

      case "read": {
        const uuid = needLogin();
        if (!uuid) return;
        const ch = this.channels.getChannel(req.channelId);
        if (!ch) {
          reply({ ok: false, error: `채널이 없습니다: ${req.channelId}` });
          return;
        }
        if (ch.members && !ch.members.includes(uuid)) {
          reply({ ok: false, error: "이 채널에 접근할 수 없습니다." });
          return;
        }
        const limit = typeof req.limit === "number" && req.limit > 0 ? req.limit : 50;
        reply({ ok: true, messages: this.channels.recent(ch.id, limit) });
        return;
      }

      case "check": {
        const uuid = needLogin();
        if (!uuid) return;
        reply({ ok: true, items: this.drain(uuid) });
        return;
      }

      case "wait": {
        const uuid = needLogin();
        if (!uuid) return;
        const now = this.drain(uuid);
        if (now.length) {
          reply({ ok: true, items: now });
          return;
        }
        const timeoutMs = Math.min(Math.max(req.timeoutMs ?? 30000, 1000), 120000);
        if (state.waiter) {
          this.removeWaiter(uuid, state.waiter);
          state.waiter = null;
        }
        const timer = setTimeout(() => {
          if (state.waiter) {
            this.removeWaiter(uuid, state.waiter);
            state.waiter = null;
          }
          reply({ ok: true, items: [] });
        }, timeoutMs);
        const waiter: Waiter = {
          resolve: (items) => reply({ ok: true, items }),
          timer,
        };
        state.waiter = waiter;
        this.addWaiter(uuid, waiter);
        return;
      }

      default:
        reply({ ok: false, error: "알 수 없는 op" });
        return;
    }
  }

  /** 계정 인박스에서 커서 이후를 상한까지 꺼내고 커서를 전진시킨다. */
  private drain(uuid: string): InboxItem[] {
    const cursor = this.accounts.get(uuid)!.inboxCursor;
    const items = this.inbox.since(uuid, cursor, this.config.inboxMaxBatch);
    if (items.length) this.accounts.setInboxCursor(uuid, items[items.length - 1].seq);
    return items;
  }

  /** 채널 메시지를 수신 대상 계정들의 인박스에 append하고, 대기자를 깨운다. */
  protected fanout(ch: Channel, from: string, fromName: string, text: string, ts: number): void {
    const recipients = ch.members ?? this.accounts.allUuids();
    for (const uuid of recipients) {
      if (uuid === from) continue;
      this.inbox.append(uuid, {
        ts,
        channelId: ch.id,
        channelKind: ch.kind,
        channelLabel: ch.label,
        from,
        fromName,
        text,
      });
      this.wake(uuid);
    }
    this.pushSse(ch.label, { ts, channelId: ch.id, fromName, text });
  }

  private addWaiter(uuid: string, w: Waiter): void {
    let set = this.waiters.get(uuid);
    if (!set) {
      set = new Set();
      this.waiters.set(uuid, set);
    }
    set.add(w);
  }

  private removeWaiter(uuid: string, w: Waiter): void {
    const set = this.waiters.get(uuid);
    if (!set) return;
    set.delete(w);
    clearTimeout(w.timer);
    if (set.size === 0) this.waiters.delete(uuid);
  }

  private wake(uuid: string): void {
    const set = this.waiters.get(uuid);
    if (!set || set.size === 0) return;
    const items = this.drain(uuid);
    if (!items.length) return;
    for (const w of [...set]) {
      this.removeWaiter(uuid, w);
      w.resolve(items);
    }
  }

  private maybeIdle(): void {
    if (this.opts.idleShutdownMs <= 0) return;
    if (this.connections.size > 0) return;
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
