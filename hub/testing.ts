// 테스트 전용 도우미(dist 제외 — tsconfig exclude): 보안 준비를 마친 Hub, v3 핸드셰이크를 하는 원시 클라이언트.
import net from "node:net";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { encodeFrame, FrameDecoder } from "../shared/framing.js";
import { newNonce, clientProof, hubProof, proofEquals } from "../shared/auth.js";
import { readClientKey } from "../shared/clientKey.js";
import { Response } from "../shared/protocol.js";
import { Hub, HubLimits } from "./server.js";
import { SecureDeps } from "./secure.js";

/** win32 경로(PowerShell·icacls)를 건너뛴다 — 실제 경로는 secure.test.ts가 주입·통합 테스트로 검증한다. */
export const TEST_SECURE_DEPS: SecureDeps = {
  platform: "linux",
  currentUserSid: async () => "S-1-5-21-test",
  findForeign: async () => ({ count: 0, samples: [] }),
  restrictAcl: async () => ({ ok: true }),
};

const dataDirByPort = new Map<number, string>();

export function registerTestHub(port: number, dataDir: string): void {
  dataDirByPort.set(port, dataDir);
}

export async function startTestHub(opts: { dataDir?: string; http?: boolean; limits?: Partial<HubLimits> } = {}): Promise<{ hub: Hub; port: number; dataDir: string }> {
  const dataDir = opts.dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "uplink-t-"));
  const hub = new Hub({ tcpPort: 0, httpPort: 0, dataDir, idleShutdownMs: 0, ...(opts.limits ? { limits: opts.limits } : {}) });
  await hub.startTcp();
  if (opts.http) await hub.startHttp();
  await hub.secure(TEST_SECURE_DEPS);
  registerTestHub(hub.tcpAddress.port, dataDir);
  return { hub, port: hub.tcpAddress.port, dataDir };
}

/** 정상 사용자의 v3 핸드셰이크(hello → auth → Hub 증명 확인). */
export async function authenticate(req: (op: string, p?: object) => Promise<any>, dataDir: string): Promise<void> {
  const h = await req("hello");
  if (!h.ok) throw new Error(`hello 실패: ${h.error}`);
  const key = readClientKey(dataDir);
  const nonce = newNonce();
  const r = await req("auth", { nonce, proof: clientProof(key, h.nonce, nonce) });
  if (!r.ok) throw new Error(`auth 실패: ${r.error}`);
  if (!proofEquals(hubProof(key, h.nonce, nonce), r.proof)) throw new Error("Hub 증명 불일치");
}

export class TestClient {
  private sock: net.Socket;
  private dec = new FrameDecoder();
  private waiters = new Map<number, (r: Response) => void>();
  private id = 0;
  private readonly dataDir: string | undefined;
  constructor(port: number, dataDir?: string) {
    this.dataDir = dataDir ?? dataDirByPort.get(port);
    this.sock = net.connect(port, "127.0.0.1");
    this.sock.on("data", (d) => this.dec.push(d, (r: Response) => this.waiters.get(r.id)?.(r)));
    this.sock.on("error", () => { /* close 뒤따름 */ });
  }
  /** 연결만(인증 안 함) — 무인증 공격 재현용. */
  connected(): Promise<void> {
    return new Promise((res) => { if (this.sock.readyState === "open") res(); else this.sock.once("connect", () => res()); });
  }
  /** 연결 + 인증(기존 테스트의 ready()와 같은 자리에 쓴다). */
  async ready(): Promise<void> {
    await this.connected();
    if (!this.dataDir) throw new Error("TestClient: 이 포트의 dataDir를 모릅니다(registerTestHub 또는 생성자 인자).");
    await authenticate((op, p) => this.req(op, p), this.dataDir);
  }
  req(op: string, params: object = {}): Promise<Response> {
    const id = ++this.id;
    return new Promise((resolve) => { this.waiters.set(id, resolve); this.sock.write(encodeFrame({ op, id, ...params })); });
  }
  onClose(): Promise<void> { return new Promise((res) => this.sock.once("close", () => res())); }
  close(): void { this.sock.destroy(); }
}

export function httpGet(port: number, urlPath: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: urlPath, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let body = "";
      const done = () => resolve({ status: res.statusCode!, headers: res.headers, body });
      res.on("data", (d) => { body += d; if (urlPath === "/events") { res.destroy(); done(); } });
      res.on("end", done);
    });
    req.on("error", reject);
    req.end();
  });
}

/** 인증된 TCP로 티켓을 받아 세션 쿠키 헤더 값("uplink_viewer=...")을 돌려준다. */
export async function openViewerSession(tcpPort: number): Promise<string> {
  const c = new TestClient(tcpPort); await c.ready();
  const t = await c.req("viewer_ticket");
  c.close();
  if (!t.ok) throw new Error(`viewer_ticket 실패: ${t.error}`);
  const url = new URL(t.url!);
  const r = await httpGet(Number(url.port), url.pathname + url.search);
  const m = String(r.headers["set-cookie"]).match(/uplink_viewer=[0-9a-f]{64}/);
  if (!m) throw new Error("세션 쿠키 없음");
  return m[0];
}
