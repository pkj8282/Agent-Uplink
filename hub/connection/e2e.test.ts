import { test } from "node:test";
import assert from "node:assert/strict";
import { startHubPair, startTestHub, TestClient } from "../testing.js";
import { MAX_TEXT_LENGTH } from "../../shared/protocol.js";
import { generateSigningKeys, newJoinToken } from "../../shared/connCrypto.js";
import { decodeInvite, encodeInvite } from "../../shared/invite.js";

async function login(port: number, uuid: string, area?: "connection"): Promise<TestClient> {
  const c = new TestClient(port);
  await c.ready();
  const r = await c.req("login", { uuid, ...(area ? { area } : {}) });
  if (!r.ok) throw new Error(`login ${uuid}: ${r.code}`);
  return c;
}

test("b_connection_session_talks_to_a_shared_channel: A·B 연결 계정이 공유 채널로 주고받고, 출처가 붙는다", async () => {
  const p = await startHubPair();
  try {
    const a = await login(p.A.port, "a-conn", "connection");
    const b = await login(p.B.port, "b-conn", "connection");
    const sent = await b.req("send", { channelId: p.remoteChannelId, text: "B에서 안녕" });
    assert.equal(sent.ok, true, sent.code);
    let got: any[] = [];
    for (let i = 0; i < 100 && got.length === 0; i++) { got = (await a.req("check")).items ?? []; if (!got.length) await new Promise((r) => setTimeout(r, 20)); }
    assert.equal(got[0].text, "B에서 안녕");
    assert.deepEqual(got[0].origin, { scope: "remote", spaceName: "팀", hubUser: "비" });
    // A → B
    assert.equal((await a.req("send", { channelId: p.channelId, text: "A에서 답" })).ok, true);
    let back: any[] = [];
    for (let i = 0; i < 100 && back.length === 0; i++) { back = (await b.req("check")).items ?? []; if (!back.length) await new Promise((r) => setTimeout(r, 20)); }
    assert.equal(back.length, 1, JSON.stringify(back)); // 자기 메시지 메아리는 받지 않음
    assert.equal(back[0].text, "A에서 답");
    assert.deepEqual(back[0].origin, { scope: "remote", spaceName: "팀", hubUser: "에이" });
    assert.equal(back[0].channelId, p.remoteChannelId);
    const hist = await b.req("read", { channelId: p.remoteChannelId });
    assert.deepEqual(hist.messages?.map((m) => m.text), ["B에서 안녕", "A에서 답"]);
    a.close(); b.close();
  } finally { p.A.hub.stop(); p.B.hub.stop(); }
});

test("unshare_stops_events_and_never_leaks_names: 공유 안 된 서버는 이름도 안 가고, 공유를 끄면 이벤트가 끊긴다", async () => {
  const p = await startHubPair();
  const wire: string[] = [];
  p.mA.setTapForTest((o) => wire.push(JSON.stringify(o)));
  try {
    const secret = p.mA.createCommsServer("비밀작업");
    const secretCh = p.mA.createCommsChannel(secret, "기밀채널");
    const a = await login(p.A.port, "a-conn", "connection");
    const b = await login(p.B.port, "b-conn", "connection");
    await a.req("send", { channelId: secretCh, text: "공유 안 된 내용" });
    p.mA.setShared([p.serverId]); // shared 이벤트 재전송 — 여전히 비밀작업 없음
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(wire.some((w) => w.includes("비밀작업") || w.includes(secret) || w.includes(secretCh) || w.includes("공유 안 된 내용")), false);
    // 공유 해제 → 그 채널 메시지 이벤트 없음, B 거울 채널 사라짐
    p.mA.setShared([]);
    await p.until(() => !p.B.hub.hasChannelForTest(p.remoteChannelId));
    const before = wire.length;
    await a.req("send", { channelId: p.channelId, text: "해제 뒤" });
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(wire.slice(before).some((w) => w.includes("해제 뒤")), false);
    assert.equal(((await b.req("check")).items ?? []).length, 0);
    a.close(); b.close();
  } finally { p.A.hub.stop(); p.B.hub.stop(); }
});

test("remote_text_guarded_both_ends: 숨은 문자는 A 입구와 B 입구에서 각각 감독", async () => {
  const p = await startHubPair();
  try {
    const a = await login(p.A.port, "a-conn", "connection");
    const b = await login(p.B.port, "b-conn", "connection");
    assert.equal((await b.req("send", { channelId: p.remoteChannelId, text: "숨은​글자" })).ok, true);
    let got: any[] = [];
    for (let i = 0; i < 100 && got.length === 0; i++) { got = (await a.req("check")).items ?? []; if (!got.length) await new Promise((r) => setTimeout(r, 20)); }
    assert.equal(got[0].text, "숨은\\u{200B}글자");
    // A가 감독을 건너뛴(위조된) 이벤트를 보내도 B가 다시 감독한다
    p.mA.broadcastForTest({ event: "msg", channelId: p.channelId, seq: 999, ts: Date.now(), from: "host:x", fromName: "위조​", text: "가짜⁣본문", origin: { scope: "remote", spaceName: "팀", hubUser: "에​이" } });
    let fake: any[] = [];
    for (let i = 0; i < 100 && fake.length === 0; i++) { fake = (await b.req("check")).items ?? []; if (!fake.length) await new Promise((r) => setTimeout(r, 20)); }
    const f = fake.find((x) => x.text.includes("가짜"));
    assert.ok(f, JSON.stringify(fake));
    assert.equal(f.text, "가짜\\u{2063}본문");
    assert.equal(f.fromName.includes("​"), false);
    assert.equal(f.origin.hubUser.includes("​"), false);
    a.close(); b.close();
  } finally { p.A.hub.stop(); p.B.hub.stop(); }
});

test("RT-C11_oversize_remote: 상한을 넘는 원격 본문은 거부·저장 0", async () => {
  const p = await startHubPair();
  try {
    const r = await p.mB.requestSpaceForTest(p.spaceId, { op: "c_send", channelId: p.channelId, from: { uuid: "x", name: "x" }, text: "a".repeat(MAX_TEXT_LENGTH + 1) });
    assert.equal(r.code, "text_too_long");
    const a = await login(p.A.port, "a-conn", "connection");
    assert.deepEqual((await a.req("read", { channelId: p.channelId })).messages, []);
    a.close();
  } finally { p.A.hub.stop(); p.B.hub.stop(); }
});

test("RT-C12_local_account_cannot_use_remote_channel: B의 로컬 계정은 원격 채널을 못 쓴다", async () => {
  const p = await startHubPair();
  try {
    const l = await login(p.B.port, "b-local");
    assert.equal((await l.req("send", { channelId: p.remoteChannelId, text: "x" })).code, "channel_forbidden");
    assert.equal((await l.req("read", { channelId: p.remoteChannelId })).code, "channel_forbidden");
    const al = await login(p.A.port, "a-local");
    assert.equal((await al.req("send", { channelId: p.channelId, text: "x" })).code, "channel_forbidden");
    l.close(); al.close();
  } finally { p.A.hub.stop(); p.B.hub.stop(); }
});

test("RT-C13_member_cannot_send_to_unshared_channel: 구성원은 공유 안 된 채널에 못 쓴다", async () => {
  const p = await startHubPair();
  try {
    const secret = p.mA.createCommsServer("비밀작업");
    const secretCh = p.mA.createCommsChannel(secret, "기밀채널");
    const r = await p.mB.requestSpaceForTest(p.spaceId, { op: "c_send", channelId: secretCh, from: { uuid: "x", name: "x" }, text: "침입" });
    assert.equal(r.code, "channel_forbidden");
    const rr = await p.mB.requestSpaceForTest(p.spaceId, { op: "c_read", channelId: secretCh });
    assert.equal(rr.code, "channel_forbidden");
    const ll = await p.mB.requestSpaceForTest(p.spaceId, { op: "c_send", channelId: "lobby", from: { uuid: "x", name: "x" }, text: "로비 침입" });
    assert.equal(ll.code, "channel_forbidden");
  } finally { p.A.hub.stop(); p.B.hub.stop(); }
});

test("restart_reconnects_without_dup: A Hub 재시작 뒤 B가 다시 붙고 메시지는 한 번씩만", async () => {
  const p = await startHubPair();
  let A2: Awaited<ReturnType<typeof startTestHub>> | null = null;
  try {
    const a = await login(p.A.port, "a-conn", "connection");
    const b = await login(p.B.port, "b-conn", "connection");
    await a.req("send", { channelId: p.channelId, text: "재시작 전" });
    let items: any[] = [];
    for (let i = 0; i < 100 && items.length === 0; i++) { items = (await b.req("check")).items ?? []; if (!items.length) await new Promise((r) => setTimeout(r, 20)); }
    assert.equal(items.length, 1);
    a.close();
    p.A.hub.stop();
    await p.until(() => !p.mB.hasLiveConnection());
    A2 = await startTestHub({ dataDir: p.A.dataDir, connBackoffMs: [50, 100] });
    await p.until(() => p.mB.hasLiveConnection(), 10_000);
    const a2 = await login(A2.port, "a-conn", "connection");
    await a2.req("send", { channelId: p.channelId, text: "재시작 뒤" });
    const all: any[] = [];
    for (let i = 0; i < 100; i++) {
      all.push(...((await b.req("check")).items ?? []));
      if (all.some((x) => x.text === "재시작 뒤")) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    await new Promise((r) => setTimeout(r, 200));
    all.push(...((await b.req("check")).items ?? []));
    assert.deepEqual(all.map((x) => x.text), ["재시작 뒤"]);
    const hist = await b.req("read", { channelId: p.remoteChannelId });
    assert.deepEqual(hist.messages?.map((m) => m.text), ["재시작 전", "재시작 뒤"]);
    a2.close(); b.close();
  } finally { A2?.hub.stop(); p.B.hub.stop(); }
});

test("remote_accounts_listed_for_connection_accounts: 연결 계정에게만 원격 계정이 보인다", async () => {
  const p = await startHubPair();
  try {
    const a = await login(p.A.port, "a-conn", "connection");
    await a.req("set_profile", { description: "A쪽 기획" });
    const b = await login(p.B.port, "b-conn", "connection");
    let remote: any;
    for (let i = 0; i < 150 && !remote; i++) {
      remote = (await b.req("list_accounts")).accounts?.find((x) => x.remote && x.name === "a-conn".slice(0, 8));
      if (!remote) await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(remote);
    assert.equal(remote.remote.hubUser, "에이");
    assert.equal(remote.remote.spaceName, "팀");
    const l = await login(p.B.port, "b-local");
    assert.equal((await l.req("list_accounts")).accounts?.some((x) => x.remote), false);
    // A 쪽에서도 B의 연결 계정이 보인다
    let fromB: any;
    for (let i = 0; i < 150 && !fromB; i++) {
      fromB = (await a.req("list_accounts")).accounts?.find((x) => x.remote?.hubUser === "비");
      if (!fromB) await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(fromB);
    a.close(); b.close(); l.close();
  } finally { p.A.hub.stop(); p.B.hub.stop(); }
});

test("servers_listed_for_connection_accounts: 연결 계정의 list_servers에 통신·원격 서버가 따로 표시", async () => {
  const p = await startHubPair();
  try {
    const b = await login(p.B.port, "b-conn", "connection");
    const s = await b.req("list_servers");
    const rem = s.servers?.find((x: any) => x.remote);
    assert.ok(rem, JSON.stringify(s.servers));
    assert.equal(rem.name, "팀작업");
    const ch = await b.req("list_channels", { serverId: rem.serverId });
    assert.deepEqual(ch.channels?.map((c) => c.channelId), [p.remoteChannelId]);
    const bl = await login(p.B.port, "b-local");
    assert.equal(((await bl.req("list_servers")).servers ?? []).some((x: any) => x.remote || x.area), false);
    b.close(); bl.close();
  } finally { p.A.hub.stop(); p.B.hub.stop(); }
});

test("RT-C16_member_send_rate_limit: 구성원 한 명이 메시지를 쏟아내면 rate_limited", async () => {
  const p = await startHubPair();
  try {
    const codes: string[] = [];
    for (let i = 0; i < 61; i++) {
      const r = await p.mB.requestSpaceForTest(p.spaceId, { op: "c_send", channelId: p.channelId, from: { uuid: "x", name: "x" }, text: `m${i}` });
      codes.push(r.ok ? "ok" : r.code);
    }
    assert.equal(codes.filter((c) => c === "ok").length, 60);
    assert.equal(codes[60], "rate_limited");
  } finally { p.A.hub.stop(); p.B.hub.stop(); }
});

test("connection_account_creates_comms_channel: A의 연결 계정 AI가 통신 서버에 채널을 만들고, 공유 중이면 B에게도 보인다", async () => {
  const p = await startHubPair();
  try {
    const a = await login(p.A.port, "a-conn", "connection");
    const r = await a.req("create_channel", { serverId: p.serverId, name: "설계" });
    assert.equal(r.ok, true, r.code);
    assert.equal((await a.req("create_channel", { serverId: p.serverId, name: "설계" })).code, "channel_name_taken");
    await p.until(() => p.B.hub.hasChannelForTest(`r:${p.spaceId}:${r.channelId}`));
    const l = await login(p.A.port, "a-local");
    assert.equal((await l.req("create_channel", { serverId: p.serverId, name: "로컬침입" })).code, "server_not_found");
    const b = await login(p.B.port, "b-conn", "connection");
    const remoteServer = `r:${p.spaceId}:${p.serverId}`;
    assert.equal((await b.req("create_channel", { serverId: remoteServer, name: "원격침입" })).code, "server_not_found");
    a.close(); l.close(); b.close();
  } finally { p.A.hub.stop(); p.B.hub.stop(); }
});

test("invite_member_name: 초대 코드에 A가 정한 참여자 이름이 들어가고, B 쪽 원격 표시도 그 이름", async () => {
  const p = await startHubPair();
  try {
    const st = p.mA.status();
    assert.equal(st.members[0].userName, "비");
    assert.throws(() => p.mA.createInvite("", "127.0.0.1", 60_000), /name_invalid/);
  } finally { p.A.hub.stop(); p.B.hub.stop(); }
});

test("c_read_reply_fits_frame: 긴 메시지가 많은 채널도 다시 채우기 응답이 참여자 쪽 상한(4MB) 안 — 끊김 반복 없음", async () => {
  const p = await startHubPair();
  try {
    const a = await login(p.A.port, "a-conn", "connection");
    const big = "가".repeat(60_000); // UTF-8 약 180KB
    for (let i = 0; i < 30; i++) assert.equal((await a.req("send", { channelId: p.channelId, text: `${i}:${big}` })).ok, true);
    const r = await p.mB.requestSpaceForTest(p.spaceId, { op: "c_read", channelId: p.channelId, limit: 500 });
    assert.equal(r.ok, true, r.code);
    assert.ok(r.messages.length > 0);
    assert.ok(Buffer.byteLength(JSON.stringify(r)) < 4 * 1024 * 1024);
    assert.equal(r.messages[r.messages.length - 1].text.startsWith("29:"), true); // 가장 최근 것은 들어 있다
    a.close();
  } finally { p.A.hub.stop(); p.B.hub.stop(); }
});


test("member_reads_over_budget_rate_limited: 읽기 요청을 쏟아내면 rate_limited, 다른 구성원은 정상", async () => {
  const p = await startHubPair();
  const C = await startTestHub({ connBackoffMs: [50, 100] });
  try {
    C.hub.conn.setUserName("씨");
    const { code } = p.mA.createInvite("씨", "127.0.0.1", 60_000);
    const j = await C.hub.conn.join(code);
    assert.equal(j.ok, true);
    await p.until(() => C.hub.conn.hasLiveConnection());
    let limited = 0;
    for (let i = 0; i < 125; i++) {
      const r = await p.mB.requestSpaceForTest(p.spaceId, i % 2 ? { op: "c_read", channelId: p.channelId, limit: 1 } : { op: "c_list" });
      if (!r.ok && r.code === "rate_limited") limited++;
    }
    assert.ok(limited >= 5, `limited=${limited}`);
    assert.equal((await p.mB.requestSpaceForTest(p.spaceId, { op: "c_accounts", accounts: [] })).code, "rate_limited");
    const other = await C.hub.conn.requestSpaceForTest(j.ok ? j.spaceId : "", { op: "c_list" });
    assert.equal(other.ok, true);
  } finally { p.A.hub.stop(); p.B.hub.stop(); C.hub.stop(); }
});

test("reconnect_sync_retries_when_rate_limited: 다시 채우다 속도 제한에 걸려도 기다렸다 이어서 빈 곳이 안 생긴다", async () => {
  const p = await startHubPair();
  try {
    const s2 = p.mA.createCommsServer("많은채널");
    const ids: string[] = [];
    for (let i = 0; i < 8; i++) ids.push(p.mA.createCommsChannel(s2, `c${i}`));
    const a = await login(p.A.port, "a-conn", "connection");
    for (const id of ids) assert.equal((await a.req("send", { channelId: id, text: `m-${id}` })).ok, true);
    p.mA.setShared([p.serverId, s2]);
    const remote = ids.map((id) => `r:${p.spaceId}:${id}`);
    await p.until(() => remote.every((r) => p.B.hub.hasChannelForTest(r)));
    p.mA.setReadLimitForTest(3, 300);
    p.mB.setRateRetryMsForTest(100);
    await p.mB.syncSpaceForTest(p.spaceId);
    const b = await login(p.B.port, "b-conn", "connection");
    for (const r of remote) assert.equal((await b.req("read", { channelId: r })).messages?.length, 1, r);
    a.close(); b.close();
  } finally { p.A.hub.stop(); p.B.hub.stop(); }
});


function forgedInvite(kind: "join" | "link", spaceId: string): string {
  const k = generateSigningKeys();
  return encodeInvite({
    v: 1, kind, spaceId, spaceName: "가짜", profile: "tls13-chacha20", endpoint: { type: "direct", host: "127.0.0.1", port: 1 },
    serverKey: k.publicKeyB64, token: newJoinToken(), expiresAt: Date.now() + 60_000, hostUser: "공격자", memberName: "피해자",
  }, k.privateKeyPem);
}

test("join_same_id_other_key_refused: 같은 공간 ID에 다른 서버 키인 초대는 거부, 기존 공간은 그대로", async () => {
  const p = await startHubPair();
  try {
    const before = JSON.stringify(p.mB.joinedForTest());
    const r = await p.mB.join(forgedInvite("join", p.spaceId));
    assert.deepEqual(r, { ok: false, code: "space_key_changed" });
    assert.equal(JSON.stringify(p.mB.joinedForTest()), before);
    assert.equal(p.mB.hasLiveConnection(), true);
  } finally { p.A.hub.stop(); p.B.hub.stop(); }
});

test("join_same_id_same_key_keeps_space: 같은 초대를 실수로 다시 붙여 넣어도 기존 공간은 그대로", async () => {
  const p = await startHubPair();
  try {
    const { code } = p.mA.createInvite("비", "127.0.0.1", 60_000);
    assert.equal((await p.mB.join(code)).ok, true);
    await p.until(() => p.mB.hasLiveConnection());
    const before = JSON.stringify(p.mB.joinedForTest());
    assert.deepEqual(await p.mB.join(code), { ok: true, spaceId: p.spaceId }); // 파기된 코드 — 실패로 놀라게 하지 않음
    assert.equal(JSON.stringify(p.mB.joinedForTest()), before);
    await p.until(() => p.mB.hasLiveConnection());
  } finally { p.A.hub.stop(); p.B.hub.stop(); }
});


test("join_reply_spacename_guarded: 서버가 보낸 공간 이름·초대의 이름에 든 숨은 문자·줄바꿈은 감독한다", async () => {
  const p = await startHubPair();
  const C = await startTestHub({ connBackoffMs: [50, 100] });
  try {
    C.hub.conn.setUserName("씨");
    const store = (p.mA as any).store;
    store.setServerConfig({ ...store.serverConfig(), spaceName: "팀\u200B\u{E0041}\n몰래" });
    const d = decodeInvite(p.mA.createInvite("씨", "127.0.0.1", 60_000).code, Date.now());
    assert.ok(d.ok);
    const code = encodeInvite({ ...d.invite, hostUser: "주인\u200B\n가짜" }, store.identity().privateKeyPem);
    assert.equal((await C.hub.conn.join(code)).ok, true);
    const j = C.hub.conn.status().joined[0];
    for (const v of [j.spaceName, j.hostUser]) assert.equal(/[\u200B\n]|\u{E0041}/u.test(v), false, JSON.stringify(v));
  } finally { p.A.hub.stop(); p.B.hub.stop(); C.hub.stop(); }
});
