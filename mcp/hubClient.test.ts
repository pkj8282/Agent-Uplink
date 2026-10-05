import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { randomBytes } from "node:crypto";
import { HubClient } from "./hubClient.js";
import { encodeFrame, FrameDecoder } from "../shared/framing.js";
import { Hub } from "../hub/server.js";
import { startTestHub, TEST_SECURE_DEPS } from "../hub/testing.js";

const HUB_ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "hub", "index.ts");
const NODE_ARGS = ["--import", "tsx"];
let portSeq = 49400;
function freshPort(): number { return portSeq++; }
function tmp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), "uplink-v2c-")); }

/** 같은 포트(= 같은 Hub)의 클라이언트는 같은 데이터 폴더(같은 client.key)를 쓴다. */
const dirByPort = new Map<number, string>();

function makeClient(port: number, uuid: string, name: string): HubClient {
  if (!dirByPort.has(port)) dirByPort.set(port, tmp());
  process.env.UPLINK_DATA_DIR = dirByPort.get(port)!;
  process.env.UPLINK_IDLE_MINUTES = "0.1";
  process.env.UPLINK_TCP_PORT = String(port);
  process.env.UPLINK_HTTP_PORT = String(port + 1000);
  return new HubClient({ port, accountUuid: uuid, accountName: name, hubEntry: HUB_ENTRY, nodeArgs: NODE_ARGS });
}

test("Hub 자동 spawn 후 login되고 whoami가 내 계정을 준다", async () => {
  const port = freshPort();
  const c = makeClient(port, "acc-A", "A");
  const r = await c.whoami();
  assert.equal(r.uuid, "acc-A");
  assert.equal(r.name, "A");
  c.close();
  await new Promise((r) => setTimeout(r, 300));
});

test("두 계정이 lobby로 메시지를 주고받는다(fan-out)", async () => {
  const port = freshPort();
  const a = makeClient(port, "acc-A", "A");
  const b = makeClient(port, "acc-B", "B");
  await Promise.all([a.whoami(), b.whoami()]); // 둘 다 login
  await a.send("lobby", "안녕 B");
  const got = await b.wait(3000);
  assert.deepEqual(got.items!.map((i) => i.text), ["안녕 B"]);
  a.close(); b.close();
  await new Promise((r) => setTimeout(r, 300));
});

test("재연결 후에도 같은 계정으로 커서가 유지된다", async () => {
  const port = freshPort();
  const a = makeClient(port, "acc-A", "A");
  const b = makeClient(port, "acc-B", "B");
  await Promise.all([a.whoami(), b.whoami()]);
  await a.send("lobby", "첫메시지");
  assert.equal((await b.check()).items!.length, 1); // 커서 전진
  b.dropConnectionForTest();
  assert.equal((await b.check()).items!.length, 0); // 재연결 후, 이미 읽은 건 재수신 안 함
  a.close(); b.close();
  await new Promise((r) => setTimeout(r, 300));
});

test("open_dm으로 연 채널로 두 계정이 DM을 주고받는다", async () => {
  const port = freshPort();
  const a = makeClient(port, "acc-A", "A");
  const b = makeClient(port, "acc-B", "B");
  await Promise.all([a.whoami(), b.whoami()]);
  const dm = await a.openDm("acc-B");
  assert.equal(dm.ok, true);
  await a.send(dm.channelId!, "디엠 테스트");
  const got = await b.wait(3000);
  assert.deepEqual(got.items!.map((i) => i.text), ["디엠 테스트"]);
  assert.equal(got.items![0].channelKind, "dm");
  assert.equal((await a.listDms()).dms!.find((d) => d.peer === "acc-B")!.channelId, dm.channelId);
  a.close(); b.close();
  await new Promise((r) => setTimeout(r, 300));
});

test("서버·채널을 만들고 전체 공개 채널로 메시지를 주고받는다", async () => {
  const port = freshPort();
  const a = makeClient(port, "acc-A", "A");
  const b = makeClient(port, "acc-B", "B");
  await Promise.all([a.whoami(), b.whoami()]);
  const srv = await a.createServer("A서버");
  assert.equal(srv.ok, true);
  const ch = await a.createChannel(srv.serverId!, "논의방");
  assert.equal(ch.ok, true);
  assert.equal((await b.listServers()).servers!.find((s) => s.serverId === srv.serverId)!.name, "A서버");
  assert.equal((await b.listChannels(srv.serverId!)).channels![0].channelId, ch.channelId);
  await a.send(ch.channelId!, "서버글");
  const got = await b.wait(3000);
  assert.deepEqual(got.items!.map((i) => i.text), ["서버글"]);
  assert.equal(got.items![0].channelKind, "server");
  a.close(); b.close();
  await new Promise((r) => setTimeout(r, 300));
});

/** hello·auth에 정해진 대로 답하는 가짜 서버. 받은 바이트를 모은다. */
/** onReq가 "drop"이면 연결을 끊는다. helloDelayMs를 주면 onReq가 null을 돌려준 hello에 그만큼 늦게 v3 hello로 답한다. */
async function fakeHub(onReq: (r: any) => object | "drop" | null, helloDelayMs?: number): Promise<{ port: number; bytes: () => string; close: () => void }> {
  const seen: Buffer[] = [];
  const socks = new Set<net.Socket>();
  const srv = net.createServer((s) => {
    socks.add(s);
    const dec = new FrameDecoder();
    s.on("data", (d) => { seen.push(d); dec.push(d, (r: any) => {
      const res = onReq(r);
      if (res === "drop") s.destroy();
      else if (res) s.write(encodeFrame({ id: r.id, ...res }));
      else if (r.op === "hello" && helloDelayMs !== undefined) {
        setTimeout(() => { if (!s.destroyed) s.write(encodeFrame({ ok: true, id: r.id, magic: "agent-uplink", version: 3, nonce: randomBytes(32).toString("hex") })); }, helloDelayMs);
      }
    }); });
    s.on("error", () => {});
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  return { port: (srv.address() as net.AddressInfo).port, bytes: () => Buffer.concat(seen).toString("utf8"), close: () => { for (const s of socks) s.destroy(); srv.close(); } };
}

function keyDir(): { dir: string; key: string } {
  const dir = tmp(); const key = randomBytes(32).toString("hex");
  fs.writeFileSync(path.join(dir, "client.key"), key);
  return { dir, key };
}

test("RT12: 가짜 Hub(증명 위조)에는 붙지 않고 키도 보내지 않는다", async () => {
  const { dir, key } = keyDir();
  const f = await fakeHub((r) => r.op === "hello" ? { ok: true, magic: "agent-uplink", version: 3, nonce: randomBytes(32).toString("hex") }
    : r.op === "auth" ? { ok: true, proof: randomBytes(32).toString("hex") } : { ok: true });
  const c = new HubClient({ port: f.port, dataDir: dir, hubEntry: "nonexistent.js" });
  await assert.rejects(c.listAccounts(), /이 Windows 사용자의 Hub가 아닙니다/);
  assert.equal(f.bytes().includes(key), false);
  assert.doesNotMatch(f.bytes(), /list_accounts|login/);
  c.close(); f.close();
});

test("v2 Hub에는 구버전 안내", async () => {
  const { dir } = keyDir();
  const f = await fakeHub((r) => r.op === "hello" ? { ok: true, magic: "agent-uplink", version: 2 } : null);
  const c = new HubClient({ port: f.port, dataDir: dir, hubEntry: "nonexistent.js" });
  await assert.rejects(c.listAccounts(), /구버전\(프로토콜 v2\)/);
  c.close(); f.close();
});

test("보안 준비 실패한 Hub의 사유를 그대로 보여준다", async () => {
  const { dir } = keyDir();
  const f = await fakeHub((r) => r.op === "hello" ? { ok: false, code: "secure_setup_failed", error: "다른 사용자가 만든 항목" } : null);
  const c = new HubClient({ port: f.port, dataDir: dir, hubEntry: "nonexistent.js" });
  await assert.rejects(c.listAccounts(), /Hub를 시작할 수 없습니다: 다른 사용자가 만든 항목/);
  c.close(); f.close();
});

test("MCP와 Hub의 UPLINK_DATA_DIR가 다르면(키 불일치) UPLINK_DATA_DIR를 안내한다", async () => {
  const { hub, port } = await startTestHub();
  const { dir } = keyDir(); // 다른 키
  const c = new HubClient({ port, dataDir: dir, hubEntry: "nonexistent.js" });
  await assert.rejects(c.listAccounts(), /UPLINK_DATA_DIR/);
  c.close(); hub.stop();
});

test("Hub 재시작(같은 데이터 폴더) 뒤 자동 재인증·재로그인", async () => {
  const first = await startTestHub();
  const port = first.port;
  const c = new HubClient({ port, dataDir: first.dataDir, accountUuid: "u1", accountName: "A", hubEntry: "nonexistent.js" });
  assert.equal((await c.whoami()).uuid, "u1");
  first.hub.stop();
  await new Promise((r) => setTimeout(r, 100));
  const hub2 = new Hub({ tcpPort: port, httpPort: 0, dataDir: first.dataDir, idleShutdownMs: 0 });
  await hub2.startTcp(); await hub2.secure(TEST_SECURE_DEPS);
  assert.equal((await c.whoami()).uuid, "u1");
  c.close(); hub2.stop();
});

test("RT12: 핸드셰이크 도중 들어온 동시 호출도 Hub 증명 확인 전에는 아무것도 보내지 않는다", async () => {
  const { dir } = keyDir();
  const f = await fakeHub((r) => {
    if (r.op === "hello") {
      // hello 응답을 늦춰 핸드셰이크 틈을 넓힌다(가짜 Hub는 마음대로 늦출 수 있다).
      return null;
    }
    return r.op === "auth" ? { ok: true, proof: randomBytes(32).toString("hex") } : { ok: true, seq: 1, uuid: "u", name: "x" };
  }, 500);
  const c = new HubClient({ port: f.port, dataDir: dir, accountUuid: "victim", accountName: "피해자", hubEntry: "nonexistent.js" });
  const first = c.whoami(); // 연결·핸드셰이크 시작(소켓은 붙었고 hello 응답 대기 중)
  await new Promise((r) => setTimeout(r, 100));
  const second = c.send("lobby", "SECRET-MESSAGE-TEXT"); // 그 틈에 들어온 다른 도구 호출
  const results = await Promise.allSettled([first, second]);
  assert.deepEqual(results.map((r) => r.status), ["rejected", "rejected"]);
  assert.doesNotMatch(f.bytes(), /SECRET-MESSAGE-TEXT|"op":"send"|"op":"login"/);
  c.close(); f.close();
});

test("Minor4: v3 Hub가 답했는데 이 데이터 폴더에 client.key가 없으면 '이 사용자의 Hub가 아님'으로 안내", async () => {
  const dir = tmp(); // client.key 없음
  const f = await fakeHub((r) => r.op === "hello" ? { ok: true, magic: "agent-uplink", version: 3, nonce: randomBytes(32).toString("hex") } : null);
  const c = new HubClient({ port: f.port, dataDir: dir, hubEntry: "nonexistent.js" });
  await assert.rejects(c.listAccounts(), (e: Error) => /이 Windows 사용자의 Hub가 아닙니다/.test(e.message) && !/ENOENT/.test(e.message));
  c.close(); f.close();
});

test("Minor5: 인증 중 연결이 끊기면 '다른 사용자' 대신 끊김 안내, auth_failed는 그대로 '이 사용자의 Hub가 아님'", async () => {
  const { dir } = keyDir();
  const hello = { ok: true, magic: "agent-uplink", version: 3, nonce: randomBytes(32).toString("hex") };
  const drop = await fakeHub((r) => (r.op === "hello" ? hello : "drop")); // auth를 받으면 끊는다(상한 밀어내기·Hub 종료 흉내)
  const c1 = new HubClient({ port: drop.port, dataDir: dir, hubEntry: "nonexistent.js" });
  await assert.rejects(c1.listAccounts(), (e: Error) => /인증 중 Hub 연결이 끊기거나 응답이 없습니다/.test(e.message) && !/다른 사용자/.test(e.message));
  c1.close(); drop.close();
  const failed = await fakeHub((r) => (r.op === "hello" ? hello : { ok: false, code: "auth_failed", error: "인증 실패" }));
  const c2 = new HubClient({ port: failed.port, dataDir: dir, hubEntry: "nonexistent.js" });
  await assert.rejects(c2.listAccounts(), /이 Windows 사용자의 Hub가 아닙니다/);
  c2.close(); failed.close();
});
