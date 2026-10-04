import net from "node:net";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encodeFrame, FrameDecoder } from "../shared/framing.js";
import { MAGIC, PROTOCOL_VERSION, DEFAULT_TCP_PORT, Response } from "../shared/protocol.js";
import { newNonce, isNonce, clientProof, hubProof, proofEquals } from "../shared/auth.js";
import { readClientKey, resolveDataDir } from "../shared/clientKey.js";

export interface HubClientOptions {
  port?: number;
  /** 없으면 로그인하지 않는다(역할 선택 전). */
  accountUuid?: string;
  accountName?: string;
  /** true면 독점 로그인(역할 계정). UPLINK_ACCOUNT 단일 경로는 false. */
  exclusive?: boolean;
  hubEntry?: string;
  nodeArgs?: string[];
  /** client.key가 있는 데이터 폴더. 기본: Hub와 같은 env 규칙. */
  dataDir?: string;
}

interface Pending {
  resolve: (r: Response) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const OLD_PROTOCOL_HUB_MESSAGE =
  "실행 중인 Hub가 구버전(프로토콜 v2)입니다. 실행 중인 Hub를 종료(재시작)하거나 재배포한 뒤 다시 시도하세요.";

export function notOurHubMessage(port: number): string {
  return `포트 ${port}의 Hub가 이 Windows 사용자의 Hub가 아닙니다(인증 실패). 같은 PC의 다른 사용자가 포트를 점유했거나, 이 MCP와 Hub의 UPLINK_DATA_DIR가 다를 수 있습니다 — MCP 설정 env의 UPLINK_TCP_PORT·UPLINK_DATA_DIR를 확인하세요.`;
}

export class HubClient {
  private readonly port: number;
  /** MCP 프로세스 1개 = 세션 1개. 같은 프로세스의 재연결은 독점 검사를 통과한다. */
  readonly sessionToken = randomUUID();
  private account: { uuid: string; name?: string; exclusive: boolean } | null;
  private readonly hubEntry: string;
  private readonly nodeArgs: string[];
  private readonly dataDir: string;
  private sock: net.Socket | null = null;
  private dec = new FrameDecoder();
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private connecting: Promise<void> | null = null;

  constructor(opts: HubClientOptions) {
    this.port = opts.port ?? DEFAULT_TCP_PORT;
    this.account = opts.accountUuid
      ? { uuid: opts.accountUuid, name: opts.accountName, exclusive: opts.exclusive ?? false }
      : null;
    this.hubEntry =
      opts.hubEntry ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "hub", "index.js");
    this.nodeArgs = opts.nodeArgs ?? [];
    this.dataDir = opts.dataDir ?? resolveDataDir(process.env);
  }

  /** 재연결 때 독점 재로그인이 거부되면(다른 세션이 계정을 가져감) 호출된다. */
  onAccountLost: ((reason: string) => void) | null = null;

  /** 계정을 독점 선택해 로그인한다. 거부되면 기존 계정 상태를 그대로 둔다. */
  async selectAccount(uuid: string, name?: string): Promise<Response> {
    await this.ensureLink();
    const next = { uuid, name, exclusive: true };
    const r = await this.request("login", this.loginParams(next));
    if (r.ok) this.account = next;
    return r;
  }
  async accountStatus(uuids: string[]): Promise<Response> { await this.ensureLink(); return this.request("account_status", { uuids }); }
  async setProfile(description: string): Promise<Response> { await this.ensureConnected(); return this.request("set_profile", { description }); }
  async whoami(): Promise<Response> { await this.ensureConnected(); return this.request("whoami", {}); }
  async setName(name: string): Promise<Response> { await this.ensureConnected(); return this.request("set_name", { name }); }
  async listAccounts(): Promise<Response> { await this.ensureLink(); return this.request("list_accounts", {}); }
  async viewerTicket(): Promise<Response> { await this.ensureLink(); return this.request("viewer_ticket", {}); }

  /**
   * 로그인 없이 쓸 수 있는 op용 연결 보장. 이전 계정의 독점 재로그인만 거부된 경우(역할을 빼앗김)
   * 연결은 살아 있으므로 계속 진행한다 — 역할 목록 조회·다른 역할 선택이 막히지 않도록.
   */
  private async ensureLink(): Promise<void> {
    try {
      await this.ensureConnected();
    } catch (e) {
      if (!this.sock || this.sock.destroyed) throw e;
    }
  }
  async openDm(peer: string): Promise<Response> { await this.ensureConnected(); return this.request("open_dm", { peer }); }
  async listDms(): Promise<Response> { await this.ensureConnected(); return this.request("list_dms", {}); }
  async createServer(name: string): Promise<Response> { await this.ensureConnected(); return this.request("create_server", { name }); }
  async listServers(): Promise<Response> { await this.ensureConnected(); return this.request("list_servers", {}); }
  async createChannel(serverId: string, name: string): Promise<Response> { await this.ensureConnected(); return this.request("create_channel", { serverId, name }); }
  async listChannels(serverId: string): Promise<Response> { await this.ensureConnected(); return this.request("list_channels", { serverId }); }
  async deleteChannel(channelId: string): Promise<Response> { await this.ensureConnected(); return this.request("delete_channel", { channelId }); }
  async deleteServer(serverId: string): Promise<Response> { await this.ensureConnected(); return this.request("delete_server", { serverId }); }
  async send(channelId: string, text: string): Promise<Response> { await this.ensureConnected(); return this.request("send", { channelId, text }); }
  async read(channelId: string, limit?: number): Promise<Response> { await this.ensureConnected(); return this.request("read", { channelId, limit }); }
  async check(): Promise<Response> { await this.ensureConnected(); return this.request("check", {}); }
  async wait(timeoutMs = 30000): Promise<Response> {
    await this.ensureConnected();
    const clamped = Math.min(Math.max(timeoutMs, 1000), 120000);
    return this.request("wait", { timeoutMs: clamped }, clamped + 15000);
  }

  close(): void { if (this.sock) { this.sock.destroy(); this.sock = null; } }
  dropConnectionForTest(): void { this.close(); }

  private async ensureConnected(): Promise<void> {
    // 연결 중(핸드셰이크·재로그인 진행 중)이면 소켓이 이미 붙었어도 기다린다 — Hub 증명을 확인하기 전에
    // 다른 도구 호출의 op가 나가지 않게(가짜 Hub에 메시지가 넘어가거나 진짜 Hub에서 auth_required가 나지 않게).
    if (this.connecting) return this.connecting;
    if (this.sock && !this.sock.destroyed) return;
    this.connecting = this.doConnect().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  private async doConnect(): Promise<void> {
    let sock: net.Socket;
    try { sock = await this.connectOnce(); }
    catch { this.spawnHub(); sock = await this.retryConnect(); }
    this.attach(sock);
    await this.handshake();
    if (this.account) {
      const r = await this.request("login", this.loginParams(this.account));
      if (!r.ok) {
        if (this.account.exclusive) {
          // Hub 재시작 사이 다른 세션이 이 역할을 가져갔다: 연결은 유지하고 계정 선택만 해제해
          // use_account로 다른 역할을 고를 수 있게 한다(계속 같은 재로그인에 막히지 않도록).
          this.account = null;
          this.onAccountLost?.(r.error ?? "재로그인 거부");
          throw new Error(`계정 선택이 해제되었습니다(${r.error}). use_account로 다시 선택하세요.`);
        }
        this.close();
        throw new Error(`Hub 재로그인 실패: ${r.error}`);
      }
    }
  }

  private loginParams(a: { uuid: string; name?: string; exclusive: boolean }): object {
    return {
      uuid: a.uuid,
      ...(a.name ? { name: a.name } : {}),
      ...(a.exclusive ? { exclusive: true, sessionToken: this.sessionToken } : {}),
    };
  }

  private connectOnce(): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const s = net.connect(this.port, "127.0.0.1");
      s.once("connect", () => resolve(s));
      s.once("error", reject);
    });
  }

  private async retryConnect(): Promise<net.Socket> {
    for (let i = 0; i < 30; i++) {
      await delay(100);
      try { return await this.connectOnce(); } catch { /* 재시도 */ }
    }
    throw new Error("Hub를 시작했지만 연결에 실패했습니다(포트 점유 또는 기동 실패).");
  }

  private spawnHub(): void {
    const child = spawn(process.execPath, [...this.nodeArgs, this.hubEntry], {
      detached: true, stdio: "ignore", windowsHide: true,
    });
    child.unref();
  }

  private attach(sock: net.Socket): void {
    this.sock = sock;
    this.dec = new FrameDecoder();
    sock.on("data", (chunk) => this.dec.push(chunk, (r: Response) => {
      const p = this.pending.get(r.id);
      if (p) { clearTimeout(p.timer); this.pending.delete(r.id); p.resolve(r); }
    }));
    const fail = () => {
      this.sock = null;
      for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error("Hub 연결이 끊겼습니다.")); }
      this.pending.clear();
    };
    sock.on("close", fail);
    sock.on("error", () => { /* close 뒤따름 */ });
  }

  private async handshake(): Promise<void> {
    let h: Response;
    try { h = await this.request("hello", {}, 15000); } // 보안 준비(권한·소유자 검사) 동안 기다린다
    catch (e) { this.close(); throw new Error(`포트 ${this.port}가 응답하지 않습니다(Agent-Uplink Hub가 아닐 수 있음): ${(e as Error).message}`); }
    if (!h.ok && h.code === "secure_setup_failed") { this.close(); throw new Error(`Hub를 시작할 수 없습니다: ${h.error}`); }
    if (h.magic !== MAGIC) { this.close(); throw new Error(`포트 ${this.port}가 Agent-Uplink Hub가 아닙니다.`); }
    if (h.version !== PROTOCOL_VERSION) {
      this.close();
      throw new Error(h.version === 2 ? OLD_PROTOCOL_HUB_MESSAGE : `포트 ${this.port}의 Hub 프로토콜(v${h.version})이 이 MCP(v${PROTOCOL_VERSION})와 다릅니다. 같은 버전으로 재배포하세요.`);
    }
    let key: string;
    try { key = readClientKey(this.dataDir); } catch (e) { this.close(); throw e; }
    const hubNonce = h.nonce;
    if (!isNonce(hubNonce)) { this.close(); throw new Error(notOurHubMessage(this.port)); }
    const nonce = newNonce();
    let r: Response;
    try { r = await this.request("auth", { nonce, proof: clientProof(key, hubNonce, nonce) }, 15000); }
    catch { this.close(); throw new Error(notOurHubMessage(this.port)); }
    // Hub 증명을 확인하기 전에는 login 등 아무것도 보내지 않는다(가짜 Hub에 계정·메시지를 넘기지 않음).
    if (!r.ok || !proofEquals(hubProof(key, hubNonce, nonce), r.proof)) { this.close(); throw new Error(notOurHubMessage(this.port)); }
  }

  private request(op: string, params: object, timeoutMs = 60000): Promise<Response> {
    return new Promise((resolve, reject) => {
      const sock = this.sock;
      if (!sock || sock.destroyed) { reject(new Error("Hub 연결이 없습니다.")); return; }
      const id = this.nextId++;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Hub 응답 타임아웃(op=${op}).`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      sock.write(encodeFrame({ op, id, ...params }));
    });
  }
}
