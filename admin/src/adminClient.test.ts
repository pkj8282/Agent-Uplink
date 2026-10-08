import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { startTestHub, TestClient as Raw, tempDir } from "../../hub/testing.js";
import { hubProof } from "../../shared/auth.js";
import { encodeFrame, FrameDecoder } from "./framing.js";
import { AdminClient, HubNotRunningError, hubDownMessage, resolveAdminTarget, toResult } from "./adminClient.js";
import { hasHangul } from "../../hub/testing.js";

/** 데이터 폴더(언어 기본 ko — 기존 한국어 안내 단정을 유지한다). */
function tmp(language: "ko" | "en" = "ko"): string {
  const d = tempDir("uplink-admin-");
  fs.writeFileSync(path.join(d, "config.json"), JSON.stringify({ language }));
  return d;
}

async function startHub(dataDir?: string) {
  const t = await startTestHub({ dataDir, http: true });
  const client = new AdminClient({ port: t.port, keyPath: path.join(t.dataDir, "admin.key"), clientKeyPath: path.join(t.dataDir, "client.key"), timeoutMs: 2000 });
  return { ...t, client };
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
    clientKeyPath: path.join("C:\\PD", "AgentUplink", "client.key"),
    dataDir: path.join("C:\\PD", "AgentUplink"),
  });
  assert.deepEqual(resolveAdminTarget({ PROGRAMDATA: "C:\\PD", UPLINK_DATA_DIR: "D:\\data", UPLINK_TCP_PORT: "47900" }), {
    port: 47900,
    keyPath: path.join("D:\\data", "admin.key"),
    clientKeyPath: path.join("D:\\data", "client.key"),
    dataDir: "D:\\data",
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
  await assert.rejects(dead.snapshot(), (e: unknown) => e instanceof HubNotRunningError && (e as Error).message === hubDownMessage("ko"));
  assert.deepEqual(await toResult(() => dead.snapshot()), { ok: false, error: hubDownMessage("ko"), hubDown: true });

  const { hub, client } = await startHub();
  await client.snapshot(); // 정상
  hub.stop(); // 앱 사용 중 Hub 종료
  await assert.rejects(client.snapshot(), HubNotRunningError);
});

test("admin.key 없음/빈 파일/불일치는 크래시 없이 명확한 에러", async () => {
  const { hub, port, dataDir } = await startHub();
  const clientKeyPath = path.join(dataDir, "client.key"); // 인증은 통과시키고 admin.key 문제만 본다
  const missing = new AdminClient({ port, clientKeyPath, keyPath: path.join(tmp(), "admin.key"), timeoutMs: 2000 });
  await assert.rejects(missing.snapshot(), /admin\.key/);
  await assert.rejects(missing.snapshot(), /관리 기능이 있는 버전/);

  const emptyKey = path.join(tmp(), "admin.key");
  fs.writeFileSync(emptyKey, "  \n");
  await assert.rejects(new AdminClient({ port, clientKeyPath, keyPath: emptyKey, timeoutMs: 2000 }).snapshot(), /admin\.key/);

  const wrongKey = path.join(tmp(), "admin.key");
  fs.writeFileSync(wrongKey, "f".repeat(64));
  const r = await toResult(() => new AdminClient({ port, clientKeyPath, keyPath: wrongKey, timeoutMs: 2000 }).snapshot());
  assert.deepEqual(r, { ok: false, error: "admin 인증 실패", hubDown: false, code: "admin_auth_failed" });

  // 키 파일의 앞뒤 공백/개행은 무시한다
  const padded = path.join(tmp(), "admin.key");
  fs.writeFileSync(padded, `\n${fs.readFileSync(path.join(dataDir, "admin.key"), "utf8").trim()}\r\n`);
  assert.equal((await new AdminClient({ port, clientKeyPath, keyPath: padded, timeoutMs: 2000 }).snapshot()).servers.length, 0);
  hub.stop();
});

test("무응답 서버(포트 점유)는 무한 대기 없이 타임아웃 에러", async () => {
  const socks = new Set<net.Socket>();
  const silent = net.createServer((s) => { socks.add(s); }); // 받기만 하고 응답 안 함
  await new Promise<void>((r) => silent.listen(0, "127.0.0.1", () => r()));
  const port = (silent.address() as net.AddressInfo).port;
  const c = new AdminClient({ port, keyPath: path.join(tmp(), "admin.key"), timeoutMs: 300, helloTimeoutMs: 300 });
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
async function fakeServer(onFrame: (req: any, sock: net.Socket) => void, onConnect?: (sock: net.Socket) => void, seen?: Buffer[]) {
  const socks = new Set<net.Socket>();
  const srv = net.createServer((s) => {
    socks.add(s);
    s.on("error", () => { /* 무시 */ });
    if (onConnect) { onConnect(s); return; }
    const dec = new FrameDecoder();
    s.on("data", (d) => { seen?.push(d); dec.push(d, (req: any) => onFrame(req, s)); });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  return {
    port: (srv.address() as net.AddressInfo).port,
    close: () => { for (const s of socks) s.destroy(); srv.close(); },
  };
}

/** 가짜 Hub용 데이터 폴더: admin.key와 테스트 client.key를 같은 폴더에 둔다(clientKeyPath 기본값 = 같은 폴더). */
const FAKE_CLIENT_KEY = "c".repeat(64);
const FAKE_NONCE = "1".repeat(64);
function keyFile(): string {
  const d = tmp();
  fs.writeFileSync(path.join(d, "client.key"), FAKE_CLIENT_KEY);
  const p = path.join(d, "admin.key");
  fs.writeFileSync(p, "a".repeat(64));
  return p;
}

/** 같은 사용자의 Hub처럼 v3 hello·auth에 답한다(op 단계 동작을 시험하기 위해). 처리했으면 true. */
function answerHandshake(req: any, s: net.Socket): boolean {
  if (req.op === "hello") { s.write(encodeFrame({ ok: true, id: req.id, magic: "agent-uplink", version: 3, nonce: FAKE_NONCE })); return true; }
  if (req.op === "auth") { s.write(encodeFrame({ ok: true, id: req.id, proof: hubProof(FAKE_CLIENT_KEY, FAKE_NONCE, req.nonce) })); return true; }
  return false;
}

test("요청 도중 Hub가 끊기면 적용 여부 확인 안내", async () => {
  const f = await fakeServer((req, s) => {
    if (answerHandshake(req, s)) { /* hello·auth */ }
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

test("hello 단계 끊김 문구는 종료 중인 Hub 가능성과 새로고침을 안내한다", async () => {
  const f = await fakeServer(() => {}, (s) => s.destroy());
  const c = new AdminClient({ port: f.port, keyPath: keyFile(), timeoutMs: 2000 });
  await assert.rejects(c.snapshot(), /Hub가 종료 중이거나 Agent-Uplink Hub가 아닐 수 있습니다\. 잠시 후 새로고침하세요\./);
  f.close();
});

test("op 단계 응답 시간 초과는 '이미 처리됐을 수 있음·새로고침' 안내를 붙인다", async () => {
  const f = await fakeServer((req, s) => {
    if (answerHandshake(req, s)) { /* hello·auth */ }
    // op에는 응답하지 않는다
  });
  const c = new AdminClient({ port: f.port, keyPath: keyFile(), timeoutMs: 300 });
  await assert.rejects(c.deleteChannel("x"), /이미 처리됐을 수 있습니다.*새로고침/);
  f.close();
});

test("구버전 Hub(스냅샷에 trash 없음)면 snapshot.trash는 undefined", async () => {
  const f = await fakeServer((req, s) => {
    if (answerHandshake(req, s)) { /* hello·auth */ }
    else s.write(encodeFrame({ ok: true, id: req.id, config: { maxChannelsPerServer: 30, allowDevDelete: false, inboxMaxBatch: 200 }, snapshotServers: [], snapshotAccounts: [], snapshotDms: [] }));
  });
  const c = new AdminClient({ port: f.port, keyPath: keyFile(), timeoutMs: 1000 });
  assert.equal((await c.snapshot()).trash, undefined);
  f.close();
});

test("휴지통: snapshot에 trash가 오고, restoreTrash의 name_conflict는 code·conflicts로 전달된다", async () => {
  const { hub, port, client } = await startHub();
  const a = new Raw(port); await a.ready(); await a.req("login", { uuid: "u1", name: "A" });
  const srv = (await a.req("create_server", { name: "S" })).serverId;
  const ch = (await a.req("create_channel", { serverId: srv, name: "c" })).channelId!;
  await client.deleteChannel(ch);
  await a.req("create_channel", { serverId: srv, name: "c" });
  const snap = await client.snapshot();
  assert.equal(snap.trash!.length, 1);
  const r = await toResult(() => client.restoreTrash(snap.trash![0].id, false));
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.code, "name_conflict");
    assert.deepEqual(r.conflicts, [{ kind: "channel", name: "c", to: "c (2)" }]);
  }
  const ok = await client.restoreTrash(snap.trash![0].id, true);
  assert.deepEqual(ok.renamed, [{ kind: "channel", from: "c", to: "c (2)" }]);
  assert.deepEqual(await client.emptyTrash(), { removed: 0 });
  a.close(); hub.stop();
});

test("버전만 다른 Hub는 버전 불일치로 안내", async () => {
  const f = await fakeServer((req, s) => s.write(encodeFrame({ ok: true, id: req.id, magic: "agent-uplink", version: 4 })));
  const c = new AdminClient({ port: f.port, keyPath: keyFile(), timeoutMs: 2000 });
  await assert.rejects(c.snapshot(), /버전\(v4\)이 관리 도구\(v3\)와 맞지 않습니다/);
  f.close();
});

test("v2 Hub에는 재시작 안내", async () => {
  const f = await fakeServer((req, s) => s.write(encodeFrame({ ok: true, id: req.id, magic: "agent-uplink", version: 2 })));
  const c = new AdminClient({ port: f.port, keyPath: keyFile(), timeoutMs: 2000 });
  await assert.rejects(c.snapshot(), /구버전\(v2\.0\.1 이하\)/);
  f.close();
});

test("가짜 Hub(증명 위조)에는 admin 토큰을 보내지 않는다", async () => {
  const seen: Buffer[] = [];
  const f = await fakeServer((req, s) => s.write(encodeFrame(req.op === "hello"
    ? { ok: true, id: req.id, magic: "agent-uplink", version: 3, nonce: "d".repeat(64) }
    : { ok: true, id: req.id, proof: "e".repeat(64) })), undefined, seen);
  const keyPath = keyFile();
  fs.writeFileSync(keyPath, "secret-admin-token");
  const c = new AdminClient({ port: f.port, keyPath, timeoutMs: 2000 });
  await assert.rejects(c.snapshot(), /이 Windows 사용자의 Hub가 아닙니다/);
  assert.equal(Buffer.concat(seen).toString("utf8").includes("secret-admin-token"), false);
  f.close();
});

test("보안 준비 실패한 Hub의 사유를 그대로 보여준다", async () => {
  const f = await fakeServer((req, s) => s.write(encodeFrame({ ok: false, id: req.id, code: "secure_setup_failed", error: "다른 사용자가 만든 항목" })));
  const c = new AdminClient({ port: f.port, keyPath: keyFile(), timeoutMs: 2000 });
  await assert.rejects(c.snapshot(), /Hub를 시작할 수 없습니다: 다른 사용자가 만든 항목/);
  f.close();
});

test("viewerTicket은 열 수 있는 뷰어 URL을 준다", async () => {
  const { hub, client } = await startHub();
  try {
    const url = await client.viewerTicket();
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/#t=[0-9a-f]{64}$/);
  } finally { hub.stop(); }
});

test("구버전 Hub(admin op 없음)는 재배포 안내", async () => {
  const f = await fakeServer((req, s) => {
    if (answerHandshake(req, s)) { /* hello·auth */ }
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
  // 환경에 따라 시간 초과(대부분) 대신 즉시 실패(ENETUNREACH·RST)할 수 있다 — 핵심은 "멈추지 않음".
  const c = new AdminClient({ port: await closedPort(), host: "10.255.255.1", connectTimeoutMs: 300, keyPath: keyFile(), timeoutMs: 300 });
  const t0 = Date.now();
  await assert.rejects(c.snapshot(), /연결 시간이 초과|Hub 연결 실패|Hub가 실행 중이 아닙니다/);
  assert.ok(Date.now() - t0 < 1500, `${Date.now() - t0}ms`);
});

test("Minor4: v3 Hub가 답했는데 client.key가 없으면 '이 사용자의 Hub가 아님'", async () => {
  const f = await fakeServer((req, s) => { if (req.op === "hello") s.write(encodeFrame({ ok: true, id: req.id, magic: "agent-uplink", version: 3, nonce: FAKE_NONCE })); });
  const d = tmp(); fs.writeFileSync(path.join(d, "admin.key"), "a".repeat(64)); // client.key 없음
  const c = new AdminClient({ port: f.port, keyPath: path.join(d, "admin.key"), timeoutMs: 2000 });
  await assert.rejects(c.snapshot(), (e: Error) => /이 Windows 사용자의 Hub가 아닙니다/.test(e.message) && !/client\.key를 읽을 수 없습니다/.test(e.message));
  f.close();
});

test("Minor5: 인증 중 끊기면 끊김 안내(다른 사용자 문구 아님)", async () => {
  const f = await fakeServer((req, s) => {
    if (req.op === "hello") s.write(encodeFrame({ ok: true, id: req.id, magic: "agent-uplink", version: 3, nonce: FAKE_NONCE }));
    else s.destroy();
  });
  const c = new AdminClient({ port: f.port, keyPath: keyFile(), timeoutMs: 2000 });
  await assert.rejects(c.snapshot(), (e: Error) => /인증 중 Hub 연결이 끊기거나 응답이 없습니다/.test(e.message) && !/다른 사용자/.test(e.message));
  f.close();
});

test("Minor6: hello는 보안 준비 시간만큼 기다린다(op 응답 한도보다 길게)", async () => {
  const f = await fakeServer((req, s) => {
    if (req.op === "hello") setTimeout(() => answerHandshake(req, s), 800); // 보안 준비 중인 Hub
    else if (answerHandshake(req, s)) { /* auth */ }
    else s.write(encodeFrame({ ok: true, id: req.id, config: { maxChannelsPerServer: 30, allowDevDelete: false, inboxMaxBatch: 200 }, snapshotServers: [], snapshotAccounts: [], snapshotDms: [], trash: [] }));
  });
  const c = new AdminClient({ port: f.port, keyPath: keyFile(), timeoutMs: 300 });
  assert.deepEqual((await c.snapshot()).servers, []);
  f.close();
});

test("관리 앱 main 쪽 오류 문구는 데이터 폴더의 언어를 따른다(en)", async () => {
  const port = await closedPort();
  const dead = new AdminClient({ port, keyPath: path.join(tmp("en"), "admin.key"), timeoutMs: 2000 });
  await assert.rejects(dead.snapshot(), (e: unknown) => e instanceof HubNotRunningError && (e as Error).message === "The hub is not running. Open a session or start the hub.");
  const f = await fakeServer((req, s) => s.write(encodeFrame({ ok: true, id: req.id, magic: "agent-uplink", version: 2 })));
  const c = new AdminClient({ port: f.port, keyPath: path.join(tmp("en"), "admin.key"), timeoutMs: 2000 });
  await assert.rejects(c.snapshot(), (e: Error) => /old version/.test(e.message) && !hasHangul(e.message));
  f.close();
});

test("새 Hub의 unknown_op code(영어 문장)도 구버전 안내로 바뀐다", async () => {
  const f = await fakeServer((req, s) => {
    if (answerHandshake(req, s)) { /* hello·auth */ }
    else s.write(encodeFrame({ ok: false, id: req.id, code: "unknown_op", error: "Unknown op." }));
  });
  const c = new AdminClient({ port: f.port, keyPath: keyFile(), timeoutMs: 2000 });
  await assert.rejects(c.snapshot(), /구버전/);
  f.close();
});

test("setConfig로 언어를 저장하면 응답 config에 반영된다", async () => {
  const { hub, client } = await startHub();
  assert.equal((await client.setConfig({ language: "en" })).language, "en");
  assert.equal((await client.snapshot()).config.language, "en");
  hub.stop();
});

test("deleteDm: DM이 휴지통으로(kind dm), 같은 ID를 다시 지우면 dm_not_found", async () => {
  const { hub, port, client } = await startHub();
  const s = await seed(port);
  await client.deleteDm(s.dmId);
  const snap = await client.snapshot();
  assert.deepEqual(snap.dms, []);
  assert.equal(snap.trash!.filter((t) => t.kind === "dm").length, 1);
  const r = await toResult(() => client.deleteDm(s.dmId));
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, "dm_not_found");
  s.a.close(); s.b.close(); hub.stop();
});

test("구버전 Hub(admin_delete_dm 모름): deleteDm은 실패로 끝나고 예외로 죽지 않는다", async () => {
  const f = await fakeServer((req, s) => s.write(encodeFrame({ ok: false, id: req.id, code: "unknown_op", error: "unknown op: admin_delete_dm" })));
  const c = new AdminClient({ port: f.port, keyPath: keyFile(), timeoutMs: 2000 });
  const r = await toResult(() => c.deleteDm("x"));
  assert.equal(r.ok, false);
  f.close();
});
