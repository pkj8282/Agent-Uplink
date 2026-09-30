import net from "node:net";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encodeFrame, FrameDecoder } from "../shared/framing.js";
import { MAGIC, PROTOCOL_VERSION, DEFAULT_TCP_PORT, Response } from "../shared/protocol.js";

export interface HubClientOptions {
  port?: number;
  hubEntry?: string; // Hub 진입점 경로(기본: 컴파일된 ../hub/index.js)
  nodeArgs?: string[]; // node 앞 인자(기본: []). 개발 중엔 ["--import","tsx"].
}

interface Pending {
  resolve: (r: Response) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class HubClient {
  private readonly port: number;
  private readonly hubEntry: string;
  private readonly nodeArgs: string[];
  private sock: net.Socket | null = null;
  private dec = new FrameDecoder();
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private name: string | null = null;
  private connecting: Promise<void> | null = null;

  constructor(opts: HubClientOptions = {}) {
    this.port = opts.port ?? DEFAULT_TCP_PORT;
    this.hubEntry =
      opts.hubEntry ??
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "hub", "index.js");
    this.nodeArgs = opts.nodeArgs ?? [];
  }

  async register(name?: string): Promise<Response> {
    await this.ensureConnected();
    const r = await this.request("register", name ? { name } : {});
    if (r.ok && r.name) this.name = r.name;
    return r;
  }

  async send(text: string, to?: string): Promise<Response> {
    await this.ensureConnected();
    return this.request("send", { text, to: to ?? null });
  }

  async check(): Promise<Response> {
    await this.ensureConnected();
    return this.request("check", {});
  }

  async wait(timeoutMs = 30000): Promise<Response> {
    await this.ensureConnected();
    const clamped = Math.min(Math.max(timeoutMs, 1000), 120000);
    return this.request("wait", { timeoutMs: clamped }, clamped + 15000);
  }

  async who(): Promise<Response> {
    await this.ensureConnected();
    return this.request("who", {});
  }

  close(): void {
    if (this.sock) {
      this.sock.destroy();
      this.sock = null;
    }
  }

  /** 테스트 전용: 연결을 강제로 끊어 재연결 경로를 검증한다. */
  dropConnectionForTest(): void {
    if (this.sock) {
      this.sock.destroy();
      this.sock = null;
    }
  }

  private async ensureConnected(): Promise<void> {
    if (this.sock && !this.sock.destroyed) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.doConnect().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async doConnect(): Promise<void> {
    let sock: net.Socket;
    try {
      sock = await this.connectOnce();
    } catch {
      this.spawnHub();
      sock = await this.retryConnect();
    }
    this.attach(sock);
    await this.handshake();
    if (this.name) {
      // 재연결 시 동일 이름으로 재등록
      const r = await this.request("register", { name: this.name });
      if (r.ok && r.name) this.name = r.name;
    }
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
      try {
        return await this.connectOnce();
      } catch {
        // 아직 기동 중 — 재시도
      }
    }
    throw new Error("Hub를 시작했지만 연결에 실패했습니다(포트 점유 또는 기동 실패).");
  }

  private spawnHub(): void {
    const child = spawn(process.execPath, [...this.nodeArgs, this.hubEntry], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
  }

  private attach(sock: net.Socket): void {
    this.sock = sock;
    this.dec = new FrameDecoder();
    sock.on("data", (chunk) => {
      this.dec.push(chunk, (r: Response) => {
        const p = this.pending.get(r.id);
        if (p) {
          clearTimeout(p.timer);
          this.pending.delete(r.id);
          p.resolve(r);
        }
      });
    });
    const fail = () => {
      this.sock = null;
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error("Hub 연결이 끊겼습니다."));
      }
      this.pending.clear();
    };
    sock.on("close", fail);
    sock.on("error", () => {
      /* close가 뒤따른다 */
    });
  }

  private async handshake(): Promise<void> {
    const r = await this.request("hello", {}, 5000);
    if (r.magic !== MAGIC || r.version !== PROTOCOL_VERSION) {
      this.close();
      throw new Error(`포트 ${this.port}가 Agent-Uplink Hub가 아닙니다(다른 프로세스 점유 가능).`);
    }
  }

  private request(op: string, params: object, timeoutMs = 60000): Promise<Response> {
    return new Promise((resolve, reject) => {
      const sock = this.sock;
      if (!sock || sock.destroyed) {
        reject(new Error("Hub 연결이 없습니다."));
        return;
      }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Hub 응답 타임아웃(op=${op}).`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      sock.write(encodeFrame({ op, id, ...params }));
    });
  }
}
