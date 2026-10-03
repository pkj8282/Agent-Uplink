import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hub } from "../../hub/server.js";
import { encodeFrame, FrameDecoder } from "./framing.js";
import { AdminClient, HubNotRunningError, HUB_DOWN_MESSAGE, resolveAdminTarget, toResult } from "./adminClient.js";

function tmp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), "uplink-admin-")); }

async function startHub(dataDir = tmp()) {
  const hub = new Hub({ tcpPort: 0, httpPort: 0, dataDir, idleShutdownMs: 0 });
  await hub.startTcp();
  const port = hub.tcpAddress.port;
  const client = new AdminClient({ port, keyPath: path.join(dataDir, "admin.key"), timeoutMs: 2000 });
  return { hub, port, dataDir, client };
}

/** 에이전트 op로 데이터를 심는 원시 클라이언트(연결당 로그인 1개). */
class Raw {
  private sock: net.Socket;
  private dec = new FrameDecoder();
  private waiters = new Map<number, (r: any) => void>();
  private id = 0;
  constructor(port: number) {
    this.sock = net.connect(port, "127.0.0.1");
    this.sock.on("data", (d) => this.dec.push(d, (r: any) => this.waiters.get(r.id)?.(r)));
  }
  ready(): Promise<void> { return new Promise((res) => this.sock.once("connect", () => res())); }
  req(op: string, params: object = {}): Promise<any> {
    const id = ++this.id;
    return new Promise((resolve) => { this.waiters.set(id, resolve); this.sock.write(encodeFrame({ op, id, ...params })); });
  }
  close(): void { this.sock.destroy(); }
}

async function seed(port: number) {
  const a = new Raw(port); await a.ready(); await a.req("login", { uuid: "u1", name: "A" });
  const b = new Raw(port); await b.ready(); await b.req("login", { uuid: "u2", name: "B" });
  const srv = await a.req("create_server", { name: "S" });
  const ch = await a.req("create_channel", { serverId: srv.serverId, name: "c1" });
  const dm = await a.req("open_dm", { peer: "u2" });
  return { a, b, serverId: srv.serverId as string, channelId: ch.channelId as string, dmId: dm.channelId as string };
}

/** 지금 비어 있는(아무도 listen하지 않는) 포트. */
async function closedPort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

test("resolveAdminTarget은 Hub와 같은 env 규칙을 따른다", () => {
  assert.deepEqual(resolveAdminTarget({ PROGRAMDATA: "C:\\PD" }), {
    port: 47800,
    keyPath: path.join("C:\\PD", "AgentUplink", "admin.key"),
  });
  assert.deepEqual(resolveAdminTarget({ PROGRAMDATA: "C:\\PD", UPLINK_DATA_DIR: "D:\\data", UPLINK_TCP_PORT: "47900" }), {
    port: 47900,
    keyPath: path.join("D:\\data", "admin.key"),
  });
});

test("snapshot은 config·서버·계정·DM을 반환한다", async () => {
  const { hub, port, client } = await startHub();
  const s = await seed(port);
  const snap = await client.snapshot();
  assert.equal(snap.config.maxChannelsPerServer, 30);
  assert.equal(snap.servers.length, 1);
  assert.equal(snap.servers[0].id, s.serverId);
  assert.deepEqual(snap.servers[0].channels.map((c) => c.name), ["c1"]);
  assert.deepEqual(snap.accounts.map((a) => a.name).sort(), ["A", "B"]);
  assert.equal(snap.dms.length, 1);
  assert.deepEqual([...snap.dms[0].members].sort(), ["u1", "u2"]);
  s.a.close(); s.b.close(); hub.stop();
});

test("setConfig는 저장된 config를 반환하고, 잘못된 값은 Hub 메시지로 거부하며 기존 값을 유지한다", async () => {
  const { hub, client } = await startHub();
  const cfg = await client.setConfig({ maxChannelsPerServer: 5, allowDevDelete: false });
  assert.equal(cfg.maxChannelsPerServer, 5);
  assert.equal(cfg.allowDevDelete, false);
  await assert.rejects(client.setConfig({ inboxMaxBatch: 0 }), /inboxMaxBatch/);
  assert.equal((await client.snapshot()).config.maxChannelsPerServer, 5); // 유지
  hub.stop();
});

test("delete*는 대상을 제거하고, 없는 대상은 명확히 거부한다", async () => {
  const { hub, port, client } = await startHub();
  const s = await seed(port);
  await client.deleteChannel(s.channelId);
  assert.deepEqual((await client.snapshot()).servers[0].channels, []);
  await client.deleteServer(s.serverId);
  assert.equal((await client.snapshot()).servers.length, 0);
  await client.deleteAccount("u1");
  const snap = await client.snapshot();
  assert.deepEqual(snap.accounts.map((a) => a.uuid), ["u2"]);
  assert.equal(snap.dms.length, 0);
  await assert.rejects(client.deleteChannel("nope"), /없습니다/);
  await assert.rejects(client.deleteServer("nope"), /없습니다/);
  await assert.rejects(client.deleteAccount("nope"), /없습니다/);
  s.a.close(); s.b.close(); hub.stop();
});

test("Hub 미실행(접속 거부)과 사용 중 Hub 종료는 HubNotRunningError → toResult hubDown:true", async () => {
  const port = await closedPort();
  const dead = new AdminClient({ port, keyPath: path.join(tmp(), "admin.key"), timeoutMs: 2000 });
  await assert.rejects(dead.snapshot(), (e: unknown) => e instanceof HubNotRunningError && (e as Error).message === HUB_DOWN_MESSAGE);
  assert.deepEqual(await toResult(() => dead.snapshot()), { ok: false, error: HUB_DOWN_MESSAGE, hubDown: true });

  const { hub, client } = await startHub();
  await client.snapshot(); // 정상
  hub.stop(); // 앱 사용 중 Hub 종료
  await assert.rejects(client.snapshot(), HubNotRunningError);
});

test("admin.key 없음/빈 파일/불일치는 크래시 없이 명확한 에러", async () => {
  const { hub, port, dataDir } = await startHub();
  const missing = new AdminClient({ port, keyPath: path.join(tmp(), "admin.key"), timeoutMs: 2000 });
  await assert.rejects(missing.snapshot(), /admin\.key/);
  await assert.rejects(missing.snapshot(), /관리 기능이 있는 버전/);

  const emptyKey = path.join(tmp(), "admin.key");
  fs.writeFileSync(emptyKey, "  \n");
  await assert.rejects(new AdminClient({ port, keyPath: emptyKey, timeoutMs: 2000 }).snapshot(), /admin\.key/);

  const wrongKey = path.join(tmp(), "admin.key");
  fs.writeFileSync(wrongKey, "f".repeat(64));
  const r = await toResult(() => new AdminClient({ port, keyPath: wrongKey, timeoutMs: 2000 }).snapshot());
  assert.deepEqual(r, { ok: false, error: "admin 인증 실패", hubDown: false });

  // 키 파일의 앞뒤 공백/개행은 무시한다
  const padded = path.join(tmp(), "admin.key");
  fs.writeFileSync(padded, `\n${fs.readFileSync(path.join(dataDir, "admin.key"), "utf8").trim()}\r\n`);
  assert.equal((await new AdminClient({ port, keyPath: padded, timeoutMs: 2000 }).snapshot()).servers.length, 0);
  hub.stop();
});

test("무응답 서버(포트 점유)는 무한 대기 없이 타임아웃 에러", async () => {
  const socks = new Set<net.Socket>();
  const silent = net.createServer((s) => { socks.add(s); }); // 받기만 하고 응답 안 함
  await new Promise<void>((r) => silent.listen(0, "127.0.0.1", () => r()));
  const port = (silent.address() as net.AddressInfo).port;
  const c = new AdminClient({ port, keyPath: path.join(tmp(), "admin.key"), timeoutMs: 300 });
  const t0 = Date.now();
  await assert.rejects(c.snapshot(), /응답하지 않습니다/);
  assert.ok(Date.now() - t0 < 3000);
  for (const s of socks) s.destroy();
  silent.close();
});

test("다른 프로토콜 서버(magic 불일치)는 Agent-Uplink Hub가 아니라고 거부", async () => {
  const socks = new Set<net.Socket>();
  const other = net.createServer((s) => {
    socks.add(s);
    const dec = new FrameDecoder();
    s.on("data", (d) => dec.push(d, (req: any) => s.write(encodeFrame({ ok: true, id: req.id, magic: "other", version: 1 }))));
  });
  await new Promise<void>((r) => other.listen(0, "127.0.0.1", () => r()));
  const port = (other.address() as net.AddressInfo).port;
  const c = new AdminClient({ port, keyPath: path.join(tmp(), "admin.key"), timeoutMs: 2000 });
  await assert.rejects(c.snapshot(), /Agent-Uplink Hub가 아닙니다/);
  for (const s of socks) s.destroy();
  other.close();
});

test("toResult는 성공은 data로, 일반 에러는 hubDown:false로 감싼다", async () => {
  assert.deepEqual(await toResult(async () => 42), { ok: true, data: 42 });
  assert.deepEqual(await toResult(async () => { throw new Error("x"); }), { ok: false, error: "x", hubDown: false });
  // 동기 throw도 잡는다(IPC 인자 검증용)
  assert.deepEqual(await toResult(() => { throw new Error("y"); }), { ok: false, error: "y", hubDown: false });
});

/** 요청 프레임마다 onFrame을 부르는 가짜 서버(소켓 추적·정리). */
async function fakeServer(onFrame: (req: any, sock: net.Socket) => void, onConnect?: (sock: net.Socket) => void) {
  const socks = new Set<net.Socket>();
  const srv = net.createServer((s) => {
    socks.add(s);
    s.on("error", () => { /* 무시 */ });
    if (onConnect) { onConnect(s); return; }
    const dec = new FrameDecoder();
    s.on("data", (d) => dec.push(d, (req: any) => onFrame(req, s)));
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  return {
    port: (srv.address() as net.AddressInfo).port,
    close: () => { for (const s of socks) s.destroy(); srv.close(); },
  };
}

function keyFile(): string {
  const p = path.join(tmp(), "admin.key");
  fs.writeFileSync(p, "a".repeat(64));
  return p;
}

const HELLO_OK = { magic: "agent-uplink", version: 2 };

test("요청 도중 Hub가 끊기면 적용 여부 확인 안내", async () => {
  const f = await fakeServer((req, s) => {
    if (req.op === "hello") s.write(encodeFrame({ ok: true, id: req.id, ...HELLO_OK }));
    else s.destroy();
  });
  const c = new AdminClient({ port: f.port, keyPath: keyFile(), timeoutMs: 2000 });
  await assert.rejects(c.deleteServer("s1"), /새로고침으로 확인/);
  f.close();
});

test("접속 직후 끊는 프로그램은 Hub가 아닐 수 있다고 안내", async () => {
  const f = await fakeServer(() => {}, (s) => s.destroy());
  const c = new AdminClient({ port: f.port, keyPath: keyFile(), timeoutMs: 2000 });
  await assert.rejects(c.snapshot(), /응답 없이 연결을 끊었습니다/);
  f.close();
});

test("버전만 다른 Hub는 버전 불일치로 안내", async () => {
  const f = await fakeServer((req, s) => s.write(encodeFrame({ ok: true, id: req.id, magic: "agent-uplink", version: 3 })));
  const c = new AdminClient({ port: f.port, keyPath: keyFile(), timeoutMs: 2000 });
  await assert.rejects(c.snapshot(), /버전\(v3\)이 관리 도구\(v2\)와 맞지 않습니다/);
  f.close();
});

test("구버전 Hub(admin op 없음)는 재배포 안내", async () => {
  const f = await fakeServer((req, s) => {
    if (req.op === "hello") s.write(encodeFrame({ ok: true, id: req.id, ...HELLO_OK }));
    else s.write(encodeFrame({ ok: false, id: req.id, error: "알 수 없는 op" }));
  });
  const c = new AdminClient({ port: f.port, keyPath: keyFile(), timeoutMs: 2000 });
  await assert.rejects(c.snapshot(), /구버전/);
  f.close();
});

test("응답 프레임이 JSON null이어도 크래시 없이 처리", async () => {
  const f = await fakeServer((req, s) => {
    s.write(encodeFrame(null));
    s.write(encodeFrame({ ok: true, id: req.id, magic: "other", version: 1 }));
  });
  const c = new AdminClient({ port: f.port, keyPath: keyFile(), timeoutMs: 2000 });
  await assert.rejects(c.snapshot(), /Agent-Uplink Hub가 아닙니다/);
  f.close();
});

test("연결 단계가 멈춰도 무한 대기하지 않는다", async () => {
  // 라우팅 불가 주소로 SYN이 버려지는 상황을 흉내 낸다(실제 Hub 포트는 쓰지 않는다).
  const c = new AdminClient({ port: await closedPort(), host: "10.255.255.1", connectTimeoutMs: 300, keyPath: keyFile(), timeoutMs: 300 });
  const t0 = Date.now();
  await assert.rejects(c.snapshot(), /연결 시간이 초과/);
  assert.ok(Date.now() - t0 < 1500, `${Date.now() - t0}ms`);
});
