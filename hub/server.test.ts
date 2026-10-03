import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { encodeFrame, FrameDecoder } from "../shared/framing.js";
import { Hub } from "./server.js";
import { Response } from "../shared/protocol.js";

function tmp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), "uplink-hub-")); }

class Client {
  private sock: net.Socket;
  private dec = new FrameDecoder();
  private waiters = new Map<number, (r: Response) => void>();
  private id = 0;
  constructor(port: number) {
    this.sock = net.connect(port, "127.0.0.1");
    this.sock.on("data", (d) => this.dec.push(d, (r: Response) => this.waiters.get(r.id)?.(r)));
  }
  ready(): Promise<void> { return new Promise((res) => this.sock.once("connect", () => res())); }
  req(op: string, params: object = {}): Promise<Response> {
    const id = ++this.id;
    return new Promise((resolve) => { this.waiters.set(id, resolve); this.sock.write(encodeFrame({ op, id, ...params })); });
  }
  close(): void { this.sock.destroy(); }
}

async function startHub(dataDir = tmp()) {
  const hub = new Hub({ tcpPort: 0, httpPort: 0, dataDir, idleShutdownMs: 0 });
  await hub.startTcp();
  return { hub, port: hub.tcpAddress.port, dataDir };
}

test("hello는 매직과 버전2를 준다", async () => {
  const { hub, port } = await startHub();
  const c = new Client(port); await c.ready();
  const r = await c.req("hello");
  assert.equal(r.magic, "agent-uplink");
  assert.equal(r.version, 2);
  c.close(); hub.stop();
});

test("login 없이 send하면 거부(크래시 아님)", async () => {
  const { hub, port } = await startHub();
  const c = new Client(port); await c.ready();
  const r = await c.req("send", { channelId: "lobby", text: "x" });
  assert.equal(r.ok, false);
  assert.match(r.error!, /로그인|login/i);
  c.close(); hub.stop();
});

test("login 후 whoami/set_name이 동작한다", async () => {
  const { hub, port } = await startHub();
  const c = new Client(port); await c.ready();
  await c.req("login", { uuid: "u1", name: "A" });
  assert.equal((await c.req("whoami")).uuid, "u1");
  assert.equal((await c.req("set_name", { name: "에이" })).name, "에이");
  assert.equal((await c.req("whoami")).name, "에이");
  c.close(); hub.stop();
});

test("lobby로 보낸 메시지를 다른 계정이 check로 받고 발신자는 제외된다", async () => {
  const { hub, port } = await startHub();
  const a = new Client(port); await a.ready(); await a.req("login", { uuid: "u1", name: "A" });
  const b = new Client(port); await b.ready(); await b.req("login", { uuid: "u2", name: "B" });
  await a.req("send", { channelId: "lobby", text: "안녕 전체" });
  const rb = await b.req("check");
  assert.deepEqual(rb.items!.map((i) => i.text), ["안녕 전체"]);
  assert.equal(rb.items![0].channelId, "lobby");
  const ra = await a.req("check");
  assert.deepEqual(ra.items, []); // 발신자 제외
  a.close(); b.close(); hub.stop();
});

test("check는 커서를 전진시켜 재수신하지 않는다", async () => {
  const { hub, port } = await startHub();
  const a = new Client(port); await a.ready(); await a.req("login", { uuid: "u1", name: "A" });
  const b = new Client(port); await b.ready(); await b.req("login", { uuid: "u2", name: "B" });
  await a.req("send", { channelId: "lobby", text: "한번" });
  assert.equal((await b.req("check")).items!.length, 1);
  assert.equal((await b.req("check")).items!.length, 0); // 두번째 check엔 없음
  a.close(); b.close(); hub.stop();
});

test("check는 inboxMaxBatch 상한까지만 주고 나머지는 다음에 준다", async () => {
  const dataDir = tmp();
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify({ inboxMaxBatch: 2 }));
  const { hub, port } = await startHub(dataDir);
  const a = new Client(port); await a.ready(); await a.req("login", { uuid: "u1", name: "A" });
  const b = new Client(port); await b.ready(); await b.req("login", { uuid: "u2", name: "B" });
  for (let i = 1; i <= 3; i++) await a.req("send", { channelId: "lobby", text: "m" + i });
  assert.equal((await b.req("check")).items!.length, 2); // 상한
  assert.equal((await b.req("check")).items!.length, 1); // 나머지
  a.close(); b.close(); hub.stop();
});

test("wait는 새 메시지가 오면 즉시 반환, 없으면 타임아웃에 빈 배열", async () => {
  const { hub, port } = await startHub();
  const a = new Client(port); await a.ready(); await a.req("login", { uuid: "u1", name: "A" });
  const b = new Client(port); await b.ready(); await b.req("login", { uuid: "u2", name: "B" });
  const waiting = b.req("wait", { timeoutMs: 5000 });
  setTimeout(() => a.req("send", { channelId: "lobby", text: "깨어나" }), 50);
  assert.deepEqual((await waiting).items!.map((i) => i.text), ["깨어나"]);
  assert.deepEqual((await a.req("wait", { timeoutMs: 1000 })).items, []); // 타임아웃
  a.close(); b.close(); hub.stop();
});

test("read는 채널 이력을 주되 커서를 바꾸지 않는다", async () => {
  const { hub, port } = await startHub();
  const a = new Client(port); await a.ready(); await a.req("login", { uuid: "u1", name: "A" });
  const b = new Client(port); await b.ready(); await b.req("login", { uuid: "u2", name: "B" });
  await a.req("send", { channelId: "lobby", text: "이력1" });
  assert.deepEqual((await b.req("read", { channelId: "lobby" })).messages!.map((m) => m.text), ["이력1"]);
  assert.equal((await b.req("check")).items!.length, 1); // read가 커서를 안 바꿔서 check에 그대로
  a.close(); b.close(); hub.stop();
});

test("없는 채널로 send/read는 거부(크래시 아님)", async () => {
  const { hub, port } = await startHub();
  const a = new Client(port); await a.ready(); await a.req("login", { uuid: "u1", name: "A" });
  assert.equal((await a.req("send", { channelId: "nope", text: "x" })).ok, false);
  assert.equal((await a.req("read", { channelId: "nope" })).ok, false);
  a.close(); hub.stop();
});

test("멤버가 아닌 계정은 멤버 제한 채널에 send할 수 없다", async () => {
  const { hub, port } = await startHub();
  // 멤버 제한 채널(DM 형태)을 내부 등록해 접근 제어 코드 경로를 검증(1단계엔 DM op가 없으므로 직접 등록).
  (hub as unknown as { channels: { register: (c: { id: string; kind: string; label: string; members: string[] }) => void } })
    .channels.register({ id: "dm1", kind: "dm", label: "A-B", members: ["u1", "u2"] });
  const c = new Client(port); await c.ready(); await c.req("login", { uuid: "u3", name: "C" });
  const r = await c.req("send", { channelId: "dm1", text: "침입" });
  assert.equal(r.ok, false);
  assert.match(r.error!, /접근/);
  c.close(); hub.stop();
});

test("같은 uuid로 두 연결이 login해도 같은 계정·인박스를 공유한다", async () => {
  const { hub, port } = await startHub();
  const a = new Client(port); await a.ready(); await a.req("login", { uuid: "u1", name: "A" });
  const sender = new Client(port); await sender.ready(); await sender.req("login", { uuid: "u2", name: "B" });
  await sender.req("send", { channelId: "lobby", text: "공유테스트" });
  const a2 = new Client(port); await a2.ready(); await a2.req("login", { uuid: "u1", name: "A" });
  assert.equal((await a2.req("check")).items!.length, 1);
  assert.equal((await a.req("check")).items!.length, 0); // 같은 커서 공유
  a.close(); a2.close(); sender.close(); hub.stop();
});

test("잘못된 프레임(null)을 받아도 Hub는 죽지 않는다", async () => {
  const { hub, port } = await startHub();
  const raw = net.connect(port, "127.0.0.1");
  await new Promise<void>((res) => raw.once("connect", () => res()));
  raw.write(encodeFrame(null));
  const dec = new FrameDecoder();
  const reply = new Promise<Response>((resolve) => raw.on("data", (d) => dec.push(d, (r: Response) => resolve(r))));
  raw.write(encodeFrame({ op: "hello", id: 1 }));
  assert.equal((await reply).ok, true);
  raw.destroy(); hub.stop();
});
