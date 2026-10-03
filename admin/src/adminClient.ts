import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { encodeFrame, FrameDecoder } from "./framing.js";
import type { AdminConfig, ConfigPatch, IpcResult, Snapshot } from "./types.js";

const HUB_MAGIC = "agent-uplink";
const HUB_PROTOCOL_VERSION = 2;
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
}

/** Hub(hub/options.ts)와 같은 env 규칙으로 접속 포트와 admin.key 경로를 정한다. */
export function resolveAdminTarget(env: NodeJS.ProcessEnv): AdminTarget {
  const base = env.UPLINK_DATA_DIR ?? path.join(env.PROGRAMDATA ?? ".", "AgentUplink");
  return { port: Number(env.UPLINK_TCP_PORT ?? 47800), keyPath: path.join(base, "admin.key") };
}

export interface AdminClientOptions extends AdminTarget {
  /** 응답 1건 대기 한도(ms). 기본 5000. */
  timeoutMs?: number;
  /** 접속 대상 호스트. 기본 127.0.0.1(Hub는 로컬 전용). */
  host?: string;
  /** 연결 수립 대기 한도(ms). 기본 10000 — Windows 루프백 거부(~2초)보다 길게. */
  connectTimeoutMs?: number;
}

type Reply = { ok: boolean; id: number; error?: string; [k: string]: any };

/** 연결이 응답 전에 끊김(어느 단계인지는 호출자가 메시지로 구분한다). */
class DisconnectedError extends Error {}

/** 성공은 {ok,data}, 실패는 {ok:false,error,hubDown}으로 감싼다(IPC로 Error 객체를 넘기지 않기 위해). */
export async function toResult<T>(fn: () => Promise<T>): Promise<IpcResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (e) {
    return { ok: false, error: (e as Error).message, hubDown: e instanceof HubNotRunningError };
  }
}

/** Hub admin op 클라이언트. 호출마다 새 연결(접속→hello 검증→op 1회→종료)이라 Hub 재시작에도 상태가 남지 않는다. */
export class AdminClient {
  private readonly port: number;
  private readonly keyPath: string;
  private readonly timeoutMs: number;
  private readonly host: string;
  private readonly connectTimeoutMs: number;

  constructor(opts: AdminClientOptions) {
    this.port = opts.port;
    this.keyPath = opts.keyPath;
    this.timeoutMs = opts.timeoutMs ?? 5000;
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
    };
  }

  async setConfig(patch: ConfigPatch): Promise<AdminConfig> {
    return (await this.call("admin_set_config", { patch })).config;
  }

  async deleteChannel(channelId: string): Promise<void> { await this.call("admin_delete_channel", { channelId }); }
  async deleteServer(serverId: string): Promise<void> { await this.call("admin_delete_server", { serverId }); }
  async deleteAccount(uuid: string): Promise<void> { await this.call("admin_delete_account", { uuid }); }

  private async call(op: string, params: object): Promise<Reply> {
    const conn = await this.connect();
    try {
      const hello = await conn.request("hello", {}).catch((e: unknown) => {
        throw e instanceof DisconnectedError
          ? new Error(`포트 ${this.port}의 프로그램이 Hub 응답 없이 연결을 끊었습니다(Agent-Uplink Hub가 아닐 수 있음).`)
          : e;
      });
      if (hello.magic !== HUB_MAGIC) throw new Error(`포트 ${this.port}의 프로그램은 Agent-Uplink Hub가 아닙니다.`);
      if (hello.version !== HUB_PROTOCOL_VERSION) {
        throw new Error(`포트 ${this.port}의 Agent-Uplink Hub 버전(v${hello.version})이 관리 도구(v${HUB_PROTOCOL_VERSION})와 맞지 않습니다.`);
      }
      const r = await conn.request(op, { token: this.readToken(), ...params }).catch((e: unknown) => {
        throw e instanceof DisconnectedError
          ? new Error("요청 도중 Hub 연결이 끊겼습니다. 작업이 적용됐는지 새로고침으로 확인하세요.")
          : e;
      });
      if (!r.ok) {
        if (r.error === "알 수 없는 op") throw new Error("이 Hub에는 관리 기능이 없습니다(구버전). Hub를 재배포한 뒤 다시 시도하세요.");
        throw new Error(r.error ?? `${op} 실패`);
      }
      return r;
    } finally {
      conn.close();
    }
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

  request(op: string, params: object): Promise<Reply> {
    return new Promise((resolve, reject) => {
      if (this.sock.destroyed) { reject(new DisconnectedError("Hub 연결이 끊겼습니다.")); return; }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Hub가 응답하지 않습니다(op=${op}, ${this.timeoutMs}ms). 포트를 다른 프로그램이 쓰고 있을 수 있습니다.`));
      }, this.timeoutMs);
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
