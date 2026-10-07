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

import { startTestHub, TestClient as Client, TEST_SECURE_DEPS } from "./testing.js";
import { newNonce, clientProof, hubProof, proofEquals } from "../shared/auth.js";
import { readClientKey } from "../shared/clientKey.js";

async function startHub(dataDir?: string) { return startTestHub({ dataDir }); }

test("hello는 매직·버전3·nonce를 준다(인증 전에도)", async () => {
  const { hub, port } = await startHub();
  const c = new Client(port); await c.connected();
  const r = await c.req("hello");
  assert.equal(r.magic, "agent-uplink");
  assert.equal(r.version, 3);
  assert.match(r.nonce!, /^[0-9a-f]{64}$/);
  c.close(); hub.stop();
});

test("RT10: 인증 전에는 hello·auth 외 모든 op가 auth_required", async () => {
  const { hub, port } = await startHub();
  const c = new Client(port); await c.connected();
  for (const op of ["list_accounts", "account_status", "login", "check", "read", "send", "viewer_ticket", "admin_snapshot", "없는op"]) {
    const r = await c.req(op, { uuid: "u1", uuids: ["u1"], channelId: "lobby", text: "x" });
    assert.equal(r.ok, false, op);
    assert.equal(r.code, "auth_required", op);
  }
  c.close(); hub.stop();
});

test("hello 전에 auth하면 auth_required, hello 없이 보낸 login도 auth_required(파이프라이닝)", async () => {
  const { hub, port } = await startHub();
  const c = new Client(port); await c.connected();
  const [a, b] = await Promise.all([c.req("auth", { nonce: newNonce(), proof: newNonce() }), c.req("login", { uuid: "u1" })]);
  assert.equal(a.code, "auth_required");
  assert.equal(b.code, "auth_required");
  c.close(); hub.stop();
});

test("올바른 증명이면 Hub 증명을 돌려주고 op가 열린다", async () => {
  const { hub, port, dataDir } = await startHub();
  const c = new Client(port); await c.connected();
  const h = await c.req("hello");
  const key = readClientKey(dataDir); const n = newNonce();
  const r = await c.req("auth", { nonce: n, proof: clientProof(key, h.nonce!, n) });
  assert.equal(r.ok, true);
  assert.ok(proofEquals(hubProof(key, h.nonce!, n), r.proof));
  assert.equal((await c.req("login", { uuid: "u1", name: "A" })).ok, true);
  assert.equal((await c.req("auth", { nonce: n, proof: "0".repeat(64) })).code, "already_authed");
  c.close(); hub.stop();
});

test("틀린 증명은 auth_failed 후 연결을 끊는다", async () => {
  const { hub, port } = await startHub();
  const c = new Client(port); await c.connected();
  await c.req("hello");
  const closed = c.onClose();
  const r = await c.req("auth", { nonce: newNonce(), proof: "0".repeat(64) });
  assert.equal(r.code, "auth_failed");
  await closed;
  hub.stop();
});

test("다른 연결의 증명을 재전송해도 통하지 않는다(nonce가 연결마다 다름)", async () => {
  const { hub, port, dataDir } = await startHub();
  const key = readClientKey(dataDir);
  const a = new Client(port); await a.connected();
  const ha = await a.req("hello"); const n = newNonce(); const proof = clientProof(key, ha.nonce!, n);
  const b = new Client(port); await b.connected();
  await b.req("hello");
  assert.equal((await b.req("auth", { nonce: n, proof })).code, "auth_failed");
  a.close(); b.close(); hub.stop();
});

test("보안 준비 전 hello는 준비가 끝날 때까지 기다렸다 답한다", async () => {
  const dataDir = tmp();
  const hub = new Hub({ tcpPort: 0, httpPort: 0, dataDir, idleShutdownMs: 0 });
  await hub.startTcp();
  const c = new Client(hub.tcpAddress.port, dataDir); await c.connected();
  let answered = false;
  const p = c.req("hello").then((r) => { answered = true; return r; });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(answered, false);
  await hub.secure(TEST_SECURE_DEPS);
  assert.equal((await p).version, 3);
  c.close(); hub.stop();
});

test("보안 준비 실패 시 hello는 secure_setup_failed와 사유를 준다", async () => {
  const dataDir = tmp();
  const hub = new Hub({ tcpPort: 0, httpPort: 0, dataDir, idleShutdownMs: 0 });
  await hub.startTcp();
  const c = new Client(hub.tcpAddress.port, dataDir); await c.connected();
  const p = c.req("hello");
  await assert.rejects(hub.secure({ ...TEST_SECURE_DEPS, platform: "win32", restrictAcl: async () => ({ ok: false, error: "막힘" }) }));
  const r = await p;
  assert.equal(r.ok, false);
  assert.equal(r.code, "secure_setup_failed");
  assert.match(r.error!, /막힘/);
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

test("open_dm은 멱등: 같은 상대엔 하나의 채널만, 양쪽 역색인에 기록된다", async () => {
  const { hub, port } = await startHub();
  const a = new Client(port); await a.ready(); await a.req("login", { uuid: "u1", name: "A" });
  const b = new Client(port); await b.ready(); await b.req("login", { uuid: "u2", name: "B" });
  const first = await a.req("open_dm", { peer: "u2" });
  assert.equal(first.ok, true);
  const again = await a.req("open_dm", { peer: "u2" });
  assert.equal(again.channelId, first.channelId); // 멱등
  const fromB = await b.req("open_dm", { peer: "u1" });
  assert.equal(fromB.channelId, first.channelId); // 반대쪽도 같은 채널
  assert.equal((await a.req("list_dms")).dms!.find((d) => d.peer === "u2")!.channelId, first.channelId);
  assert.equal((await b.req("list_dms")).dms!.find((d) => d.peer === "u1")!.channelId, first.channelId);
  a.close(); b.close(); hub.stop();
});

test("open_dm은 이름으로도 되지만 모호하면 거부, 없으면 거부, 자기자신 거부", async () => {
  const { hub, port } = await startHub();
  const a = new Client(port); await a.ready(); await a.req("login", { uuid: "u1", name: "A" });
  const b = new Client(port); await b.ready(); await b.req("login", { uuid: "u2", name: "B" });
  const c = new Client(port); await c.ready(); await c.req("login", { uuid: "u3", name: "B" }); // 이름 중복 B
  assert.equal((await a.req("open_dm", { peer: "없는계정" })).ok, false);
  assert.equal((await a.req("open_dm", { peer: "B" })).ok, false); // 모호(u2,u3)
  assert.equal((await a.req("open_dm", { peer: "u1" })).ok, false); // 자기 자신
  assert.equal((await a.req("open_dm", { peer: "u2" })).ok, true); // 유일 uuid OK
  a.close(); b.close(); c.close(); hub.stop();
});

test("DM 메시지는 쌍의 두 계정에만 가고 제3자에겐 안 간다", async () => {
  const { hub, port } = await startHub();
  const a = new Client(port); await a.ready(); await a.req("login", { uuid: "u1", name: "A" });
  const b = new Client(port); await b.ready(); await b.req("login", { uuid: "u2", name: "B" });
  const c = new Client(port); await c.ready(); await c.req("login", { uuid: "u3", name: "C" });
  const dm = await a.req("open_dm", { peer: "u2" });
  await a.req("send", { channelId: dm.channelId, text: "B에게만" });
  assert.deepEqual((await b.req("check")).items!.map((i) => i.text), ["B에게만"]);
  assert.deepEqual((await c.req("check")).items, []); // 제3자 제외
  a.close(); b.close(); c.close(); hub.stop();
});

test("재시작 후에도 기존 DM 채널로 send/read가 동작한다", async () => {
  const dataDir = tmp();
  const h1 = await startHub(dataDir);
  const a1 = new Client(h1.port); await a1.ready(); await a1.req("login", { uuid: "u1", name: "A" });
  const b1 = new Client(h1.port); await b1.ready(); await b1.req("login", { uuid: "u2", name: "B" });
  const dm = await a1.req("open_dm", { peer: "u2" });
  await a1.req("send", { channelId: dm.channelId, text: "재시작전" });
  a1.close(); b1.close(); h1.hub.stop();
  const h2 = await startHub(dataDir);
  const a2 = new Client(h2.port); await a2.ready(); await a2.req("login", { uuid: "u1", name: "A" });
  const read = await a2.req("read", { channelId: dm.channelId });
  assert.deepEqual(read.messages!.map((m) => m.text), ["재시작전"]);
  assert.equal((await a2.req("send", { channelId: dm.channelId, text: "재시작후" })).ok, true);
  a2.close(); h2.hub.stop();
});

test("재시작 시 끊긴 DM 역색인을 dm/index.json 기준으로 복구한다", async () => {
  const dataDir = tmp();
  const h1 = await startHub(dataDir);
  const a1 = new Client(h1.port); await a1.ready(); await a1.req("login", { uuid: "u1", name: "A" });
  const b1 = new Client(h1.port); await b1.ready(); await b1.req("login", { uuid: "u2", name: "B" });
  const dm = await a1.req("open_dm", { peer: "u2" });
  a1.close(); b1.close(); h1.hub.stop();
  // 크래시로 B의 역색인이 빠진 상황을 흉내: accounts/u2.json의 dm을 비운다
  const bFile = path.join(dataDir, "accounts", "u2.json");
  const bAcc = JSON.parse(fs.readFileSync(bFile, "utf8"));
  bAcc.dm = {};
  fs.writeFileSync(bFile, JSON.stringify(bAcc));
  // 재시작 → 시작 시 dm/index.json 기준으로 역색인 복구
  const h2 = await startHub(dataDir);
  const b2 = new Client(h2.port); await b2.ready(); await b2.req("login", { uuid: "u2", name: "B" });
  const dms = (await b2.req("list_dms")).dms!;
  assert.equal(dms.find((d) => d.peer === "u1")!.channelId, dm.channelId);
  b2.close(); h2.hub.stop();
});

test("create_server/create_channel/list_*가 동작하고 서버 채널은 전체 공개로 fan-out된다", async () => {
  const { hub, port } = await startHub();
  const a = new Client(port); await a.ready(); await a.req("login", { uuid: "u1", name: "A" });
  const b = new Client(port); await b.ready(); await b.req("login", { uuid: "u2", name: "B" });
  const srv = await a.req("create_server", { name: "A서버" });
  assert.equal(srv.ok, true);
  assert.equal((await b.req("list_servers")).servers!.find((s) => s.serverId === srv.serverId)!.name, "A서버");
  const ch = await a.req("create_channel", { serverId: srv.serverId, name: "논의방" });
  assert.equal(ch.ok, true);
  assert.equal((await b.req("list_channels", { serverId: srv.serverId })).channels![0].channelId, ch.channelId);
  await a.req("send", { channelId: ch.channelId, text: "서버채널 글" });
  assert.deepEqual((await b.req("check")).items!.map((i) => i.text), ["서버채널 글"]);
  a.close(); b.close(); hub.stop();
});

test("create_channel은 maxChannelsPerServer 상한을 넘으면 거부한다", async () => {
  const dataDir = tmp();
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify({ maxChannelsPerServer: 2 }));
  const { hub, port } = await startHub(dataDir);
  const a = new Client(port); await a.ready(); await a.req("login", { uuid: "u1", name: "A" });
  const srv = await a.req("create_server", { name: "A" });
  assert.equal((await a.req("create_channel", { serverId: srv.serverId, name: "c1" })).ok, true);
  assert.equal((await a.req("create_channel", { serverId: srv.serverId, name: "c2" })).ok, true);
  const third = await a.req("create_channel", { serverId: srv.serverId, name: "c3" });
  assert.equal(third.ok, false);
  assert.match(third.error!, /한계|상한|30|2/);
  a.close(); hub.stop();
});

test("삭제는 allowDevDelete가 true일 때만, 삭제 후 채널 라우팅이 사라진다", async () => {
  const dataDir = tmp();
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify({ allowDevDelete: true }));
  const { hub, port } = await startHub(dataDir);
  const a = new Client(port); await a.ready(); await a.req("login", { uuid: "u1", name: "A" });
  const srv = await a.req("create_server", { name: "A" });
  const ch = await a.req("create_channel", { serverId: srv.serverId, name: "c1" });
  assert.equal((await a.req("delete_channel", { channelId: ch.channelId })).ok, true);
  assert.equal((await a.req("send", { channelId: ch.channelId, text: "x" })).ok, false);
  assert.equal((await a.req("delete_server", { serverId: srv.serverId })).ok, true);
  assert.equal((await a.req("list_servers")).servers!.length, 0);
  a.close(); hub.stop();
});

test("allowDevDelete가 false면 삭제는 거부된다", async () => {
  const dataDir = tmp();
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify({ allowDevDelete: false }));
  const { hub, port } = await startHub(dataDir);
  const a = new Client(port); await a.ready(); await a.req("login", { uuid: "u1", name: "A" });
  const srv = await a.req("create_server", { name: "A" });
  const ch = await a.req("create_channel", { serverId: srv.serverId, name: "c1" });
  const del = await a.req("delete_channel", { channelId: ch.channelId });
  assert.equal(del.ok, false);
  assert.match(del.error!, /삭제|허용|불가/);
  assert.equal((await a.req("delete_server", { serverId: srv.serverId })).ok, false);
  a.close(); hub.stop();
});

test("없는 서버/채널 대상 op는 크래시 없이 거부", async () => {
  const dataDir = tmp();
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify({ allowDevDelete: true }));
  const { hub, port } = await startHub(dataDir);
  const a = new Client(port); await a.ready(); await a.req("login", { uuid: "u1", name: "A" });
  assert.equal((await a.req("create_channel", { serverId: "nope", name: "c" })).ok, false);
  assert.equal((await a.req("list_channels", { serverId: "nope" })).ok, false);
  assert.equal((await a.req("delete_channel", { channelId: "nope" })).ok, false);
  assert.equal((await a.req("delete_server", { serverId: "nope" })).ok, false);
  a.close(); hub.stop();
});

test("재시작 후에도 기존 서버 채널로 send/read가 동작한다", async () => {
  const dataDir = tmp();
  const h1 = await startHub(dataDir);
  const a1 = new Client(h1.port); await a1.ready(); await a1.req("login", { uuid: "u1", name: "A" });
  const srv = await a1.req("create_server", { name: "A서버" });
  const ch = await a1.req("create_channel", { serverId: srv.serverId, name: "논의방" });
  await a1.req("send", { channelId: ch.channelId, text: "재시작전" });
  a1.close(); h1.hub.stop();
  const h2 = await startHub(dataDir);
  const a2 = new Client(h2.port); await a2.ready(); await a2.req("login", { uuid: "u1", name: "A" });
  assert.deepEqual((await a2.req("read", { channelId: ch.channelId })).messages!.map((m) => m.text), ["재시작전"]);
  assert.equal((await a2.req("send", { channelId: ch.channelId, text: "재시작후" })).ok, true);
  a2.close(); h2.hub.stop();
});

test("admin op는 토큰이 없거나 틀리면 거부된다", async () => {
  const { hub, port } = await startHub();
  const c = new Client(port); await c.ready(); await c.req("login", { uuid: "u1", name: "A" });
  assert.equal((await c.req("admin_snapshot", {})).ok, false); // 토큰 없음
  assert.equal((await c.req("admin_snapshot", { token: "deadbeef" })).ok, false); // 틀림
  c.close(); hub.stop();
});

test("admin_snapshot은 config·서버·계정·DM을 반환한다", async () => {
  const { hub, port, dataDir } = await startHub();
  const token = fs.readFileSync(path.join(dataDir, "admin.key"), "utf8").trim();
  const a = new Client(port); await a.ready(); await a.req("login", { uuid: "u1", name: "A" });
  const b = new Client(port); await b.ready(); await b.req("login", { uuid: "u2", name: "B" });
  const srv = await a.req("create_server", { name: "A서버" });
  await a.req("create_channel", { serverId: srv.serverId, name: "논의방" });
  await a.req("open_dm", { peer: "u2" });
  const snap = await a.req("admin_snapshot", { token });
  assert.equal(snap.ok, true);
  assert.equal(snap.config!.maxChannelsPerServer, 30);
  assert.equal(snap.snapshotServers!.find((s) => s.id === srv.serverId)!.channels[0].name, "논의방");
  assert.deepEqual(snap.snapshotAccounts!.map((x) => x.name).sort(), ["A", "B"]);
  assert.equal(snap.snapshotDms!.length, 1);
  a.close(); b.close(); hub.stop();
});

test("admin_set_config는 저장하고 즉시(라이브) 반영된다", async () => {
  const { hub, port, dataDir } = await startHub();
  const token = fs.readFileSync(path.join(dataDir, "admin.key"), "utf8").trim();
  const a = new Client(port); await a.ready(); await a.req("login", { uuid: "u1", name: "A" });
  const srv = await a.req("create_server", { name: "A" });
  const set = await a.req("admin_set_config", { token, patch: { maxChannelsPerServer: 1 } });
  assert.equal(set.ok, true);
  assert.equal(set.config!.maxChannelsPerServer, 1);
  assert.equal((await a.req("create_channel", { serverId: srv.serverId, name: "c1" })).ok, true);
  assert.equal((await a.req("create_channel", { serverId: srv.serverId, name: "c2" })).ok, false); // 상한1 즉시 반영
  a.close(); hub.stop();
});

test("admin_set_config는 잘못된 값을 거부하고 기존 값을 유지한다", async () => {
  const { hub, port, dataDir } = await startHub();
  const token = fs.readFileSync(path.join(dataDir, "admin.key"), "utf8").trim();
  const a = new Client(port); await a.ready(); await a.req("login", { uuid: "u1", name: "A" });
  assert.equal((await a.req("admin_set_config", { token, patch: { maxChannelsPerServer: 0 } })).ok, false);
  assert.equal((await a.req("admin_set_config", { token, patch: { inboxMaxBatch: -5 } })).ok, false);
  assert.equal((await a.req("admin_set_config", { token, patch: { allowDevDelete: "yes" } })).ok, false);
  assert.equal((await a.req("admin_snapshot", { token })).config!.maxChannelsPerServer, 30); // 유지
  a.close(); hub.stop();
});

test("admin_set_config: language는 ko/en만, 저장·응답에 반영", async () => {
  const { hub, port, dataDir } = await startTestHub({ language: "N/A" });
  const token = fs.readFileSync(path.join(dataDir, "admin.key"), "utf8").trim();
  const a = new Client(port); await a.ready();
  for (const bad of ["fr", "N/A", "KO", 1, null]) {
    const r = await a.req("admin_set_config", { token, patch: { language: bad } });
    assert.equal(r.ok, false, String(bad));
    assert.equal(r.code, "config_language_invalid", String(bad));
  }
  const r = await a.req("admin_set_config", { token, patch: { language: "ko" } });
  assert.equal(r.ok, true);
  assert.equal((r.config as { language?: string }).language, "ko");
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, "config.json"), "utf8")).language, "ko");
  a.close(); hub.stop();
});

test("admin_delete_channel/server는 allowDevDelete=false여도 삭제하고 라우팅을 제거한다", async () => {
  const dataDir = tmp();
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify({ allowDevDelete: false }));
  const { hub, port } = await startHub(dataDir);
  const token = fs.readFileSync(path.join(dataDir, "admin.key"), "utf8").trim();
  const a = new Client(port); await a.ready(); await a.req("login", { uuid: "u1", name: "A" });
  const srv = await a.req("create_server", { name: "A" });
  const ch = await a.req("create_channel", { serverId: srv.serverId, name: "c1" });
  assert.equal((await a.req("delete_channel", { channelId: ch.channelId })).ok, false); // MCP 삭제 막힘
  assert.equal((await a.req("admin_delete_channel", { token, channelId: ch.channelId })).ok, true);
  assert.equal((await a.req("send", { channelId: ch.channelId, text: "x" })).ok, false); // 라우팅 제거
  assert.equal((await a.req("admin_delete_server", { token, serverId: srv.serverId })).ok, true);
  assert.equal((await a.req("admin_snapshot", { token })).snapshotServers!.length, 0);
  a.close(); hub.stop();
});

test("admin_delete_account는 계정·알림·DM·상대 역색인을 정리한다", async () => {
  const { hub, port, dataDir } = await startHub();
  const token = fs.readFileSync(path.join(dataDir, "admin.key"), "utf8").trim();
  const a = new Client(port); await a.ready(); await a.req("login", { uuid: "u1", name: "A" });
  const b = new Client(port); await b.ready(); await b.req("login", { uuid: "u2", name: "B" });
  const dm = await a.req("open_dm", { peer: "u2" });
  await b.req("send", { channelId: dm.channelId, text: "hi" });
  assert.equal((await a.req("admin_delete_account", { token, uuid: "u1" })).ok, true);
  const snap = await a.req("admin_snapshot", { token });
  assert.equal(snap.snapshotAccounts!.find((x) => x.uuid === "u1"), undefined);
  assert.equal(snap.snapshotDms!.length, 0);
  assert.equal((await b.req("list_dms")).dms!.find((d) => d.peer === "u1"), undefined);
  a.close(); b.close(); hub.stop();
});

test("없는 대상 admin 삭제는 크래시 없이 거부", async () => {
  const { hub, port, dataDir } = await startHub();
  const token = fs.readFileSync(path.join(dataDir, "admin.key"), "utf8").trim();
  const a = new Client(port); await a.ready(); await a.req("login", { uuid: "u1", name: "A" });
  assert.equal((await a.req("admin_delete_channel", { token, channelId: "nope" })).ok, false);
  assert.equal((await a.req("admin_delete_server", { token, serverId: "nope" })).ok, false);
  assert.equal((await a.req("admin_delete_account", { token, uuid: "nope" })).ok, false);
  a.close(); hub.stop();
});

test("삭제된 계정으로 연결된 클라이언트의 다음 op는 크래시 없이 재로그인을 요구한다", async () => {
  const { hub, port, dataDir } = await startHub();
  const token = fs.readFileSync(path.join(dataDir, "admin.key"), "utf8").trim();
  const a = new Client(port); await a.ready(); await a.req("login", { uuid: "u1", name: "A" });
  const admin = new Client(port); await admin.ready(); await admin.req("login", { uuid: "u2", name: "ADM" });
  await admin.req("admin_delete_account", { token, uuid: "u1" });
  // a는 여전히 u1로 '로그인된' 상태 — 다음 login-gated op는 크래시 없이 거부돼야 한다
  const r = await a.req("check");
  assert.equal(r.ok, false);
  assert.match(r.error!, /존재하지 않|다시 login|login/i);
  // Hub는 살아있다: 다른 클라이언트가 정상 동작
  const b = new Client(port); await b.ready();
  assert.equal((await b.req("hello")).ok, true);
  a.close(); admin.close(); b.close(); hub.stop();
});

async function until(cond: () => Promise<boolean>, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await cond()) return; await new Promise((r) => setTimeout(r, 20)); }
  throw new Error("조건 시간 초과");
}

test("exclusive login은 다른 세션이 쓰는 계정을 거부하고 같은 sessionToken 재연결은 허용한다", async () => {
  const { hub, port } = await startHub();
  const a = new Client(port); await a.ready();
  assert.equal((await a.req("login", { uuid: "r1", name: "기획", exclusive: true, sessionToken: "T1" })).ok, true);
  const b = new Client(port); await b.ready();
  const rb = await b.req("login", { uuid: "r1", exclusive: true, sessionToken: "T2" });
  assert.equal(rb.ok, false);
  assert.match(rb.error!, /이미 다른 세션이 사용 중/);
  const a2 = new Client(port); await a2.ready(); // 같은 프로세스의 재연결(이전 소켓이 아직 살아 있어도)
  assert.equal((await a2.req("login", { uuid: "r1", exclusive: true, sessionToken: "T1" })).ok, true);
  a.close(); a2.close(); b.close(); hub.stop();
});

test("연결이 끊기면 계정이 즉시 비워져 다른 세션이 독점할 수 있다", async () => {
  const { hub, port } = await startHub();
  const a = new Client(port); await a.ready();
  await a.req("login", { uuid: "r1", exclusive: true, sessionToken: "T1" });
  const probe = new Client(port); await probe.ready();
  assert.equal((await probe.req("account_status", { uuids: ["r1"] })).statuses![0].online, true);
  a.close();
  await until(async () => (await probe.req("account_status", { uuids: ["r1"] })).statuses![0].online === false);
  const b = new Client(port); await b.ready();
  assert.equal((await b.req("login", { uuid: "r1", exclusive: true, sessionToken: "T2" })).ok, true);
  probe.close(); b.close(); hub.stop();
});

test("비독점 login은 검사하지 않지만 online에 포함되고, 그 계정의 독점 login은 거부된다", async () => {
  const { hub, port } = await startHub();
  const legacy1 = new Client(port); await legacy1.ready();
  const legacy2 = new Client(port); await legacy2.ready();
  assert.equal((await legacy1.req("login", { uuid: "shared", name: "S" })).ok, true);
  assert.equal((await legacy2.req("login", { uuid: "shared" })).ok, true); // 기존 동작: 공유 허용
  const role = new Client(port); await role.ready();
  assert.equal((await role.req("login", { uuid: "shared", exclusive: true, sessionToken: "T" })).ok, false);
  legacy1.close(); legacy2.close(); role.close(); hub.stop();
});

test("exclusive 거부 시 기존 로그인은 유지되고, 다른 계정으로 login하면 이전 계정은 비워진다", async () => {
  const { hub, port } = await startHub();
  const holder = new Client(port); await holder.ready();
  await holder.req("login", { uuid: "plan", exclusive: true, sessionToken: "H" });
  const s = new Client(port); await s.ready();
  await s.req("login", { uuid: "impl", name: "구현", exclusive: true, sessionToken: "S" });
  assert.equal((await s.req("login", { uuid: "plan", exclusive: true, sessionToken: "S" })).ok, false);
  assert.equal((await s.req("whoami")).uuid, "impl"); // 실패해도 기존 역할 유지
  await s.req("login", { uuid: "other", exclusive: true, sessionToken: "S" }); // 전환
  const st = await s.req("account_status", { uuids: ["impl", "other"] });
  assert.deepEqual(st.statuses!.map((x) => x.online), [false, true]);
  holder.close(); s.close(); hub.stop();
});

test("set_profile은 설명을 저장(재시작 후에도)하고 500자 초과·비문자열을 거부한다", async () => {
  const dataDir = tmp();
  const { hub, port } = await startHub(dataDir);
  const a = new Client(port); await a.ready(); await a.req("login", { uuid: "u1", name: "기획" });
  assert.equal((await a.req("set_profile", { description: "게임 기획 담당" })).description, "게임 기획 담당");
  assert.equal((await a.req("set_profile", { description: "x".repeat(501) })).ok, false);
  assert.equal((await a.req("set_profile", { description: 3 })).ok, false);
  assert.equal((await a.req("whoami")).description, "게임 기획 담당");
  a.close(); hub.stop();
  const again = await startHub(dataDir);
  const c = new Client(again.port); await c.ready();
  const st = await c.req("account_status", { uuids: ["u1"] });
  assert.equal(st.statuses![0].description, "게임 기획 담당");
  c.close(); again.hub.stop();
});

test("account_status는 로그인 없이 존재·이름·설명·online을 주고 잘못된 입력을 거부한다", async () => {
  const { hub, port } = await startHub();
  const a = new Client(port); await a.ready(); await a.req("login", { uuid: "u1", name: "A" });
  const anon = new Client(port); await anon.ready(); // 로그인 안 함
  const r = await anon.req("account_status", { uuids: ["u1", "nope"] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.statuses, [
    { uuid: "u1", exists: true, name: "A", description: "", online: true },
    { uuid: "nope", exists: false, name: "", description: "", online: false },
  ]);
  assert.equal((await anon.req("account_status", { uuids: "u1" })).ok, false);
  assert.equal((await anon.req("account_status", { uuids: [1] })).ok, false);
  assert.equal((await anon.req("account_status", { uuids: Array.from({ length: 101 }, (_, i) => `u${i}`) })).ok, false);
  a.close(); anon.close(); hub.stop();
});

test("list_accounts는 로그인 없이 description·online을 준다", async () => {
  const { hub, port } = await startHub();
  const a = new Client(port); await a.ready(); await a.req("login", { uuid: "u1", name: "A" });
  await a.req("set_profile", { description: "설명A" });
  const anon = new Client(port); await anon.ready();
  const r = await anon.req("list_accounts");
  assert.equal(r.ok, true);
  assert.deepEqual(r.accounts, [{ uuid: "u1", name: "A", description: "설명A", online: true }]);
  a.close(); anon.close(); hub.stop();
});

test("list_dms는 상대 설명·접속 여부를, admin_snapshot은 계정 설명·접속 여부를 준다", async () => {
  const { hub, port, dataDir } = await startHub();
  const token = fs.readFileSync(path.join(dataDir, "admin.key"), "utf8").trim();
  const a = new Client(port); await a.ready(); await a.req("login", { uuid: "u1", name: "A" });
  const b = new Client(port); await b.ready(); await b.req("login", { uuid: "u2", name: "B" });
  await b.req("set_profile", { description: "구현 담당" });
  await a.req("open_dm", { peer: "u2" });
  const dms = (await a.req("list_dms")).dms!;
  assert.equal(dms[0].peerDescription, "구현 담당");
  assert.equal(dms[0].peerOnline, true);
  const snap = await a.req("admin_snapshot", { token });
  assert.deepEqual(snap.snapshotAccounts!.find((x) => x.uuid === "u2"), { uuid: "u2", name: "B", description: "구현 담당", online: true });
  a.close(); b.close(); hub.stop();
});

test("wait 중 다른 계정으로 login하면 이전 대기는 빈 결과로 끝나고, 이전 계정의 메시지는 새 주인이 받는다", async () => {
  const { hub, port } = await startHub();
  const a = new Client(port); await a.ready();
  await a.req("login", { uuid: "plan", exclusive: true, sessionToken: "A" });
  const pendingWait = a.req("wait", { timeoutMs: 5000 }); // 응답을 기다리지 않고 대기 등록
  await new Promise((r) => setTimeout(r, 50));
  await a.req("login", { uuid: "impl", exclusive: true, sessionToken: "A" }); // 역할 전환
  const c = new Client(port); await c.ready();
  await c.req("login", { uuid: "plan", exclusive: true, sessionToken: "C" }); // 다른 세션이 기획을 가져감
  const b = new Client(port); await b.ready(); await b.req("login", { uuid: "b", name: "B" });
  const dm = await b.req("open_dm", { peer: "plan" });
  await b.req("send", { channelId: dm.channelId, text: "기획에게만" });
  assert.deepEqual((await c.req("check")).items!.map((i) => i.text), ["기획에게만"]); // 새 주인이 받음
  assert.deepEqual((await pendingWait).items, []); // 전환 시 이전 대기는 빈 결과로 끝남(기획 DM이 새지 않음)
  assert.deepEqual((await a.req("check")).items, []); // 구현(A)에게 새지 않음
  a.close(); b.close(); c.close(); hub.stop();
});

test("create_server/create_channel은 대소문자·공백 무시 같은 이름을 거부하고 기존 ID를 알려준다", async () => {
  const { hub, port } = await startHub();
  const c = new Client(port); await c.ready(); await c.req("login", { uuid: "u1", name: "A" });
  const s1 = await c.req("create_server", { name: "Main" });
  const dup = await c.req("create_server", { name: " main " });
  assert.equal(dup.ok, false);
  assert.match(dup.error!, new RegExp(s1.serverId!));
  const ch1 = await c.req("create_channel", { serverId: s1.serverId, name: "일반" });
  const dupCh = await c.req("create_channel", { serverId: s1.serverId, name: "일반" });
  assert.equal(dupCh.ok, false);
  assert.match(dupCh.error!, new RegExp(ch1.channelId!));
  // 다른 서버에는 같은 채널 이름 허용
  const s2 = await c.req("create_server", { name: "Other" });
  assert.equal((await c.req("create_channel", { serverId: s2.serverId, name: "일반" })).ok, true);
  c.close(); hub.stop();
});

test("이름 상한: 서버·채널·계정 이름 65자는 거부, 저장은 trim", async () => {
  const { hub, port } = await startHub();
  const c = new Client(port); await c.ready();
  assert.equal((await c.req("login", { uuid: "u1", name: "a".repeat(65) })).ok, false);
  await c.req("login", { uuid: "u1", name: "A" });
  assert.equal((await c.req("set_name", { name: "b".repeat(65) })).ok, false);
  assert.equal((await c.req("set_name", { name: "  비  " })).name, "비");
  assert.equal((await c.req("create_server", { name: "s".repeat(65) })).ok, false);
  const srv = await c.req("create_server", { name: "  서버  " });
  assert.equal((await c.req("list_servers")).servers!.find((s) => s.serverId === srv.serverId)!.name, "서버");
  assert.equal((await c.req("create_channel", { serverId: srv.serverId, name: "c".repeat(65) })).ok, false);
  c.close(); hub.stop();
});

test("allowDevDelete가 꺼져 있으면 MCP 삭제 거부 문구가 관리 앱 설정을 안내", async () => {
  const { hub, port } = await startHub();
  const c = new Client(port); await c.ready();
  await c.req("login", { uuid: "u1", name: "A" });
  const srv = await c.req("create_server", { name: "S" });
  const r = await c.req("delete_server", { serverId: srv.serverId });
  assert.equal(r.ok, false);
  assert.match(r.error!, /관리 앱 설정/);
  c.close(); hub.stop();
});

test("Minor10: 보안 준비 전에는 데이터 폴더에 아무것도 만들거나 쓰지 않는다", async () => {
  const dataDir = tmp();
  const hub = new Hub({ tcpPort: 0, httpPort: 0, dataDir, idleShutdownMs: 0 });
  await hub.startTcp();
  try {
    assert.deepEqual(fs.readdirSync(dataDir), []);
    await hub.secure(TEST_SECURE_DEPS);
    assert.ok(fs.readdirSync(dataDir).includes("config.json")); // 준비 뒤에 데이터 적재
  } finally { hub.stop(); }
});

test("Minor11: 보안 준비 전 같은 연결의 hello 반복은 하나만 기다리고 나머지는 hello_pending", async () => {
  const dataDir = tmp();
  const hub = new Hub({ tcpPort: 0, httpPort: 0, dataDir, idleShutdownMs: 0 });
  await hub.startTcp();
  const c = new Client(hub.tcpAddress.port, dataDir); await c.connected();
  try {
    const first = c.req("hello");
    const second = await c.req("hello");
    const third = await c.req("hello");
    assert.equal(second.code, "hello_pending");
    assert.equal(third.code, "hello_pending");
    await hub.secure(TEST_SECURE_DEPS);
    assert.equal((await first).version, 3);
    assert.equal((await c.req("hello")).version, 3); // 준비 뒤에는 다시 받는다
  } finally { c.close(); hub.stop(); }
});

test("Minor9: 기존 계정 login은 이름 힌트가 길어도 무시하고 통과, 새 계정만 길이 검사", async () => {
  const { hub, port } = await startHub();
  const a = new Client(port); await a.ready();
  assert.equal((await a.req("login", { uuid: "u1", name: "A" })).ok, true);
  a.close();
  const b = new Client(port); await b.ready();
  const r = await b.req("login", { uuid: "u1", name: "x".repeat(65) });
  assert.equal(r.ok, true);
  assert.equal(r.name, "A");
  assert.equal((await b.req("login", { uuid: "u-new", name: "x".repeat(65) })).ok, false);
  b.close(); hub.stop();
});
