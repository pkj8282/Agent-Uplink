import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { encodeFrame, FrameDecoder } from "./framing.js";
import { newNonce, isNonce, clientProof, hubProof, proofEquals, readClientKeyFile } from "./auth.js";
import type { AdminConfig, ConfigPatch, IpcResult, NameConflict, RestoreReport, Snapshot } from "./types.js";

const HUB_MAGIC = "agent-uplink";
const HUB_PROTOCOL_VERSION = 3;
export const HUB_DOWN_MESSAGE = "Hub가 실행 중이 아닙니다. 세션을 열거나 Hub를 시작하세요.";

export class HubNotRunningError extends Error {
  constructor() {
    super(HUB_DOWN_MESSAGE);
    this.name = "HubNotRunningError";
  }
}

export interface AdminTarget {
  port: number;
  keyPath: string;
  /** client.key 경로(v3 핸드셰이크). 생략하면 admin.key와 같은 폴더의 client.key. */
  clientKeyPath?: string;
}

/** Hub(hub/options.ts)와 같은 env 규칙으로 접속 포트와 admin.key 경로를 정한다. */
export function resolveAdminTarget(env: NodeJS.ProcessEnv): AdminTarget {
  const base = env.UPLINK_DATA_DIR ?? path.join(env.PROGRAMDATA ?? ".", "AgentUplink");
  return { port: Number(env.UPLINK_TCP_PORT ?? 47800), keyPath: path.join(base, "admin.key"), clientKeyPath: path.join(base, "client.key") };
}

export interface AdminClientOptions extends AdminTarget {
  /** 응답 1건 대기 한도(ms). 기본 5000. */
  timeoutMs?: number;
  /** hello 응답 대기 한도(ms). 기본 15000 — Hub는 보안 준비(권한 잠금·소유자 검사)가 끝난 뒤에야 hello에 답한다. */
  helloTimeoutMs?: number;
  /** 접속 대상 호스트. 기본 127.0.0.1(Hub는 로컬 전용). */
  host?: string;
  /** 연결 수립 대기 한도(ms). 기본 10000 — Windows 루프백 거부(~2초)보다 길게. */
  connectTimeoutMs?: number;
}

type Reply = { ok: boolean; id: number; error?: string; [k: string]: any };

/** 연결이 응답 전에 끊김(어느 단계인지는 호출자가 메시지로 구분한다). */
class DisconnectedError extends Error {}

/** 응답 대기 시간 초과(op 단계면 Hub에서 이미 처리됐을 수 있다). */
class TimeoutError extends Error {}

/** Hub가 op를 거부했다(code가 있으면 관리 앱이 문구로 바꾼다). */
export class HubOpError extends Error {
  constructor(message: string, readonly code?: string, readonly conflicts?: NameConflict[]) {
    super(message);
    this.name = "HubOpError";
  }
}

/** 성공은 {ok,data}, 실패는 {ok:false,error,hubDown,code?}로 감싼다(IPC로 Error 객체를 넘기지 않기 위해). */
export async function toResult<T>(fn: () => Promise<T>): Promise<IpcResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (e) {
    const base = { ok: false as const, error: (e as Error).message, hubDown: e instanceof HubNotRunningError };
    if (e instanceof HubOpError) {
      return { ...base, ...(e.code ? { code: e.code } : {}), ...(e.conflicts ? { conflicts: e.conflicts } : {}) };
    }
    return base;
  }
}

/** Hub admin op 클라이언트. 호출마다 새 연결(접속→hello 검증→op 1회→종료)이라 Hub 재시작에도 상태가 남지 않는다. */
export class AdminClient {
  private readonly port: number;
  private readonly keyPath: string;
  private readonly clientKeyPath: string;
  private readonly timeoutMs: number;
  private readonly helloTimeoutMs: number;
  private readonly host: string;
  private readonly connectTimeoutMs: number;

  constructor(opts: AdminClientOptions) {
    this.port = opts.port;
    this.keyPath = opts.keyPath;
    this.clientKeyPath = opts.clientKeyPath ?? path.join(path.dirname(opts.keyPath), "client.key");
    this.timeoutMs = opts.timeoutMs ?? 5000;
    this.helloTimeoutMs = opts.helloTimeoutMs ?? 15000;
    this.host = opts.host ?? "127.0.0.1";
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 10000;
  }

  async snapshot(): Promise<Snapshot> {
    const r = await this.call("admin_snapshot", {});
    return {
      config: r.config,
      servers: r.snapshotServers ?? [],
      accounts: r.snapshotAccounts ?? [],
      dms: r.snapshotDms ?? [],
      trash: r.trash, // 없으면 undefined(구버전 Hub) — 빈 목록과 구분한다
    };
  }

  async restoreTrash(id: string, confirmRename: boolean): Promise<RestoreReport> {
    return (await this.call("admin_restore_trash", { trashId: id, confirmRename })).restored;
  }

  async emptyTrash(): Promise<{ removed: number }> {
    return { removed: (await this.call("admin_empty_trash", {})).removed };
  }

  async setConfig(patch: ConfigPatch): Promise<AdminConfig> {
    return (await this.call("admin_set_config", { patch })).config;
  }

  async deleteChannel(channelId: string): Promise<void> { await this.call("admin_delete_channel", { channelId }); }
  async deleteServer(serverId: string): Promise<void> { await this.call("admin_delete_server", { serverId }); }
  async deleteAccount(uuid: string): Promise<void> { await this.call("admin_delete_account", { uuid }); }

  /** 뷰어를 열 1회용 티켓 URL. */
  async viewerTicket(): Promise<string> {
    return (await this.call("viewer_ticket", {})).url;
  }

  private async call(op: string, params: object): Promise<Reply> {
    const conn = await this.connect();
    try {
      const hello = await conn.request("hello", {}, this.helloTimeoutMs).catch((e: unknown) => {
        if (e instanceof DisconnectedError) {
          throw new Error(`포트 ${this.port}의 프로그램이 Hub 응답 없이 연결을 끊었습니다. Hub가 종료 중이거나 Agent-Uplink Hub가 아닐 수 있습니다. 잠시 후 새로고침하세요.`);
        }
        if (e instanceof TimeoutError) throw new Error(`${e.message} 포트를 다른 프로그램이 쓰고 있을 수 있습니다.`);
        throw e;
      });
      if (!hello.ok && hello.code === "secure_setup_failed") throw new Error(`Hub를 시작할 수 없습니다: ${hello.error}`);
      if (hello.magic !== HUB_MAGIC) throw new Error(`포트 ${this.port}의 프로그램은 Agent-Uplink Hub가 아닙니다.`);
      if (hello.version !== HUB_PROTOCOL_VERSION) {
        if (hello.version === 2) throw new Error("실행 중인 Hub가 구버전(v2.0.1 이하)입니다. Hub를 종료(재시작)한 뒤 새로고침하세요.");
        throw new Error(`포트 ${this.port}의 Agent-Uplink Hub 버전(v${hello.version})이 관리 도구(v${HUB_PROTOCOL_VERSION})와 맞지 않습니다.`);
      }
      await this.authenticate(conn, hello.nonce);
      const r = await conn.request(op, { token: this.readToken(), ...params }).catch((e: unknown) => {
        if (e instanceof DisconnectedError) throw new Error("요청 도중 Hub 연결이 끊겼습니다. 작업이 적용됐는지 새로고침으로 확인하세요.");
        if (e instanceof TimeoutError) throw new Error(`${e.message} 작업이 Hub에서 이미 처리됐을 수 있습니다. 새로고침으로 확인하세요.`);
        throw e;
      });
      if (!r.ok) {
        if (r.error === "알 수 없는 op") throw new Error("이 Hub에는 이 관리 기능이 없습니다(구버전). Hub를 재배포한 뒤 다시 시도하세요.");
        throw new HubOpError(r.error ?? `${op} 실패`, r.code, r.conflicts);
      }
      return r;
    } finally {
      conn.close();
    }
  }

  /** v3 핸드셰이크. Hub 증명을 확인하기 전에는 admin 토큰을 보내지 않는다(가짜 Hub에 새지 않게). */
  private async authenticate(conn: Connection, hubNonce: unknown): Promise<void> {
    const notOurs = `포트 ${this.port}의 Hub가 이 Windows 사용자의 Hub가 아닙니다(인증 실패). 다른 사용자가 포트를 점유했거나 UPLINK_DATA_DIR가 Hub와 다를 수 있습니다.`;
    // v3 Hub는 키를 만든 뒤에야 hello에 답한다 → 답했는데 이 폴더에 키가 없으면 이 데이터 폴더의 Hub가 아니다.
    if (!fs.existsSync(this.clientKeyPath)) throw new Error(notOurs);
    const key = readClientKeyFile(this.clientKeyPath);
    if (!isNonce(hubNonce)) throw new Error(notOurs);
    const nonce = newNonce();
    const r = await conn.request("auth", { nonce, proof: clientProof(key, hubNonce, nonce) }).catch(() => {
      throw new Error("인증 중 Hub 연결이 끊기거나 응답이 없습니다(Hub가 종료 중이거나 연결이 너무 많을 수 있습니다). 잠시 후 새로고침하세요.");
    });
    if (!r.ok || !proofEquals(hubProof(key, hubNonce, nonce), r.proof)) throw new Error(notOurs);
  }

  /** 매 호출 다시 읽는다(Hub가 키를 재생성했을 수 있음). */
  private readToken(): string {
    let token: string;
    try {
      token = fs.readFileSync(this.keyPath, "utf8").trim();
    } catch {
      throw new Error(
        `admin.key를 읽을 수 없습니다: ${this.keyPath}. 실행 중인 Hub가 관리 기능이 있는 버전인지, UPLINK_DATA_DIR가 Hub와 같은지 확인하세요.`,
      );
    }
    if (!token) throw new Error(`admin.key가 비어 있습니다: ${this.keyPath}`);
    return token;
  }

  // 보통은 listen 중이면 수락, 아니면 OS가 거부(Windows는 ~2초)하지만, 보안 제품 등이 SYN을 버리면 무한 대기하므로 상한을 둔다.
  private connect(): Promise<Connection> {
    return new Promise((resolve, reject) => {
      const sock = net.connect(this.port, this.host);
      const timer = setTimeout(() => {
        sock.destroy();
        reject(new Error(`포트 ${this.port} 연결 시간이 초과됐습니다(${this.connectTimeoutMs}ms).`));
      }, this.connectTimeoutMs);
      sock.once("connect", () => { clearTimeout(timer); resolve(new Connection(sock, this.timeoutMs)); });
      sock.once("error", (e: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        reject(e.code === "ECONNREFUSED" ? new HubNotRunningError() : new Error(`Hub 연결 실패: ${e.message}`));
      });
    });
  }
}

interface Pending {
  resolve: (r: Reply) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>; // lib DOM + @types/node 동시 사용 → NodeJS.Timeout 고정 금지
}

/** 연결 1개 위의 요청/응답 상관(id) 처리. */
class Connection {
  private dec = new FrameDecoder();
  private nextId = 1;
  private pending = new Map<number, Pending>();

  constructor(private readonly sock: net.Socket, private readonly timeoutMs: number) {
    sock.on("data", (chunk) => this.dec.push(chunk, (r: Reply | null) => {
      if (!r || typeof r !== "object") return; // 객체가 아닌 프레임(null 등)은 무시
      const p = this.pending.get(r.id);
      if (p) { clearTimeout(p.timer); this.pending.delete(r.id); p.resolve(r); }
    }));
    sock.on("close", () => this.failAll(new DisconnectedError("Hub 연결이 끊겼습니다.")));
    sock.on("error", () => { /* close가 뒤따른다 */ });
  }

  request(op: string, params: object, timeoutMs = this.timeoutMs): Promise<Reply> {
    return new Promise((resolve, reject) => {
      if (this.sock.destroyed) { reject(new DisconnectedError("Hub 연결이 끊겼습니다.")); return; }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new TimeoutError(`Hub가 응답하지 않습니다(op=${op}, ${timeoutMs}ms).`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.sock.write(encodeFrame({ op, id, ...params }));
    });
  }

  close(): void { this.sock.destroy(); }

  private failAll(e: Error): void {
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(e); }
    this.pending.clear();
  }
}
