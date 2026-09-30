import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { encodeFrame, FrameDecoder } from "../shared/framing.js";
import { Hub } from "./server.js";
import { Response } from "../shared/protocol.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "uplink-hub-"));
}

// 한 연결에서 요청을 보내고 id로 응답을 받는 소형 클라이언트
class TestClient {
  private sock: net.Socket;
  private dec = new FrameDecoder();
  private waiters = new Map<number, (r: Response) => void>();
  private id = 0;
  constructor(port: number) {
    this.sock = net.connect(port, "127.0.0.1");
    this.sock.on("data", (d) =>
      this.dec.push(d, (r: Response) => this.waiters.get(r.id)?.(r)),
    );
  }
  ready(): Promise<void> {
    return new Promise((res) => this.sock.once("connect", () => res()));
  }
  req(op: string, params: object = {}): Promise<Response> {
    const id = ++this.id;
    return new Promise((resolve) => {
      this.waiters.set(id, resolve);
      this.sock.write(encodeFrame({ op, id, ...params }));
    });
  }
  close(): void {
    this.sock.destroy();
  }
}

async function startHub() {
  const hub = new Hub({ tcpPort: 0, httpPort: 0, dataDir: tmpDir(), idleShutdownMs: 0 });
  await hub.startTcp();
  return { hub, port: hub.tcpAddress.port };
}

test("hello는 매직과 버전을 돌려준다", async () => {
  const { hub, port } = await startHub();
  const c = new TestClient(port);
  await c.ready();
  const r = await c.req("hello");
  assert.equal(r.ok, true);
  assert.equal(r.magic, "agent-uplink");
  assert.equal(r.version, 1);
  c.close();
  hub.stop();
});

test("register는 지정 이름을, 미지정 시 자동 이름을 준다", async () => {
  const { hub, port } = await startHub();
  const a = new TestClient(port); await a.ready();
  const b = new TestClient(port); await b.ready();
  assert.equal((await a.req("register", { name: "A" })).name, "A");
  assert.match((await b.req("register")).name!, /^uplink-\d+$/);
  a.close(); b.close(); hub.stop();
});

test("send한 브로드캐스트를 다른 세션이 check로 받고, 보낸 자신은 못 받는다", async () => {
  const { hub, port } = await startHub();
  const a = new TestClient(port); await a.ready(); await a.req("register", { name: "A" });
  const b = new TestClient(port); await b.ready(); await b.req("register", { name: "B" });
  await a.req("send", { text: "안녕 전체" });
  const rb = await b.req("check");
  assert.deepEqual(rb.messages!.map((m) => m.text), ["안녕 전체"]);
  const ra = await a.req("check");
  assert.deepEqual(ra.messages, []); // 자기 메시지 제외
  a.close(); b.close(); hub.stop();
});

test("to로 대상 지정 시 그 세션만 받는다", async () => {
  const { hub, port } = await startHub();
  const a = new TestClient(port); await a.ready(); await a.req("register", { name: "A" });
  const b = new TestClient(port); await b.ready(); await b.req("register", { name: "B" });
  const c = new TestClient(port); await c.ready(); await c.req("register", { name: "C" });
  await a.req("send", { text: "B만 봐", to: "B" });
  assert.equal((await b.req("check")).messages!.length, 1);
  assert.equal((await c.req("check")).messages!.length, 0);
  a.close(); b.close(); c.close(); hub.stop();
});

test("빈 text는 거부한다", async () => {
  const { hub, port } = await startHub();
  const a = new TestClient(port); await a.ready(); await a.req("register", { name: "A" });
  const r = await a.req("send", { text: "" });
  assert.equal(r.ok, false);
  a.close(); hub.stop();
});

test("wait는 새 메시지가 오면 즉시 반환한다", async () => {
  const { hub, port } = await startHub();
  const a = new TestClient(port); await a.ready(); await a.req("register", { name: "A" });
  const b = new TestClient(port); await b.ready(); await b.req("register", { name: "B" });
  const waiting = b.req("wait", { timeoutMs: 5000 });
  setTimeout(() => a.req("send", { text: "깨어나" }), 50);
  const r = await waiting;
  assert.deepEqual(r.messages!.map((m) => m.text), ["깨어나"]);
  a.close(); b.close(); hub.stop();
});

test("wait는 타임아웃 시 빈 배열을 준다", async () => {
  const { hub, port } = await startHub();
  const a = new TestClient(port); await a.ready(); await a.req("register", { name: "A" });
  const r = await a.req("wait", { timeoutMs: 1000 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.messages, []);
  a.close(); hub.stop();
});

test("SSE 뷰어가 끊긴 뒤 broadcast가 발생해도 Hub는 죽지 않는다", async () => {
  const hub = new Hub({ tcpPort: 0, httpPort: 0, dataDir: tmpDir(), idleShutdownMs: 0 });
  await hub.startTcp();
  await hub.startHttp();
  const httpPort = hub.httpAddress.port;
  const tcpPort = hub.tcpAddress.port;
  // SSE 연결 후 init 이벤트 수신, 그다음 소켓을 비정상 종료(뷰어 탭 강제 종료 흉내).
  const sse = await new Promise<http.IncomingMessage>((resolve) => {
    http.get({ host: "127.0.0.1", port: httpPort, path: "/events" }, (res) => {
      res.once("data", () => resolve(res));
    });
  });
  sse.socket!.destroy();
  // 끊김 처리와 경쟁하도록 곧바로 여러 번 broadcast를 유발한다.
  const a = new TestClient(tcpPort); await a.ready(); await a.req("register", { name: "A" });
  for (let i = 0; i < 20; i++) await a.req("send", { text: "m" + i });
  // Hub가 살아있으면 새 연결의 hello에 여전히 응답한다.
  const b = new TestClient(tcpPort); await b.ready();
  assert.equal((await b.req("hello")).ok, true);
  a.close(); b.close(); hub.stop();
});

test("같은 clientId로 다른 소켓이 register하면 A-2가 아니라 같은 세션(A)으로 이어진다", async () => {
  const { hub, port } = await startHub();
  const a1 = new TestClient(port); await a1.ready();
  // 첫 등록: clientId 지정
  assert.equal((await a1.req("register", { name: "A", clientId: "cid-1" })).name, "A");
  // 재연결을 흉내: 같은 clientId로 새 소켓이 등록 → 새 세션 A-2를 만들지 말고 기존 세션에 이어져 A 유지
  const a2 = new TestClient(port); await a2.ready();
  assert.equal((await a2.req("register", { name: "A", clientId: "cid-1" })).name, "A");
  // who에 유령 없이 A 하나만 있어야 한다(A와 A-2가 동시에 있으면 안 됨).
  const names = (await a2.req("who")).sessions!.map((s) => s.name).sort();
  assert.deepEqual(names, ["A"]);
  a1.close(); a2.close(); hub.stop();
});

test("잘못된 프레임(null/비객체)을 받아도 Hub는 죽지 않고 계속 응답한다", async () => {
  const { hub, port } = await startHub();
  // 원시 소켓으로 프레임화된 null과 숫자를 보낸 뒤, 같은 소켓에서 정상 hello가 응답되는지 확인.
  const raw = net.connect(port, "127.0.0.1");
  await new Promise<void>((res) => raw.once("connect", () => res()));
  raw.write(encodeFrame(null));
  raw.write(encodeFrame(42));
  const dec = new FrameDecoder();
  const helloReply = new Promise<Response>((resolve) => {
    raw.on("data", (d) => dec.push(d, (r: Response) => resolve(r)));
  });
  raw.write(encodeFrame({ op: "hello", id: 7 }));
  const r = await helloReply;
  assert.equal(r.ok, true);
  assert.equal(r.magic, "agent-uplink");
  raw.destroy();
  hub.stop();
});

test("who는 접속 세션 목록을 준다", async () => {
  const { hub, port } = await startHub();
  const a = new TestClient(port); await a.ready(); await a.req("register", { name: "A" });
  const b = new TestClient(port); await b.ready(); await b.req("register", { name: "B" });
  const names = (await a.req("who")).sessions!.map((s) => s.name).sort();
  assert.deepEqual(names, ["A", "B"]);
  a.close(); b.close(); hub.stop();
});
