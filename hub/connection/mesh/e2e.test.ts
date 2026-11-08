// 방식 3 e2e: 실제 Hub(TLS) A·C·D를 A-C, C-D로 잇고, A의 구성원 B가 A를 거쳐 D 채널을 읽고 쓴다. 재시작 뒤에도 이어진다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { freePort, startTestHub, TestClient } from "../../testing.js";
import { generateSigningKeys, newJoinToken } from "../../../shared/connCrypto.js";
import { decodeInvite, encodeInvite } from "../../../shared/invite.js";

async function login(port: number, uuid: string): Promise<TestClient> {
  const c = new TestClient(port);
  await c.ready();
  const r = await c.req("login", { uuid, area: "connection" });
  if (!r.ok) throw new Error(`login ${uuid}: ${r.code}`);
  return c;
}

async function until(cond: () => boolean | Promise<boolean>, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error("until: timeout");
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function server(name: string, user: string, dataDir?: string, port?: number) {
  const h = await startTestHub({ connBackoffMs: [50, 100], ...(dataDir ? { dataDir } : {}) });
  const m = h.hub.conn;
  const p = port ?? await freePort();
  if (!dataDir) {
    m.setUserName(user);
    await m.enableServer({ port: p, bindHost: "127.0.0.1", profile: "tls13-chacha20", spaceName: name, burnOnJoin: true });
  }
  return { ...h, m, connPort: p };
}

/** 망에서 소개받은 서버를 주인이 승인한 것으로(인정 절차를 시험하지 않는 시험용). */
function acceptAll(hubs: { m: { status(): any; meshAcceptServer(o: string): boolean } }[]): void {
  for (const h of hubs) for (const c of h.m.status().mesh.candidates) h.m.meshAcceptServer(c.origin);
}

async function texts(c: TestClient, channelId: string): Promise<string[]> {
  const r = await c.req("read", { channelId });
  return (r.messages ?? []).map((x: { text: string }) => x.text);
}

test("mesh_e2e_three_hubs: A-C-D 망 + A 구성원 B가 A 거쳐 D 채널 읽고 쓰기, C 재시작 뒤 이어짐", async () => {
  const A = await server("에이 서버", "에이");
  let C = await server("씨 서버", "씨");
  const D = await server("디 서버", "디");
  const B = await startTestHub({ connBackoffMs: [50, 100] });
  const hubs = [A, D, B];
  try {
    // 각 서버의 통신 채널 + 망 공유
    const aSrv = A.m.createCommsServer("에이작업"); A.m.createCommsChannel(aSrv, "에이방");
    const dSrv = D.m.createCommsServer("디작업"); const dch = D.m.createCommsChannel(dSrv, "디방");
    A.m.meshSetShared([aSrv]); D.m.meshSetShared([dSrv]);
    // 서버 연결: A→C 인증서, C→D 인증서
    const ac = A.m.meshInvite("씨 서버", "127.0.0.1", 60_000);
    assert.equal(ac.ipWarning, true);
    assert.deepEqual(await C.m.meshJoin(ac.code), { ok: true, spaceId: A.m.status().mesh!.self });
    const cd = C.m.meshInvite("디 서버", "127.0.0.1", 60_000);
    assert.equal((await D.m.meshJoin(cd.code)).ok, true);
    // 방식 2 구성원 B → A
    A.m.setShared([aSrv]);
    B.hub.conn.setUserName("비");
    const j = await B.hub.conn.join(A.m.createInvite("비", "127.0.0.1", 60_000).code);
    assert.ok(j.ok);
    const dSpace = D.m.status().mesh!.self;
    const viaA = `r:${j.ok ? j.spaceId : ""}:m.${dSpace}.${dch}`;
    await until(() => { acceptAll([A, D]); return B.hub.hasChannelForTest(viaA); });

    const b = await login(B.port, "b-ai");
    const d = await login(D.port, "d-ai");
    // B가 A를 거쳐(A→C→D) D 채널에 쓴다
    const sent = await b.req("send", { channelId: viaA, text: "B가 A 거쳐 디에게" });
    assert.equal(sent.ok, true, sent.code);
    await until(async () => (await texts(d, dch)).includes("B가 A 거쳐 디에게"));
    const onD = (await d.req("read", { channelId: dch })).messages!.find((x: { text: string }) => x.text === "B가 A 거쳐 디에게");
    assert.deepEqual(onD!.origin, { scope: "remote", spaceName: "에이 서버", hubUser: "비" });
    // D가 답 → B의 거울에 보임
    assert.equal((await d.req("send", { channelId: dch, text: "디의 답" })).ok, true);
    await until(async () => (await texts(b, viaA)).includes("디의 답"));
    // A의 연결 계정도 망 서버 목록에서 D를 보고 읽는다
    const a = await login(A.port, "a-ai");
    const servers = (await a.req("list_servers")).servers ?? [];
    assert.ok(servers.some((s: { serverId: string }) => s.serverId === `m.${dSpace}`), JSON.stringify(servers));
    assert.ok((await texts(a, `m.${dSpace}.${dch}`)).includes("디의 답"));
    // A 상태: 연결 1(C), 망 서버 2(C·D)
    const st = A.m.status().mesh!;
    assert.equal(st.links.length, 1);
    assert.equal(st.links[0].connected, true);
    assert.deepEqual(st.servers.map((s) => s.spaceName).sort(), ["디 서버", "씨 서버"]);

    // C 재시작 → 연결이 다시 붙고 대화가 이어진다
    C.hub.stop();
    await new Promise((r) => setTimeout(r, 100));
    C = await server("씨 서버", "씨", C.dataDir, C.connPort);
    await until(() => A.m.status().mesh!.links[0].connected && D.m.status().mesh!.links[0].connected);
    assert.equal((await d.req("send", { channelId: dch, text: "재시작 뒤" })).ok, true);
    await until(async () => (await texts(b, viaA)).includes("재시작 뒤"));
    for (const x of [a, b, d]) x.close();
  } finally {
    for (const h of [...hubs, C]) h.hub.stop();
  }
});

test("mesh_off_leaves_no_trace: 망을 안 쓰는 Hub는 connection/mesh를 만들지 않는다", async () => {
  const A = await server("에이 서버", "에이");
  try {
    const s = A.m.createCommsServer("작업"); A.m.createCommsChannel(s, "방");
    const a = await login(A.port, "a-ai");
    await a.req("send", { channelId: A.m.status().comms[0].channels[0].channelId, text: "평소" });
    const fs = await import("node:fs");
    const path = await import("node:path");
    assert.equal(fs.existsSync(path.join(A.dataDir, "connection", "mesh")), false);
    a.close();
  } finally { A.hub.stop(); }
});

test("mesh_remove_link_disconnects: 서버 연결을 끊으면 상대가 다시 붙지 못한다", async () => {
  const A = await server("에이 서버", "에이");
  const C = await server("씨 서버", "씨");
  try {
    const inv = A.m.meshInvite("씨 서버", "127.0.0.1", 60_000);
    assert.equal((await C.m.meshJoin(inv.code)).ok, true);
    await until(() => A.m.status().mesh!.links.some((l) => l.connected));
    const cSpace = C.m.status().mesh!.self;
    A.m.meshRemove(cSpace);
    await until(() => !C.m.status().mesh!.links[0].connected);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(C.m.status().mesh!.links[0].connected, false);
    assert.ok(A.m.status().events.some((e) => e.code === "link_auth_failed"));
  } finally { A.hub.stop(); C.hub.stop(); }
});


test("mesh_join_same_id_other_key_refused: 서버 연결도 같은 ID에 다른 키면 거부", async () => {
  const A = await server("에이 서버", "에이");
  const C = await server("씨 서버", "씨");
  try {
    const { code } = A.m.meshInvite("씨 서버", "127.0.0.1", 60_000);
    const d = decodeInvite(code, Date.now());
    assert.ok(d.ok);
    assert.equal((await C.m.meshJoin(code)).ok, true);
    const k = generateSigningKeys();
    const forged = encodeInvite({ ...d.invite, serverKey: k.publicKeyB64, endpoint: { type: "direct", host: "127.0.0.1", port: 1 }, token: newJoinToken() }, k.privateKeyPem);
    assert.deepEqual(await C.m.meshJoin(forged), { ok: false, code: "space_key_changed" });
  } finally { A.hub.stop(); C.hub.stop(); }
});


test("mesh_verify_code_over_real_tls: 실제 Hub A-C-D에서 D가 준 코드를 A가 답하면 D가 A를 자동 인정, 없으면 후보로", async () => {
  const A = await server("에이 서버", "에이");
  const C = await server("씨 서버", "씨");
  const D = await server("디 서버", "디");
  try {
    assert.equal(A.m.meshVerifyRegister(D.m.meshVerifyCreate("에이 서버")).ok, true);
    const link = async (x: typeof A, y: typeof A) => {
      const { code } = x.m.meshInvite(y === A ? "에이" : "상대", "127.0.0.1", 60_000);
      assert.equal((await y.m.meshJoin(code)).ok, true);
    };
    await link(C, A);
    await link(C, D);
    await until(() => D.m.status().mesh!.servers.some((s: { spaceName: string }) => s.spaceName === "에이 서버"));
    assert.equal(D.m.status().mesh!.verify.managed[0].boundName, "에이 서버");
    // 코드를 받지 않은 쪽(A가 D를 확인)은 후보로 남는다
    await until(() => A.m.status().mesh!.candidates.some((c: { spaceName: string }) => c.spaceName === "디 서버"));
    assert.equal(A.m.status().mesh!.servers.some((s: { spaceName: string }) => s.spaceName === "디 서버"), false);
  } finally { A.hub.stop(); C.hub.stop(); D.hub.stop(); }
});


test("mesh_remove_handles_in_and_out_records: 서로 초대한 서버를 끊으면 기록 둘 다 지워지고 다시 붙지 않는다", async () => {
  const A = await server("에이 서버", "에이");
  const C = await server("씨 서버", "씨");
  try {
    assert.equal((await C.m.meshJoin(A.m.meshInvite("씨 서버", "127.0.0.1", 60_000).code)).ok, true);
    assert.equal((await A.m.meshJoin(C.m.meshInvite("에이 서버", "127.0.0.1", 60_000).code)).ok, true);
    await until(() => A.m.status().mesh!.links.length === 2 && A.m.status().mesh!.links.every((l: { connected: boolean }) => l.connected));
    assert.equal(A.m.meshRemove(C.m.status().mesh!.self), true);
    assert.equal(A.m.status().mesh!.links.length, 0);
    await new Promise((r) => setTimeout(r, 600)); // 다이얼러가 남아 있으면 이 안에 다시 붙는다
    assert.equal((A.m as any).mesh.links.size, 0);
    assert.equal(C.m.status().mesh!.links.some((l: { connected: boolean }) => l.connected), false);
    assert.equal(A.m.status().mesh!.servers.some((s: { spaceName: string }) => s.spaceName === "씨 서버"), false);
  } finally { A.hub.stop(); C.hub.stop(); }
});

test("relay_echo_skipped_for_sender: 중계로 쓴 메시지가 돌아와도 보낸 계정에게는 다시 알리지 않는다", async () => {
  const A = await server("에이 서버", "에이");
  const D = await server("디 서버", "디");
  try {
    const dSrv = D.m.createCommsServer("디작업");
    const dch = D.m.createCommsChannel(dSrv, "디방");
    D.m.meshSetShared([dSrv]);
    assert.equal((await D.m.meshJoin(A.m.meshInvite("디 서버", "127.0.0.1", 60_000).code)).ok, true);
    const mirror = `m.${D.m.status().mesh!.self}.${dch}`;
    await until(() => A.hub.hasChannelForTest(mirror));
    const sender = await login(A.port, "a-sender");
    const other = await login(A.port, "a-other");
    assert.equal((await sender.req("send", { channelId: mirror, text: "중계 메시지" })).ok, true);
    await until(async () => (await texts(other, mirror)).includes("중계 메시지"));
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(((await sender.req("check")).items ?? []).map((i: { text: string }) => i.text), []);
    assert.deepEqual(((await other.req("check")).items ?? []).map((i: { text: string }) => i.text), ["중계 메시지"]);
    sender.close(); other.close();
  } finally { A.hub.stop(); D.hub.stop(); }
});

test("reenable_server_keeps_mesh_shared_and_excluded: 통신 서버를 다시 켜도 망 공유·공유 해제 기록이 남는다", async () => {
  const A = await server("에이 서버", "에이");
  try {
    const s = A.m.createCommsServer("작업");
    const ch = A.m.createCommsChannel(s, "방");
    A.m.meshSetShared([s]);
    (A.m as any).meshExclude(ch);
    await A.m.enableServer({ port: A.connPort, bindHost: "127.0.0.1", profile: "tls13-chacha20", spaceName: "에이 서버", burnOnJoin: true });
    assert.deepEqual(A.m.status().mesh!.shared, [s]);
    assert.deepEqual(A.m.status().mesh!.excluded, [ch]);
  } finally { A.hub.stop(); }
});
