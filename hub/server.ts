import net from "node:net";
import http from "node:http";
import path from "node:path";
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
import { StorageError } from "./connection/storage/backend.js";
import { parseRepo } from "./connection/storage/github.js";
import { parseSupabaseUrl } from "./connection/storage/supabase.js";
import { ConnectionManager } from "./connection/manager.js";
import { isProfileId } from "../shared/cryptoProfile.js";
import {
  MAGIC,
  PROTOCOL_VERSION,
  LOBBY_CHANNEL_ID,
  MAX_TEXT_LENGTH,
  MAX_READ_LIMIT,
  MAX_STORED_TEXT_LENGTH,
  NAME_MAX,
  Channel,
  InboxItem,
  MessageOrigin,
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

/** 통신 연결이 살아 있는지(v3.0) — 통신 서버가 리스닝 중이거나 참여 공간 하나라도 연결됨. */
export interface ConnStatusSource {
  hasLiveConnection(): boolean;
}

export interface HubOptions {
  tcpPort: number;
  httpPort: number;
  dataDir: string;
  idleShutdownMs: number;
  limits?: Partial<HubLimits>;
  /** 통신 참여 재접속 간격(시험용, v3.0). */
  connBackoffMs?: number[];
  /** 시험 전용: 저장소 API 주소(가짜 GitHub). */
  storageApiBase?: string;
  /** 시험 전용: Supabase 주소로 http 가짜 서버를 허용. */
  supabaseInsecureForTest?: boolean;
  /** 시험 전용: 방식 1 공간 저장소(가짜). */
  space1BackendForTest?: (repo: string) => import("./connection/storage/backend.js").StorageBackend;
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
  /** 통신 연결 상태(v3.0) — 새 연결 계정 로그인 조건. 통신 관리자가 붙기 전에는 항상 연결 없음. */
  protected connStatus: ConnStatusSource = { hasLiveConnection: () => false };
  /** 통신 관리자(v3.0). 데이터 적재 때 만든다 — 통신 설정이 없으면 아무 일도 하지 않는다. */
  conn!: ConnectionManager;

  setConnStatusSource(src: ConnStatusSource): void {
    this.connStatus = src;
  }

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

  /** 이름 요청의 감독(validateName에 넘긴다). */
  private nameGuard(where: string, account: unknown): (s: string) => string {
    return (s) => this.security.guard(s, { source: "request", where, field: "name", ...(typeof account === "string" ? { account } : {}) });
  }

  /** 오류 응답: 판단용 code와 표시용 문구. */
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
      // 통신(v3.0): 설정이 있을 때만 리스너·참여 연결을 연다. 실패해도 로컬 Hub는 계속 동작한다.
      try {
        await this.conn.start();
      } catch (e) {
        process.stderr.write(`${this.msg("log_conn_start_failed", { detail: (e as Error).message })}\n`);
      }
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
    // 손상 원본을 백업하지 못해 이번 실행 동안 저장을 멈춘 색인은 알린다 — 이 실행에서 만든 DM·서버는 재시작 뒤 남지 않는다(v2.1.3).
    for (const [store, sub] of [[this.dm, "dm"], [this.servers, "servers"]] as const) {
      if (store.saveBlocked) {
        process.stderr.write(`${this.msg("log_index_save_blocked", { file: path.join(this.opts.dataDir, sub, "index.json") })}\n`);
      }
    }
    // 통신 관리자는 휴지통보다 먼저 만든다 — 통신 항목의 크래시 재실행(recoverPending)이 통신 저장소를 쓴다. 생성자는 파일을 건드리지 않는다.
    this.conn = new ConnectionManager({
      dataDir: this.opts.dataDir,
      accounts: this.accounts,
      channels: this.channels,
      guard: this.security.guard,
      deliver: (ch, msg, skip) => this.fanout(ch, msg.from, msg.fromName, msg.text, msg.ts, msg.origin, skip),
      ...(this.opts.connBackoffMs ? { backoffMs: this.opts.connBackoffMs } : {}),
      ...(this.opts.storageApiBase ? { storageApiBase: this.opts.storageApiBase } : {}),
      ...(this.opts.supabaseInsecureForTest ? { supabaseInsecureForTest: true } : {}),
      ...(this.opts.space1BackendForTest ? { space1BackendForTest: this.opts.space1BackendForTest } : {}),
      localServer: (id) => {
        const s = this.servers.getServer(id);
        return s ? { name: s.name, channels: s.channels.map((c) => ({ channelId: c.id, name: c.name })) } : null;
      },
    });
    this.trash = new TrashStore({ dir: this.opts.dataDir });
    this.trashOps = new TrashOps({
      dataDir: this.opts.dataDir, servers: this.servers, dm: this.dm, accounts: this.accounts,
      channels: this.channels, inbox: this.inbox, trash: this.trash,
      maxChannelsPerServer: () => this.config.maxChannelsPerServer,
      lang: () => this.lang(),
      comms: () => this.conn.trashDeps(),
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
    this.security.finishStartupScan();
    this.setConnStatusSource(this.conn);
  }

  /** 통신 관리 op(v3.0, 관리 토큰 확인 뒤에만 호출). MCP 세션은 쓸 수 없다. */
  private async connAdmin(q: { op: string } & Record<string, unknown>): Promise<Omit<Response, "id"> & Record<string, unknown>> {
    const c = this.conn;
    const fail = (code: string, key: HubKey, params?: object) => this.err(code, key, params);
    const thrown = (e: unknown) => {
      const code = (e as Error).message;
      if (code === "name_invalid") return fail("name_invalid", "name_invalid", { kind: "account", max: NAME_MAX });
      if (code === "server_not_enabled" || code === "server_not_found") return fail(code, code === "server_not_enabled" ? "server_not_enabled" : "server_not_found", { id: q.serverId });
      if (code === "server_not_configured") return fail("server_not_enabled", "server_not_enabled");
      if (e instanceof StorageError) return fail(e.code, "storage_failed", { code: e.code });
      if (code === "storage_not_configured") return fail(code, "storage_not_configured");
      if (/^(invite_|space1_|space_not_found)/.test(code)) return fail(code, "conn_op_failed", { code });
      return fail("conn_op_failed", "conn_op_failed", { code: (e as NodeJS.ErrnoException).code ?? code });
    };
    try {
      switch (q.op) {
        case "admin_conn_status":
          return { ok: true, ...c.status() };
        case "admin_conn_set_user":
          return { ok: true, name: c.setUserName(String(q.name ?? "")) };
        case "admin_conn_enable_server": {
          const port = q.port;
          if (typeof port !== "number" || !Number.isInteger(port) || port < 0 || port > 65535) return fail("port_invalid", "port_invalid");
          if (!isProfileId(q.profile)) return fail("profile_invalid", "profile_invalid");
          const bindHost = typeof q.bindHost === "string" && q.bindHost.length > 0 && q.bindHost.length <= 255 ? q.bindHost : undefined;
          const actual = await c.enableServer({ port, profile: q.profile, spaceName: String(q.spaceName ?? ""), burnOnJoin: q.burnOnJoin === true /* 설계: 파기는 사용자가 켰을 때만 */, ...(bindHost ? { bindHost } : {}) });
          return { ok: true, port: actual };
        }
        case "admin_conn_disable_server":
          await c.disableServer();
          return { ok: true };
        case "admin_conn_create_server":
          return { ok: true, serverId: c.createCommsServer(String(q.name ?? "")) };
        case "admin_conn_create_channel":
          return { ok: true, channelId: c.createCommsChannel(String(q.serverId ?? ""), String(q.name ?? "")) };
        case "admin_conn_set_shared": {
          const ids = q.serverIds;
          if (!Array.isArray(ids) || ids.length > 100 || !ids.every((x) => typeof x === "string")) return fail("shared_invalid", "shared_invalid");
          c.setShared(ids as string[]);
          return { ok: true };
        }
        case "admin_conn_create_invite": {
          const host = q.host;
          if (typeof host !== "string" || host.trim().length === 0 || host.length > 253) return fail("host_invalid", "host_invalid");
          const ms = q.expiresInMs;
          if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 1 || ms > 30 * 24 * 3600_000) return fail("expires_invalid", "expires_invalid");
          const label = typeof q.label === "string" ? q.label : "";
          return { ok: true, ...c.createInvite(label, host.trim(), ms) };
        }
        case "admin_conn_join": {
          const r = await c.join(String(q.code ?? ""));
          return r.ok ? { ok: true, spaceId: r.spaceId } : fail(r.code, "conn_op_failed", { code: r.code });
        }
        case "admin_conn_storage_set": {
          if (q.kind === "supabase") {
            // Supabase: 프로젝트 주소(https://<ref>.supabase.co), secret key, 버킷(기본 agent-uplink). 키는 응답·기록에 되돌려 쓰지 않는다.
            const key = q.key;
            const interval = q.intervalMin ?? 5;
            const bucket = q.bucket ?? "agent-uplink";
            const url = typeof q.url === "string" ? (this.opts.supabaseInsecureForTest ? q.url.trim().replace(/\/+$/, "") : parseSupabaseUrl(q.url)) : null;
            const ok = !!url && typeof key === "string" && key.length > 0 && key.length <= 1000 && !/\s/.test(key)
              && typeof bucket === "string" && /^[a-z0-9][a-z0-9._-]{0,62}$/.test(bucket)
              && typeof interval === "number" && Number.isInteger(interval) && interval >= 1 && interval <= 60;
            if (!ok) return fail("storage_config_invalid", "storage_config_invalid");
            const r = await c.storageSet({ kind: "supabase", url: url!, bucket: bucket as string, intervalMin: interval as number }, key as string);
            return { ok: true, recoveryKey: r.recoveryKey };
          }
          // 관리 토큰 칸(token)과 겹치지 않게 저장소 토큰은 ghToken. 토큰은 응답·기록에 되돌려 쓰지 않는다.
          const tok = q.ghToken;
          const interval = q.intervalMin ?? 5;
          const branch = q.branch;
          const ok = q.kind === "github" && typeof q.repo === "string" && parseRepo(q.repo) !== null
            && typeof tok === "string" && tok.length > 0 && tok.length <= 500 && !/\s/.test(tok)
            && typeof interval === "number" && Number.isInteger(interval) && interval >= 1 && interval <= 60
            && (branch === undefined || (typeof branch === "string" && /^[\w./-]{1,255}$/.test(branch)));
          if (!ok) return fail("storage_config_invalid", "storage_config_invalid");
          const r = await c.storageSet({ kind: "github", repo: q.repo as string, ...(branch ? { branch: branch as string } : {}), intervalMin: interval as number }, tok as string);
          return { ok: true, recoveryKey: r.recoveryKey };
        }
        case "admin_conn_storage_prune_set": {
          const days = q.days ?? 30;
          if (typeof q.enabled !== "boolean" || typeof days !== "number" || !Number.isInteger(days) || days < 7 || days > 365) return fail("storage_config_invalid", "storage_config_invalid");
          c.uploader.setPrune({ enabled: q.enabled, days });
          return { ok: true, storage: c.uploader.status() };
        }
        case "admin_conn_storage_status":
          return { ok: true, storage: c.uploader.status() };
        // 응답의 messages는 개수(숫자) — 프로토콜 Response.messages(메시지 배열)와 이름만 같아 타입을 넓힌다.
        case "admin_conn_storage_upload_now":
          return { ok: true, ...(await c.uploader.uploadNow()) } as unknown as Omit<Response, "id">;
        case "admin_conn_storage_verify":
          return { ok: true, ...(await c.uploader.verify()) } as unknown as Omit<Response, "id">;
        case "admin_conn_storage_clear":
          c.uploader.clear();
          return { ok: true };
        case "admin_conn_delete_channel":
          return this.trashOps.deleteCommsChannel(String(q.channelId ?? ""), "admin") ? { ok: true } : fail("channel_not_found", "channel_not_found", { id: q.channelId });
        case "admin_conn_delete_server":
          return this.trashOps.deleteCommsServer(String(q.serverId ?? ""), "admin") ? { ok: true } : fail("server_not_found", "server_not_found", { id: q.serverId });
        // ───── 방식 1 공간(v3.0 4단계, GitHub만) ─────
        case "admin_conn_s1_create": {
          const repo = q.repo;
          const tok = q.ghToken;
          const interval = q.intervalSec ?? 30;
          const branch = q.branch;
          const ok = typeof repo === "string" && parseRepo(repo) !== null && typeof tok === "string" && tok.length > 0 && tok.length <= 500 && !/\s/.test(tok)
            && typeof q.localServerId === "string" && typeof interval === "number" && Number.isInteger(interval) && interval >= 10 && interval <= 600
            && (branch === undefined || (typeof branch === "string" && /^[\w./-]{1,255}$/.test(branch)));
          if (!ok) return fail("space1_config_invalid", "conn_op_failed", { code: "space1_config_invalid" });
          const id = await c.space1Create({ spaceName: String(q.spaceName ?? ""), localServerId: q.localServerId as string, repo: repo as string, ...(branch ? { branch: branch as string } : {}), token: tok as string, intervalSec: interval as number });
          return { ok: true, spaceId: id };
        }
        case "admin_conn_s1_invite": {
          const ms = q.expiresInMs;
          if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 1 || ms > 30 * 24 * 3600_000) return fail("expires_invalid", "expires_invalid");
          return { ok: true, code: c.space1Invite(String(q.spaceId ?? ""), String(q.label ?? ""), ms) };
        }
        case "admin_conn_s1_join": {
          const tok = q.ghToken;
          if (typeof q.code !== "string" || q.code.length > 8192 || typeof tok !== "string" || tok.length === 0 || tok.length > 500 || /\s/.test(tok)) return fail("space1_config_invalid", "conn_op_failed", { code: "space1_config_invalid" });
          return { ok: true, spaceId: await c.space1Join(q.code, tok) };
        }
        case "admin_conn_s1_revoke":
          return (await c.space1Revoke(String(q.spaceId ?? ""), String(q.hubId ?? ""))) ? { ok: true } : fail("member_not_found", "member_not_found");
        case "admin_conn_s1_status":
          return { ok: true, spaces: c.space1Status() };
        case "admin_conn_s1_sync_now":
          return { ok: true, space: await c.space1SyncNow(String(q.spaceId ?? "")) };
        case "admin_conn_s1_leave":
          c.space1Leave(String(q.spaceId ?? ""));
          return { ok: true };
        case "admin_conn_revoke":
          return c.revoke(String(q.memberId ?? "")) ? { ok: true } : fail("member_not_found", "member_not_found");
        default:
          return fail("unknown_op", "unknown_op");
      }
    } catch (e) {
      return thrown(e);
    }
  }

  /** 시험용: 채널이 등록돼 있는가. */
  hasChannelForTest(id: string): boolean {
    return !!this.channels?.getChannel(id);
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
    void this.conn?.stop();
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
        // 계정 영역(v3.0): 한 계정은 한 영역에만 속한다. 새 연결 계정 로그인은 통신 연결이 살아 있을 때만
        // (설계 12-3) — 이미 쓰던 세션의 재로그인(resume)은 Hub 재시작 직후 연결이 아직 안 붙었어도 허용한다.
        const area = req.area === "connection" ? "connection" : undefined;
        const existingAcc = this.accounts.get(req.uuid);
        if (existingAcc && existingAcc.area !== area) {
          reply(this.err("area_mismatch", "area_mismatch"));
          return;
        }
        if (area === "connection" && req.resume !== true && !this.connStatus.hasLiveConnection()) {
          reply(this.err("connection_unavailable", "connection_unavailable"));
          return;
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
        const acc = this.accounts.getOrCreate(req.uuid, loginName, area);
        if (!existingAcc && area === "connection") this.conn.accountsChanged();
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
        if (this.accounts.get(uuid)?.area === "connection") this.conn.accountsChanged();
        return;
      }

      case "list_accounts": {
        // 역할 선택 전에도 누가 있는지 볼 수 있도록 로그인은 불필요(인증된 연결만).
        const localAccounts = this.accounts.list().map((a) => ({ ...a, online: this.isOnline(a.uuid) }));
        // 다른 Hub의 연결 계정(v3.0)은 연결 계정에게만 보인다.
        const viewerIsConn = !!state.uuid && this.accounts.get(state.uuid)?.area === "connection";
        reply({ ok: true, accounts: viewerIsConn ? [...localAccounts, ...this.conn.remoteAccounts()] : localAccounts });
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
        const me = needLogin();
        if (!me) return;
        const localServers = this.servers.listServers().map((s) => ({ serverId: s.id, name: s.name, channelCount: s.channels.length }));
        // 연결 계정(v3.0)에게는 통신 서버(Connection Communications)와 원격 공유 서버도.
        const meIsConn = this.accounts.get(me)?.area === "connection";
        // 방식 1 공간(v3.0 4단계)은 로컬 영역이라 모든 계정에게 보인다.
        const space1 = this.conn.space1ServersFor();
        reply({ ok: true, servers: meIsConn ? [...localServers, ...space1, ...this.conn.serversFor()] : [...localServers, ...space1] });
        return;
      }

      case "create_channel": {
        const uuid = needLogin();
        if (!uuid) return;
        const srv = this.servers.getServer(req.serverId);
        // 통신 서버(Connection Communications)의 채널은 이 Hub의 연결 계정 AI도 만들 수 있다(사용자 결정 2026-11-06).
        // 원격 서버(r:…)에는 만들 수 없다 — 그 서버의 주인만.
        const comms = !srv && this.accounts.get(uuid)?.area === "connection" && typeof req.serverId === "string" ? this.conn.comms.getServer(req.serverId) : undefined;
        if (!srv && !comms) {
          reply(this.err("server_not_found", "server_not_found", { id: req.serverId }));
          return;
        }
        if (comms) {
          const cv = validateName(req.name, "channel", this.nameGuard("create_channel", uuid));
          if (!cv.ok) {
            reply(this.err(cv.code, "name_invalid", cv.params));
            return;
          }
          const same = comms.channels.find((c) => nameKey(c.name) === nameKey(cv.name));
          if (same) {
            reply(this.err("channel_name_taken", "channel_name_taken", { name: same.name, id: same.id }));
            return;
          }
          if (comms.channels.length >= this.config.maxChannelsPerServer) {
            reply(this.err("channel_limit", "channel_limit", { max: this.config.maxChannelsPerServer }));
            return;
          }
          reply({ ok: true, channelId: this.conn.createCommsChannel(comms.id, cv.name) });
          return;
        }
        if (!srv) return;
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
        const me = needLogin();
        if (!me) return;
        const srv = this.servers.getServer(req.serverId);
        if (!srv) {
          const s1 = typeof req.serverId === "string" ? this.conn.space1ChannelsFor(req.serverId) : null;
          if (s1) {
            reply({ ok: true, channels: s1 });
            return;
          }
          const connChannels = this.accounts.get(me)?.area === "connection" && typeof req.serverId === "string" ? this.conn.channelsFor(req.serverId) : null;
          if (connChannels) {
            reply({ ok: true, channels: connChannels });
            return;
          }
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
        const sender = this.accounts.get(uuid)!;
        // 통신 채널(v3.0)은 연결 계정만.
        if (ch.area === "connection" && sender.area !== "connection") {
          reply(this.err("channel_forbidden", "channel_forbidden"));
          return;
        }
        if (ch.id.startsWith("r:")) {
          // 원격 채널: 통신 서버로 보내고, 저장·전달은 서버의 메아리 이벤트가 맡는다.
          void this.conn.sendRemote(ch.id, sender, req.text).then((r) => {
            if (r.ok) reply({ ok: true, seq: r.seq });
            else if (r.code === "connection_lost") reply(this.err("connection_lost", "connection_lost"));
            else if (r.code === "text_too_long") reply(this.err("text_too_long", "text_too_long", { max: MAX_TEXT_LENGTH }));
            else reply(this.err(r.code, "remote_send_failed", { code: r.code }));
          });
          return;
        }
        const name = sender.name;
        // 본문 감독(v2.1.2): 길이는 원래 기준으로 위에서 검사했다. 줄바꿈·탭은 유지, 숨은 문자는 이스케이프·기록.
        const text = this.security.guard(req.text, { source: "request", where: "send", field: "text", account: uuid, keepLineBreaks: true });
        // 이스케이프 뒤 상한(v2.1.3): 거부해도 위의 탐지 기록은 남긴다(시도 자체가 감독 대상).
        if (text.length > MAX_STORED_TEXT_LENGTH) {
          reply(this.err("text_hidden_too_long", "text_hidden_too_long", { max: MAX_STORED_TEXT_LENGTH }));
          return;
        }
        const msg = this.channels.append(ch.id, uuid, name, text);
        reply({ ok: true, seq: msg.seq });
        this.fanout(ch, msg.from, name, text, msg.ts);
        if (ch.area === "connection") this.conn.onLocalMessage(ch, msg);
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
        if (ch.area === "connection" && this.accounts.get(uuid)?.area !== "connection") {
          reply(this.err("channel_forbidden", "channel_forbidden"));
          return;
        }
        const limit = typeof req.limit === "number" && req.limit > 0 ? Math.min(req.limit, MAX_READ_LIMIT) : 50;
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
          // 손상 원본을 백업하지 못해 이번 실행 동안 저장을 멈춘 색인(데이터 폴더 기준, v3 Minor ①).
          saveBlocked: ([[this.dm, "dm"], [this.servers, "servers"]] as const).filter(([s]) => s.saveBlocked).map(([, sub]) => `${sub}/index.json`),
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

      default:
        if (req.op.startsWith("admin_conn_")) {
          if (!adminAuth()) return;
          void this.connAdmin(req as unknown as { op: string } & Record<string, unknown>).then((r) => reply(r));
          return;
        }
        break;
    }

    switch (req.op) {

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
        if (this.accounts.get(uuid)?.area === "connection") this.conn.accountsChanged();
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
            return { uuid: u, exists: !!a, name: a?.name ?? "", description: a?.description ?? "", online: this.isOnline(u), ...(a?.area ? { area: a.area } : {}) };
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
  protected fanout(ch: Channel, from: string, fromName: string, text: string, ts: number, origin?: MessageOrigin, skipUuid?: string): void {
    const recipients = ch.members ?? this.accounts.allUuids();
    for (const uuid of recipients) {
      if (uuid === from || uuid === skipUuid) continue;
      // 통신 채널(v3.0)은 연결 계정에게만 전달한다.
      if (ch.area === "connection" && this.accounts.get(uuid)?.area !== "connection") continue;
      this.inbox.append(uuid, {
        ts,
        channelId: ch.id,
        channelKind: ch.kind,
        channelLabel: ch.label,
        from,
        fromName,
        text,
        ...(origin ? { origin } : {}),
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
