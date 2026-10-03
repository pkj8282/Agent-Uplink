import net from "node:net";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encodeFrame, FrameDecoder } from "../shared/framing.js";
import { MAGIC, PROTOCOL_VERSION, DEFAULT_TCP_PORT, Response } from "../shared/protocol.js";

export interface HubClientOptions {
  port?: number;
  accountUuid: string;
  accountName?: string;
  hubEntry?: string;
  nodeArgs?: string[];
}

interface Pending {
  resolve: (r: Response) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class HubClient {
  private readonly port: number;
  private readonly uuid: string;
  private readonly name?: string;
  private readonly hubEntry: string;
  private readonly nodeArgs: string[];
  private sock: net.Socket | null = null;
  private dec = new FrameDecoder();
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private connecting: Promise<void> | null = null;

  constructor(opts: HubClientOptions) {
    this.port = opts.port ?? DEFAULT_TCP_PORT;
    this.uuid = opts.accountUuid;
    this.name = opts.accountName;
    this.hubEntry =
      opts.hubEntry ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "hub", "index.js");
    this.nodeArgs = opts.nodeArgs ?? [];
  }

  async whoami(): Promise<Response> { await this.ensureConnected(); return this.request("whoami", {}); }
  async setName(name: string): Promise<Response> { await this.ensureConnected(); return this.request("set_name", { name }); }
  async listAccounts(): Promise<Response> { await this.ensureConnected(); return this.request("list_accounts", {}); }
  async openDm(peer: string): Promise<Response> { await this.ensureConnected(); return this.request("open_dm", { peer }); }
  async listDms(): Promise<Response> { await this.ensureConnected(); return this.request("list_dms", {}); }
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
    if (this.sock && !this.sock.destroyed) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.doConnect().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  private async doConnect(): Promise<void> {
    let sock: net.Socket;
    try { sock = await this.connectOnce(); }
    catch { this.spawnHub(); sock = await this.retryConnect(); }
    this.attach(sock);
    await this.handshake();
    await this.request("login", this.name ? { uuid: this.uuid, name: this.name } : { uuid: this.uuid });
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
    let r: Response;
    try { r = await this.request("hello", {}, 5000); }
    catch (e) { this.close(); throw new Error(`포트 ${this.port}가 응답하지 않습니다(Agent-Uplink Hub가 아닐 수 있음): ${(e as Error).message}`); }
    if (r.magic !== MAGIC || r.version !== PROTOCOL_VERSION) {
      this.close();
      throw new Error(`포트 ${this.port}가 Agent-Uplink Hub(v${PROTOCOL_VERSION})가 아닙니다.`);
    }
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
