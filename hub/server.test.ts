import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
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

test("who는 접속 세션 목록을 준다", async () => {
  const { hub, port } = await startHub();
  const a = new TestClient(port); await a.ready(); await a.req("register", { name: "A" });
  const b = new TestClient(port); await b.ready(); await b.req("register", { name: "B" });
  const names = (await a.req("who")).sessions!.map((s) => s.name).sort();
  assert.deepEqual(names, ["A", "B"]);
  a.close(); b.close(); hub.stop();
});
