import net from "node:net";
import http from "node:http";
import { encodeFrame, FrameDecoder, FrameTooLargeError } from "../shared/framing.js";
import { renderViewerHtml, isAllowedHost } from "./viewer.js";
import { ViewerAuth } from "./viewerAuth.js";
import { loadConfig, saveConfig, Config } from "./config.js";
import { verifyAdminToken } from "./adminKey.js";
import { secureDataDir, SecureDeps } from "./secure.js";
import { newNonce, isNonce, clientProof, hubProof, proofEquals } from "../shared/auth.js";
import { ChannelStore } from "./channels.js";
import { AccountStore } from "./accounts.js";
import { InboxStore } from "./inbox.js";
import { DmStore } from "./dm.js";
import { ServerStore } from "./servers.js";
import { nameKey, validateName } from "./names.js";
import { isSafeAccountId } from "./ids.js";
import { TrashStore } from "./trash.js";
import { TrashOps } from "./trashOps.js";
import { rebuildDmIndex } from "./recovery.js";
import { hubMsg, type HubKey } from "./messages.js";
import { effectiveLang, type Lang } from "../shared/i18n.js";
import { currentLang } from "../shared/langConfig.js";
import { SecurityLog } from "./securityLog.js";
import {
  MAGIC,
  PROTOCOL_VERSION,
  LOBBY_CHANNEL_ID,
  MAX_TEXT_LENGTH,
  Channel,
  InboxItem,
  Request,
  Response,
} from "../shared/protocol.js";

export interface HubLimits {
  maxConnections: number;
  authTimeoutMs: number;
  maxSse: number;
}
// 로컬 대량 연결로 Hub를 점유하지 못하게(정상 사용은 세션 수 + 관리 앱 정도).
export const DEFAULT_LIMITS: HubLimits = { maxConnections: 64, authTimeoutMs: 10_000, maxSse: 16 };

export interface HubOptions {
  tcpPort: number;
  httpPort: number;
  dataDir: string;
  idleShutdownMs: number;
  limits?: Partial<HubLimits>;
}

interface Waiter {
  resolve: (items: InboxItem[]) => void;
  timer: NodeJS.Timeout;
}

/** 연결 1개의 로그인 상태. 집합으로 모아 online·독점 판정에 쓴다. */
interface ConnState {
  uuid: string | null;
  waiter: Waiter | null;
  sessionToken: string | null;
  hubNonce: string | null; // hello가 준 nonce(auth 1회에 소진)
  authed: boolean; // v3 핸드셰이크 통과
  closed: boolean; // auth 실패로 닫는 중 — 이후 요청 무시
  helloPending: boolean; // 보안 준비 전 응답을 기다리는 hello가 있음(연결당 하나만)
}

// Hub가 받는 요청 프레임 상한(정상 요청은 수 KB, 메시지 본문 상한 64K자 ≈ 최대 192KB).
export const MAX_REQUEST_FRAME = 1024 * 1024;

// 계정 인박스가 이 수를 넘으면 소비분을 압축한다(무한 증가 방지, 재작성 빈도 억제).
const INBOX_COMPACT_THRESHOLD = 1000;

export class Hub {
  protected opts: HubOptions;
  protected config!: Config;
  protected limits: HubLimits;
  protected channels!: ChannelStore;
  protected accounts!: AccountStore;
  /** 유니코드 스테가노그래피 감독 기록(v2.1.2) — 스토어보다 먼저 만든다. */
  protected security!: SecurityLog;
  protected inbox!: InboxStore;
  protected dm!: DmStore;
  protected servers!: ServerStore;
  protected trash!: TrashStore;
  protected trashOps!: TrashOps;
  private adminKey: string | null = null;
  private clientKey: string | null = null;
  private isReady = false;
  /** 보안 준비(secure()) 완료. 실패하면 reject — hello가 사유를 돌려준다. */
  readonly ready: Promise<void>;
  private markReady!: () => void;
  private markFailed!: (e: Error) => void;
  private tcp: net.Server;
  private http: http.Server;
  private sseClients = new Set<http.ServerResponse>();
  private viewerAuth = new ViewerAuth();
  private httpListening = false;
  private connections = new Set<net.Socket>();
  private waiters = new Map<string, Set<Waiter>>(); // uuid → 대기자들
  private idleTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private connStates = new Set<ConnState>();
  private stateBySock = new Map<net.Socket, ConnState>(); // 삽입 순 = 오래된 순

  constructor(opts: HubOptions) {
    this.ready = new Promise<void>((res, rej) => { this.markReady = res; this.markFailed = rej; });
    this.ready.catch(() => { /* 실패는 hello 응답과 index.ts가 다룬다 */ });
    this.opts = opts;
    this.limits = { ...DEFAULT_LIMITS, ...opts.limits };
    this.tcp = net.createServer((sock) => this.onConnection(sock));
    this.http = http.createServer((req, res) => this.onHttp(req, res));
  }

  /** 표시 언어. 데이터 적재 전(보안 준비 중)에는 파일에서 읽는다 — 값은 ko/en 선택에만 쓰인다. */
  protected lang(): Lang {
    return this.config ? effectiveLang(this.config.language) : currentLang(this.opts.dataDir);
  }

  /** 현재 언어의 문구. params는 키별 함수 인자. */
  protected msg(key: HubKey, params?: object): string {
    return hubMsg(this.lang(), key, params);
  }

  /** 오류 응답: 판단용 code와 표시용 문구. */
  /** 이름 요청의 감독(validateName에 넘긴다). */
  private nameGuard(where: string, account: unknown): (s: string) => string {
    return (s) => this.security.guard(s, { source: "request", where, field: "name", ...(typeof account === "string" ? { account } : {}) });
  }

  protected err(code: string, key: HubKey, params?: object): { ok: false; code: string; error: string } {
    return { ok: false, code, error: this.msg(key, params) };
  }

  /** 데이터 폴더를 잠그고 키를 준비한 뒤 데이터를 적재한다. 끝나야 hello에 답한다. 실패하면 던지고 hello는 secure_setup_failed. */
  async secure(deps?: SecureDeps): Promise<void> {
    try {
      const k = await secureDataDir(this.opts.dataDir, deps, this.lang());
      this.clientKey = k.clientKey;
      this.adminKey = k.adminKey;
      // 데이터 폴더를 읽고 쓰는 일은 권한 잠금·소유자 검사가 끝난 뒤에만 한다(남의 폴더를 건드리지 않게).
      this.loadData();
      this.isReady = true;
      this.markReady();
    } catch (e) {
      this.markFailed(e as Error);
      throw e;
    }
  }

  private loadData(): void {
    this.config = loadConfig(this.opts.dataDir);
    this.security = new SecurityLog({ dir: this.opts.dataDir });
    const guard = this.security.guard;
    this.channels = new ChannelStore({ dir: this.opts.dataDir, guard });
    this.accounts = new AccountStore({ dir: this.opts.dataDir, guard });
    this.inbox = new InboxStore({ dir: this.opts.dataDir, guard });
    this.dm = new DmStore({ dir: this.opts.dataDir, guard });
    this.servers = new ServerStore({ dir: this.opts.dataDir, guard });
    this.trash = new TrashStore({ dir: this.opts.dataDir });
    this.trashOps = new TrashOps({
      dataDir: this.opts.dataDir, servers: this.servers, dm: this.dm, accounts: this.accounts,
      channels: this.channels, inbox: this.inbox, trash: this.trash,
      maxChannelsPerServer: () => this.config.maxChannelsPerServer,
      lang: () => this.lang(),
    });
    // 크래시로 중단된 삭제·복원을 먼저 마무리한다 — 이후 DM 재조정이 삭제 중이던 계정을 되살리지 않도록.
    this.trashOps.recoverPending();
    if (this.dm.corrupt) rebuildDmIndex(this.accounts, this.dm, this.channels);
    // 1단계 검증용 lobby 채널(전체 공개)
    this.channels.register({ id: LOBBY_CHANNEL_ID, kind: "server", label: "main/lobby", members: null });
    // 재시작 시 기존 DM 채널을 복원(라우팅)하고, dm/index.json을 권위로 삼아
    // 양쪽 계정의 역색인을 재조정한다(크래시로 한쪽이 누락됐어도 복구).
    for (const rec of this.dm.all()) {
      const [a, b] = rec.members;
      this.channels.register({ id: rec.channelId, kind: "dm", label: rec.label, members: [a, b] });
      this.accounts.setDm(a, b, rec.channelId);
      this.accounts.setDm(b, a, rec.channelId);
    }
    // 서버 채널 복원(전체 공개)
    for (const c of this.servers.allChannels()) {
      this.channels.register({ id: c.channelId, kind: "server", label: `${c.serverName}/${c.channelName}`, members: null });
    }
    // 이전 버전 삭제·크래시로 남은 로그를 휴지통으로(손상된 서버 인덱스면 서버 쪽은 건너뜀 — 손으로 되살릴 여지)
    this.trashOps.sweepOrphans({ servers: !this.servers.sweepBlocked, dm: true });
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
      this.http.listen(this.opts.httpPort, "127.0.0.1", () => { this.httpListening = true; resolve(); });
    });
  }

  get httpAddress(): { port: number } {
    const a = this.http.address();
    return a && typeof a === "object" ? { port: a.port } : { port: this.opts.httpPort };
  }

  private onHttp(req: http.IncomingMessage, res: http.ServerResponse): void {
    // DNS rebinding 방어: 공격자 도메인이 127.0.0.1로 재바인딩돼도 Host가 다르므로 거부한다.
    if (!isAllowedHost(req.headers.host, this.httpAddress.port)) {
      res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Forbidden");
      return;
    }
    if (!this.isReady) {
      res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8", "Retry-After": "1" });
      res.end(this.msg("http_not_ready"));
      return;
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (url.pathname === "/") {
      // 뷰어 껍데기(데이터 없음). 페이지 스크립트가 #t= 티켓을 /session으로 바꾸고, 세션이 없으면 여는 법을 안내한다.
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(renderViewerHtml(this.lang()));
      return;
    }
    if (url.pathname === "/session") {
      const session = this.viewerAuth.redeem(url.searchParams.get("t"));
      if (!session) {
        this.viewerUnauthorized(res);
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ session }));
      return;
    }
    if (url.pathname !== "/events" && url.pathname !== "/accounts") {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not Found");
      return;
    }
    if (!this.viewerAuth.hasSession(url.searchParams.get("s"))) {
      this.viewerUnauthorized(res);
      return;
    }
    if (url.pathname === "/events") {
      if (this.sseClients.size >= this.limits.maxSse) {
        res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(this.msg("http_too_many_viewers"));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      // 실시간 메시지(pushSse)와 같은 모양으로 보낸다 — 라벨이 없으면 뷰어가 채널 ID로 대신 표시해 lobby가 두 이름으로 갈린다.
      const lobbyLabel = this.channels.getChannel(LOBBY_CHANNEL_ID)?.label ?? LOBBY_CHANNEL_ID;
      const history = this.channels
        .recent(LOBBY_CHANNEL_ID, 200)
        .map((m) => ({ ts: m.ts, channelId: m.channelId, fromUuid: m.from, fromName: m.fromName, text: m.text, channelLabel: lobbyLabel }));
      res.write(`event: init\ndata: ${JSON.stringify(history)}\n\n`);
      this.sseClients.add(res);
      this.cancelIdle();
      const drop = () => {
        this.sseClients.delete(res);
        this.maybeIdle(); // 이미 다른 경로(pushSse)가 지웠어도 유휴 여부는 다시 판단한다
      };
      req.on("close", drop);
      res.on("error", drop);
    } else {
      const list = this.accounts.list().map((a) => ({
        uuid: a.uuid,
        name: a.name,
        description: a.description ?? "",
        online: this.isOnline(a.uuid),
      }));
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-cache" });
      res.end(JSON.stringify(list));
    }
  }

  private viewerUnauthorized(res: http.ServerResponse): void {
    res.writeHead(401, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
    res.end("");
  }

  private pushSse(label: string, m: { ts: number; channelId: string; from: string; fromName: string; text: string }): void {
    const { from, ...rest } = m;
    const data = `data: ${JSON.stringify({ ...rest, fromUuid: from, channelLabel: label })}\n\n`;
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
    this.stopped = true;
    this.cancelIdle();
    this.tcp.close();
    this.http.close();
    for (const res of this.sseClients) res.end();
    this.sseClients.clear();
    // close()는 그 순간 쉬는 연결만 닫는다 — 방금 끝낸 SSE 연결은 keep-alive로 남아, 뷰어의 재접속·주기 요청이
    // 그 연결을 재사용하면 닫힌 Hub가 계속 응답하고 프로세스도 끝나지 않는다. 남은 연결을 모두 닫는다.
    this.http.closeAllConnections();
    for (const s of this.connections) s.destroy();
    this.connections.clear();
  }

  private onConnection(sock: net.Socket): void {
    if (this.connections.size >= this.limits.maxConnections) {
      // 상한이 찼으면 가장 오래된 무인증 연결을 끊고 새 연결을 받는다 — 무인증 연결을 쌓아(웹페이지 포함)
      // 정상 클라이언트를 막지 못하게. 모두 인증된 연결이면 새 연결을 거부한다.
      const victim = [...this.stateBySock].find(([v, st]) => !st.authed && !v.destroyed)?.[0];
      if (!victim) {
        sock.destroy();
        return;
      }
      // close 이벤트는 비동기라, 기다리지 않고 바로 셈에서 뺀다(몰린 연결이 같은 대상을 거듭 고르지 않게).
      victim.destroy();
      this.stateBySock.delete(victim);
      this.connections.delete(victim);
    }
    this.cancelIdle();
    this.connections.add(sock);
    const dec = new FrameDecoder({ maxFrame: MAX_REQUEST_FRAME });
    const state: ConnState = { uuid: null, waiter: null, sessionToken: null, hubNonce: null, authed: false, closed: false, helloPending: false };
    this.connStates.add(state);
    this.stateBySock.set(sock, state);
    // 인증하지 않은 연결이 자리를 오래 차지하지 못하게 한다. 보안 준비가 늦어도 정상 클라이언트가 잘리지 않도록 준비 완료 시점부터 센다.
    let authTimer: NodeJS.Timeout | null = null;
    this.ready.then(() => {
      if (sock.destroyed || state.authed) return;
      authTimer = setTimeout(() => { if (!state.authed) sock.destroy(); }, this.limits.authTimeoutMs);
      authTimer.unref();
    }, () => {});
    sock.on("data", (chunk) => {
      try {
        dec.push(chunk, (req: Request) => {
          try {
            this.dispatch(sock, state, req);
          } catch (e) {
            // 파일 잠김·손상 등 처리 중 예외가 Hub 프로세스를 죽이지 않게 한다(휴지통 저널은 남아 재시도·재시작 때 마무리).
            const id = (req as { id?: unknown } | null)?.id;
            if (typeof id === "number" && !sock.destroyed) {
              sock.write(encodeFrame({ ...this.err("io_error", "io_error", { detail: (e as Error).message }), id }));
            }
          }
        });
      } catch (e) {
        // 상한을 넘는 길이 선언(HTTP 요청 바이트·악의적 대용량)은 그 연결만 끊는다.
        if (e instanceof FrameTooLargeError) sock.destroy();
        else throw e;
      }
    });
    sock.on("close", () => {
      if (authTimer) clearTimeout(authTimer);
      this.stateBySock.delete(sock);
      this.connections.delete(sock);
      this.connStates.delete(state);
      if (state.uuid && state.waiter) this.removeWaiter(state.uuid, state.waiter);
      this.maybeIdle();
    });
    sock.on("error", () => {
      /* close 뒤따름 */
    });
  }

  private dispatch(
    sock: net.Socket,
    state: ConnState,
    req: Request,
  ): void {
    const r = req as { op?: unknown; id?: unknown } | null;
    if (!r || typeof r !== "object" || typeof r.op !== "string" || typeof r.id !== "number") return;
    const reply = (res: Omit<Response, "id">) => sock.write(encodeFrame({ ...res, id: req.id }));
    const needLogin = (): string | null => {
      if (!state.uuid) {
        reply(this.err("login_required", "login_required"));
        return null;
      }
      // 로그인 이후 계정이 admin에 의해 삭제됐을 수 있다 → 크래시 대신 재로그인 요구.
      if (!this.accounts.get(state.uuid)) {
        reply(this.err("account_gone", "account_gone"));
        state.uuid = null;
        return null;
      }
      return state.uuid;
    };
    const adminAuth = (): boolean => {
      const token = (req as { token?: unknown }).token;
      if (!this.adminKey || !verifyAdminToken(this.adminKey, token)) {
        reply(this.err("admin_auth_failed", "admin_auth_failed"));
        return false;
      }
      return true;
    };

    if (state.closed) return;
    if (req.op === "hello") {
      if (!this.isReady) {
        // 준비 전 hello 반복으로 대기 콜백이 쌓이지 않게 연결당 하나만 기다린다.
        if (state.helloPending) {
          reply(this.err("hello_pending", "hello_pending"));
          return;
        }
        state.helloPending = true;
      }
      this.ready.then(
        () => {
          state.helloPending = false;
          if (sock.destroyed || state.closed) return;
          if (!state.authed) state.hubNonce = newNonce();
          reply({ ok: true, magic: MAGIC, version: PROTOCOL_VERSION, nonce: state.hubNonce ?? undefined });
        },
        (e: Error) => {
          state.helloPending = false;
          if (!sock.destroyed) reply({ ok: false, code: "secure_setup_failed", error: e.message });
        },
      );
      return;
    }
    if (req.op === "auth") {
      this.handleAuth(sock, state, req as { nonce?: unknown; proof?: unknown }, reply);
      return;
    }
    if (!state.authed) {
      reply(this.err("auth_required", "auth_required"));
      return;
    }

    switch (req.op) {

      case "login": {
        if (typeof req.uuid !== "string" || req.uuid.length === 0) {
          reply(this.err("uuid_required", "uuid_required"));
          return;
        }
        // uuid는 계정 파일 이름이 된다 → 경로 조작 문자를 거부한다.
        if (!isSafeAccountId(req.uuid)) {
          reply(this.err("uuid_invalid", "uuid_invalid"));
          return;
        }
        let loginName: string | undefined;
        // 이름 힌트는 새 계정을 만들 때만 쓴다 — 기존 계정은 힌트를 무시한다(긴 UPLINK_ACCOUNT_NAME으로 업그레이드 뒤 막히지 않게).
        if (req.name !== undefined && !this.accounts.get(req.uuid)) {
          const v = validateName(req.name, "account", this.nameGuard("login", req.uuid));
          if (!v.ok) {
            reply(this.err(v.code, "name_invalid", v.params));
            return;
          }
          loginName = v.name;
        }
        const token = typeof req.sessionToken === "string" && req.sessionToken.length > 0 ? req.sessionToken : null;
        if (req.exclusive === true) {
          // 같은 계정을 다른 세션(다른 sessionToken 또는 비독점 연결)이 쓰고 있으면 거부. 상태는 바꾸지 않는다.
          for (const other of this.connStates) {
            if (other !== state && other.uuid === req.uuid && (token === null || other.sessionToken !== token)) {
              reply(this.err("account_in_use", "account_in_use"));
              return;
            }
          }
        }
        const acc = this.accounts.getOrCreate(req.uuid, loginName);
        // 다른 계정으로 전환: 이전 계정으로 걸어 둔 wait를 빈 결과로 끝낸다.
        // (남겨 두면 이전 계정 앞 메시지가 이 연결로 새거나, 새 주인이 받지 못하고 유실된다.)
        if (state.uuid && state.uuid !== acc.uuid && state.waiter) {
          const old = state.waiter;
          this.removeWaiter(state.uuid, old);
          state.waiter = null;
          old.resolve([]);
        }
        state.uuid = acc.uuid;
        state.sessionToken = token;
        reply({ ok: true, uuid: acc.uuid, name: acc.name });
        return;
      }

      case "viewer_ticket": {
        // 뷰어 포트를 실제로 연 Hub만 티켓을 준다 → 다른 사용자가 점유한 포트로 티켓을 보내지 않는다.
        if (!this.httpListening) {
          reply(this.err("viewer_unavailable", "viewer_unavailable", { port: this.opts.httpPort }));
          return;
        }
        // 티켓은 URL 조각(#)에 둔다 — 서버 요청줄·Referer에 실리지 않는다.
        reply({ ok: true, url: `http://127.0.0.1:${this.httpAddress.port}/#t=${this.viewerAuth.issueTicket()}` });
        return;
      }

      case "whoami": {
        const uuid = needLogin();
        if (!uuid) return;
        const a = this.accounts.get(uuid)!;
        reply({ ok: true, uuid: a.uuid, name: a.name, description: a.description ?? "" });
        return;
      }

      case "set_name": {
        const uuid = needLogin();
        if (!uuid) return;
        const v = validateName(req.name, "account", this.nameGuard("set_name", uuid));
        if (!v.ok) {
          reply(this.err(v.code, "name_invalid", v.params));
          return;
        }
        reply({ ok: true, name: this.accounts.setName(uuid, v.name) });
        return;
      }

      case "list_accounts": {
        // 역할 선택 전에도 누가 있는지 볼 수 있도록 로그인은 불필요(인증된 연결만).
        reply({ ok: true, accounts: this.accounts.list().map((a) => ({ ...a, online: this.isOnline(a.uuid) })) });
        return;
      }

      case "open_dm": {
        const uuid = needLogin();
        if (!uuid) return;
        if (typeof req.peer !== "string" || req.peer.length === 0) {
          reply(this.err("peer_required", "peer_required"));
          return;
        }
        const peer = this.resolvePeer(req.peer, uuid);
        if ("code" in peer) {
          reply(this.err(peer.code, peer.code, peer.params));
          return;
        }
        reply({ ok: true, channelId: this.ensureDm(uuid, peer.uuid) });
        return;
      }

      case "list_dms": {
        const uuid = needLogin();
        if (!uuid) return;
        const me = this.accounts.get(uuid)!;
        const dms = Object.entries(me.dm).map(([peerUuid, channelId]) => ({
          peer: peerUuid,
          peerName: this.accounts.get(peerUuid)?.name ?? peerUuid.slice(0, 8),
          channelId,
          peerDescription: this.accounts.get(peerUuid)?.description ?? "",
          peerOnline: this.isOnline(peerUuid),
        }));
        reply({ ok: true, dms });
        return;
      }

      case "create_server": {
        const uuid = needLogin();
        if (!uuid) return;
        const v = validateName(req.name, "server", this.nameGuard("create_server", uuid));
        if (!v.ok) {
          reply(this.err(v.code, "name_invalid", v.params));
          return;
        }
        const sameServer = this.servers.listServers().find((s) => nameKey(s.name) === nameKey(v.name));
        if (sameServer) {
          reply(this.err("server_name_taken", "server_name_taken", { name: sameServer.name, id: sameServer.id }));
          return;
        }
        const srv = this.servers.createServer(v.name);
        reply({ ok: true, serverId: srv.id });
        return;
      }

      case "list_servers": {
        if (!needLogin()) return;
        reply({
          ok: true,
          servers: this.servers
            .listServers()
            .map((s) => ({ serverId: s.id, name: s.name, channelCount: s.channels.length })),
        });
        return;
      }

      case "create_channel": {
        const uuid = needLogin();
        if (!uuid) return;
        const srv = this.servers.getServer(req.serverId);
        if (!srv) {
          reply(this.err("server_not_found", "server_not_found", { id: req.serverId }));
          return;
        }
        const v = validateName(req.name, "channel", this.nameGuard("create_channel", uuid));
        if (!v.ok) {
          reply(this.err(v.code, "name_invalid", v.params));
          return;
        }
        const sameChannel = srv.channels.find((c) => nameKey(c.name) === nameKey(v.name));
        if (sameChannel) {
          reply(this.err("channel_name_taken", "channel_name_taken", { name: sameChannel.name, id: sameChannel.id }));
          return;
        }
        if (srv.channels.length >= this.config.maxChannelsPerServer) {
          reply(this.err("channel_limit", "channel_limit", { max: this.config.maxChannelsPerServer }));
          return;
        }
        const ch = this.servers.addChannel(srv.id, v.name);
        this.channels.register({ id: ch.id, kind: "server", label: `${srv.name}/${ch.name}`, members: null });
        reply({ ok: true, channelId: ch.id });
        return;
      }

      case "list_channels": {
        if (!needLogin()) return;
        const srv = this.servers.getServer(req.serverId);
        if (!srv) {
          reply(this.err("server_not_found", "server_not_found", { id: req.serverId }));
          return;
        }
        reply({ ok: true, channels: srv.channels.map((c) => ({ channelId: c.id, name: c.name })) });
        return;
      }

      case "delete_channel": {
        const uuid = needLogin();
        if (!uuid) return;
        if (!this.config.allowDevDelete) {
          reply(this.err("dev_delete_disabled", "dev_delete_disabled"));
          return;
        }
        if (!this.trashOps.deleteChannel(req.channelId, "mcp")) {
          reply(this.err("channel_not_found", "channel_not_found", { id: req.channelId }));
          return;
        }
        reply({ ok: true });
        return;
      }

      case "delete_server": {
        const uuid = needLogin();
        if (!uuid) return;
        if (!this.config.allowDevDelete) {
          reply(this.err("dev_delete_disabled", "dev_delete_disabled"));
          return;
        }
        if (!this.trashOps.deleteServer(req.serverId, "mcp")) {
          reply(this.err("server_not_found", "server_not_found", { id: req.serverId }));
          return;
        }
        reply({ ok: true });
        return;
      }

      case "send": {
        const uuid = needLogin();
        if (!uuid) return;
        if (typeof req.text !== "string" || req.text.length === 0) {
          reply(this.err("text_invalid", "text_invalid"));
          return;
        }
        if (req.text.length > MAX_TEXT_LENGTH) {
          reply(this.err("text_too_long", "text_too_long", { max: MAX_TEXT_LENGTH }));
          return;
        }
        const ch = this.channels.getChannel(req.channelId);
        if (!ch) {
          reply(this.err("channel_not_found", "channel_not_found", { id: req.channelId }));
          return;
        }
        if (ch.members && !ch.members.includes(uuid)) {
          reply(this.err("channel_forbidden", "channel_forbidden"));
          return;
        }
        const name = this.accounts.get(uuid)!.name;
        // 본문 감독(v2.1.2): 길이는 원래 기준으로 위에서 검사했다. 줄바꿈·탭은 유지, 숨은 문자는 이스케이프·기록.
        const text = this.security.guard(req.text, { source: "request", where: "send", field: "text", account: uuid, keepLineBreaks: true });
        const msg = this.channels.append(ch.id, uuid, name, text);
        reply({ ok: true, seq: msg.seq });
        this.fanout(ch, msg.from, name, text, msg.ts);
        return;
      }

      case "read": {
        const uuid = needLogin();
        if (!uuid) return;
        const ch = this.channels.getChannel(req.channelId);
        if (!ch) {
          reply(this.err("channel_not_found", "channel_not_found", { id: req.channelId }));
          return;
        }
        if (ch.members && !ch.members.includes(uuid)) {
          reply(this.err("channel_forbidden", "channel_forbidden"));
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
        // 숫자가 아닌 값(문자열·null·NaN·무한대)이면 기본 30초 — Math.max(NaN)이 즉시 응답이 되지 않게.
        const asked = typeof req.timeoutMs === "number" && Number.isFinite(req.timeoutMs) ? req.timeoutMs : 30000;
        const timeoutMs = Math.min(Math.max(asked, 1000), 120000);
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

      case "admin_snapshot": {
        if (!adminAuth()) return;
        reply({
          ok: true,
          config: { ...this.config },
          snapshotServers: this.servers.listServers().map((s) => ({
            id: s.id,
            name: s.name,
            channels: s.channels.map((c) => ({ id: c.id, name: c.name })),
          })),
          snapshotAccounts: this.accounts.list().map((a) => ({
            uuid: a.uuid,
            name: a.name,
            description: a.description ?? "",
            online: this.isOnline(a.uuid),
          })),
          snapshotDms: this.dm.all().map((r) => ({ channelId: r.channelId, members: [...r.members], label: r.label })),
          trash: this.trash.list(),
          securityFindings: this.security.recent(100),
        });
        return;
      }

      case "admin_set_config": {
        if (!adminAuth()) return;
        const patch = req.patch ?? {};
        const isPosInt = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v >= 1;
        if (patch.maxChannelsPerServer !== undefined && !isPosInt(patch.maxChannelsPerServer)) {
          reply(this.err("config_max_invalid", "config_max_invalid"));
          return;
        }
        if (patch.inboxMaxBatch !== undefined && !isPosInt(patch.inboxMaxBatch)) {
          reply(this.err("config_batch_invalid", "config_batch_invalid"));
          return;
        }
        if (patch.allowDevDelete !== undefined && typeof patch.allowDevDelete !== "boolean") {
          reply(this.err("config_dev_delete_invalid", "config_dev_delete_invalid"));
          return;
        }
        if (patch.language !== undefined && patch.language !== "ko" && patch.language !== "en") {
          reply(this.err("config_language_invalid", "config_language_invalid"));
          return;
        }
        if (patch.maxChannelsPerServer !== undefined) this.config.maxChannelsPerServer = patch.maxChannelsPerServer;
        if (patch.inboxMaxBatch !== undefined) this.config.inboxMaxBatch = patch.inboxMaxBatch;
        if (patch.allowDevDelete !== undefined) this.config.allowDevDelete = patch.allowDevDelete;
        if (patch.language !== undefined) this.config.language = patch.language as "ko" | "en"; // 위에서 검증함
        saveConfig(this.opts.dataDir, this.config);
        reply({ ok: true, config: { ...this.config } });
        return;
      }

      case "admin_delete_channel": {
        if (!adminAuth()) return;
        if (!this.trashOps.deleteChannel(req.channelId, "admin")) {
          reply(this.err("channel_not_found", "channel_not_found", { id: req.channelId }));
          return;
        }
        reply({ ok: true });
        return;
      }

      case "admin_delete_server": {
        if (!adminAuth()) return;
        if (!this.trashOps.deleteServer(req.serverId, "admin")) {
          reply(this.err("server_not_found", "server_not_found", { id: req.serverId }));
          return;
        }
        reply({ ok: true });
        return;
      }

      case "admin_delete_dm": {
        if (!adminAuth()) return;
        if (!this.trashOps.deleteDm((req as { channelId?: unknown }).channelId, "admin")) {
          reply(this.err("dm_not_found", "dm_not_found"));
          return;
        }
        reply({ ok: true });
        return;
      }

      case "admin_delete_account": {
        if (!adminAuth()) return;
        if (!this.accounts.get(req.uuid)) {
          reply(this.err("account_not_found", "account_not_found", { id: req.uuid }));
          return;
        }
        this.trashOps.deleteAccount(req.uuid, "admin");
        reply({ ok: true });
        return;
      }

      case "admin_restore_trash": {
        if (!adminAuth()) return;
        const q = req as { trashId?: unknown; confirmRename?: unknown };
        const r = this.trashOps.restore(q.trashId, q.confirmRename === true);
        if (r.ok) reply({ ok: true, restored: r.report });
        else reply({ ...this.err(r.code, r.key, r.params), ...(r.conflicts ? { conflicts: r.conflicts } : {}) });
        return;
      }

      case "admin_empty_trash": {
        if (!adminAuth()) return;
        reply({ ok: true, removed: this.trash.empty() });
        return;
      }

      case "set_profile": {
        const uuid = needLogin();
        if (!uuid) return;
        const d = (req as { description?: unknown }).description;
        if (typeof d !== "string" || d.length > 500) {
          reply(this.err("description_invalid", "description_invalid"));
          return;
        }
        // 길이는 원래 문자열 기준으로 위에서 검사했다. 저장은 위장 문자를 이스케이프한 값(v2.1.2 입력 경계).
        reply({ ok: true, description: this.accounts.setDescription(uuid, this.security.guard(d, { source: "request", where: "set_profile", field: "description", account: uuid })) });
        return;
      }

      case "account_status": {
        const uuids = (req as { uuids?: unknown }).uuids;
        if (!Array.isArray(uuids) || uuids.length > 100 || !uuids.every((u) => typeof u === "string")) {
          reply(this.err("uuids_invalid", "uuids_invalid"));
          return;
        }
        reply({
          ok: true,
          statuses: (uuids as string[]).map((u) => {
            const a = this.accounts.get(u);
            return { uuid: u, exists: !!a, name: a?.name ?? "", description: a?.description ?? "", online: this.isOnline(u) };
          }),
        });
        return;
      }

      default:
        reply(this.err("unknown_op", "unknown_op"));
        return;
    }
  }

  /** v3 핸드셰이크 2단계. 연결당 1회 — 틀리면 응답 후 연결을 끊는다. */
  private handleAuth(sock: net.Socket, state: ConnState, q: { nonce?: unknown; proof?: unknown }, reply: (res: Omit<Response, "id">) => void): void {
    if (state.authed) {
      reply(this.err("already_authed", "already_authed"));
      return;
    }
    const hubNonce = state.hubNonce;
    if (!hubNonce || !this.clientKey) {
      reply(this.err("auth_required", "auth_hello_first"));
      return;
    }
    state.hubNonce = null;
    if (!isNonce(q.nonce) || !proofEquals(clientProof(this.clientKey, hubNonce, q.nonce), q.proof)) {
      reply(this.err("auth_failed", "auth_failed"));
      state.closed = true;
      sock.end();
      setTimeout(() => sock.destroy(), 1000).unref();
      return;
    }
    state.authed = true;
    reply({ ok: true, proof: hubProof(this.clientKey, hubNonce, q.nonce) });
  }

  /** 계정 인박스에서 커서 이후를 상한까지 꺼내고 커서를 전진시킨다. */
  private drain(uuid: string): InboxItem[] {
    const acc = this.accounts.get(uuid);
    if (!acc) return []; // 삭제된 계정(끊기기 전 잔여 호출 등)에서도 크래시하지 않는다
    const cursor = acc.inboxCursor;
    const items = this.inbox.since(uuid, cursor, this.config.inboxMaxBatch);
    if (items.length) {
      const last = items[items.length - 1].seq;
      this.accounts.setInboxCursor(uuid, last);
      // 소비분이 많이 쌓였을 때만 압축해 인박스 무한 증가를 막는다(재작성은 드물게).
      if (this.inbox.size(uuid) > INBOX_COMPACT_THRESHOLD) this.inbox.compact(uuid, last);
    }
    return items;
  }

  /** peer를 UUID(우선) 또는 유일한 이름으로 해석한다. */
  private resolvePeer(peer: string, me: string): { uuid: string } | { code: "dm_self" | "peer_not_found" | "peer_ambiguous"; params?: object } {
    const byId = this.accounts.get(peer);
    if (byId) {
      if (byId.uuid === me) return { code: "dm_self" };
      return { uuid: byId.uuid };
    }
    const matches = this.accounts.list().filter((a) => a.name === peer);
    if (matches.length === 0) return { code: "peer_not_found", params: { peer } };
    if (matches.length > 1) return { code: "peer_ambiguous", params: { count: matches.length, peer } };
    if (matches[0].uuid === me) return { code: "dm_self" };
    return { uuid: matches[0].uuid };
  }

  /** 기존 DM이면 그 channelId, 없으면 생성. 신규/기존 무관하게 양쪽 역색인을 항상 보장한다. */
  private ensureDm(a: string, b: string): string {
    let rec = this.dm.findByPair(a, b);
    if (!rec) {
      // b는 resolvePeer가 보장한 기존 계정이다(유령 계정 생성 방지 위해 get 사용).
      const aName = this.accounts.get(a)!.name;
      const bName = this.accounts.get(b)!.name;
      rec = this.dm.create(a, b, `${aName}-${bName}`);
      this.channels.register({ id: rec.channelId, kind: "dm", label: rec.label, members: [a, b] });
    }
    // 기존이든 신규든 양쪽 역색인을 다시 쓴다 → 이전 크래시로 한쪽이 빠졌으면 자가 복구.
    this.accounts.setDm(a, b, rec.channelId);
    this.accounts.setDm(b, a, rec.channelId);
    return rec.channelId;
  }

  /** 그 계정으로 로그인된 연결이 하나라도 살아 있는가. */
  protected isOnline(uuid: string): boolean {
    for (const s of this.connStates) if (s.uuid === uuid) return true;
    return false;
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
    this.pushSse(ch.label, { ts, channelId: ch.id, from, fromName, text });
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
    if (this.opts.idleShutdownMs <= 0 || this.stopped) return;
    // 세션(TCP)도 열린 뷰어(SSE)도 없을 때만 유휴 종료를 센다 — 뷰어 탭이 열려 있으면 Hub를 살려 둔다.
    if (this.connections.size > 0 || this.sseClients.size > 0) return;
    this.cancelIdle();
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
