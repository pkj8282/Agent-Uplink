import { test } from "node:test";
import assert from "node:assert/strict";
import tls from "node:tls";
import { tempDir } from "../testing.js";
import { encodeFrame, FrameDecoder } from "../../shared/framing.js";
import { generateSigningKeys, newJoinToken, signB64, type SigningKeys } from "../../shared/connCrypto.js";
import { CONN_EKM_LABEL, joinSigData, authSigData } from "../../shared/connProtocol.js";
import { ConnectionStore } from "./store.js";
import { ConnListener, type ConnLimits, type ConnPeer } from "./listener.js";

interface Raw {
  sock: tls.TLSSocket;
  req(op: string, params?: object): Promise<any>;
  ekm(): string;
  closed: Promise<void>;
}

/** 통신 리스너에 실제 TLS로 붙는 시험 클라이언트(지문 고정은 client.ts의 몫 — 여기서는 프로토콜만 본다). */
async function rawConn(port: number): Promise<Raw> {
  const sock = tls.connect({ port, host: "127.0.0.1", rejectUnauthorized: false, minVersion: "TLSv1.3" });
  await new Promise<void>((res, rej) => { sock.once("secureConnect", () => res()); sock.once("error", rej); });
  const dec = new FrameDecoder();
  const pending = new Map<number, (r: any) => void>();
  let next = 1;
  sock.on("data", (c) => dec.push(c, (f) => { const p = pending.get(f.id); if (p) { pending.delete(f.id); p(f); } }));
  sock.on("error", () => {});
  const closed = new Promise<void>((r) => sock.once("close", () => r()));
  return {
    sock,
    closed,
    ekm: () => sock.exportKeyingMaterial(32, CONN_EKM_LABEL, Buffer.alloc(0)).toString("base64"),
    req: (op, params = {}) => new Promise((res) => {
      const id = next++;
      pending.set(id, res);
      closed.then(() => { if (pending.delete(id)) res({ ok: false, code: "closed" }); });
      sock.write(encodeFrame({ op, id, ...params }));
    }),
  };
}

async function setup(opts: { burn?: boolean; limits?: Partial<ConnLimits> } = {}) {
  const dataDir = tempDir("conn-listen-");
  const store = new ConnectionStore({ dataDir });
  store.setServerConfig({ enabled: true, port: 0, profile: "tls13-chacha20", spaceId: "sp1", spaceName: "팀", burnOnJoin: opts.burn ?? true, shared: [] });
  const token = newJoinToken();
  store.addInvite(token, "B", Date.now() + 60_000);
  const handled: string[] = [];
  const logs: string[] = [];
  const peers: ConnPeer[] = [];
  const listener = new ConnListener({
    store,
    limits: opts.limits,
    onPeer: (p) => peers.push(p),
    onPeerGone: () => {},
    handle: (_p, req, reply) => { handled.push(req.op); reply({ ok: true }); },
    log: (code) => logs.push(code),
  });
  const port = await listener.listen(0, "127.0.0.1");
  return { store, token, listener, port, handled, logs, peers };
}

async function join(c: Raw, token: string, keys: SigningKeys, userName = "비") {
  const h = await c.req("c_hello");
  const sig = signB64(keys.privateKeyPem, joinSigData(h.challenge, c.ekm(), token, keys.publicKeyB64));
  return { hello: h, res: await c.req("c_join", { token, hubKey: keys.publicKeyB64, userName, sig }), sig };
}

async function auth(c: Raw, memberId: string, keys: SigningKeys) {
  const h = await c.req("c_hello");
  return c.req("c_auth", { memberId, sig: signB64(keys.privateKeyPem, authSigData(h.challenge, c.ekm(), memberId)) });
}

test("join_then_auth_ok: 초대로 참여한 뒤 다른 연결에서 인증, 허용 op는 처리", async () => {
  const s = await setup();
  try {
    const k = generateSigningKeys();
    const c1 = await rawConn(s.port);
    const { hello, res } = await join(c1, s.token, k);
    assert.equal(hello.magic, "agent-uplink-conn");
    assert.equal(hello.version, 1);
    assert.equal(res.ok, true);
    assert.equal(res.spaceName, "팀");
    assert.equal(s.store.member(res.memberId)?.userName, "비");
    assert.equal((await c1.req("c_list")).ok, true);
    c1.sock.destroy();
    const c2 = await rawConn(s.port);
    assert.equal((await auth(c2, res.memberId, k)).ok, true);
    assert.equal((await c2.req("c_list")).ok, true);
    assert.deepEqual(s.handled, ["c_list", "c_list"]);
    assert.equal(s.peers.length, 2);
    c2.sock.destroy();
  } finally { await s.listener.close(); }
});

test("RT-C2_preauth_ops_refused: 인증 전 다른 op는 auth_required 후 끊김", async () => {
  const s = await setup();
  try {
    for (const op of ["c_list", "login", "admin_snapshot", "c_send"]) {
      const c = await rawConn(s.port);
      assert.equal((await c.req(op, { token: "x" })).code, "auth_required");
      await c.closed;
    }
    assert.deepEqual(s.handled, []);
  } finally { await s.listener.close(); }
});

test("RT-C3_join_sig_replay_other_session: 다른 TLS 세션에 옮긴 참여 서명은 무효", async () => {
  const s = await setup({ burn: false });
  try {
    const k = generateSigningKeys();
    const c1 = await rawConn(s.port);
    const h1 = await c1.req("c_hello");
    const sig = signB64(k.privateKeyPem, joinSigData(h1.challenge, c1.ekm(), s.token, k.publicKeyB64));
    // 공격자: 서명을 가로채 자기 연결로 다시 보냄(키는 없음)
    const c2 = await rawConn(s.port);
    await c2.req("c_hello");
    assert.equal((await c2.req("c_join", { token: s.token, hubKey: k.publicKeyB64, userName: "x", sig })).code, "join_failed");
    assert.deepEqual(s.store.members(), []);
    c1.sock.destroy(); c2.sock.destroy();
  } finally { await s.listener.close(); }
});

test("invite_bound_to_first_hub: 파기 꺼짐 — 처음 Hub만 재참여, 다른 Hub 키는 거부", async () => {
  const s = await setup({ burn: false });
  try {
    const k1 = generateSigningKeys();
    const k2 = generateSigningKeys();
    const a = await rawConn(s.port);
    const first = (await join(a, s.token, k1)).res;
    assert.equal(first.ok, true);
    const b = await rawConn(s.port);
    assert.equal((await join(b, s.token, k2)).res.code, "join_failed");
    const again = await rawConn(s.port);
    const second = (await join(again, s.token, k1)).res;
    assert.equal(second.ok, true);
    assert.equal(second.memberId, first.memberId);
    assert.equal(s.store.members().length, 1);
    for (const c of [a, b, again]) c.sock.destroy();
  } finally { await s.listener.close(); }
});

test("RT-C4_burned_token_reuse: 파기 켜짐 — 두 번째 사용은 같은 Hub라도 거부", async () => {
  const s = await setup({ burn: true });
  try {
    const k = generateSigningKeys();
    const a = await rawConn(s.port);
    assert.equal((await join(a, s.token, k)).res.ok, true);
    const b = await rawConn(s.port);
    assert.equal((await join(b, s.token, k)).res.code, "join_failed");
    a.sock.destroy(); b.sock.destroy();
  } finally { await s.listener.close(); }
});

test("RT-C5_local_ops_after_auth: 인증 뒤에도 로컬·관리 op는 처리하지 않음", async () => {
  const s = await setup();
  try {
    const c = await rawConn(s.port);
    assert.equal((await join(c, s.token, generateSigningKeys())).res.ok, true);
    for (const op of ["login", "admin_empty_trash", "send", "delete_server", "c_join", "c_auth"]) {
      assert.equal((await c.req(op, { token: "x" })).code, "op_not_allowed");
    }
    assert.deepEqual(s.handled, []);
    c.sock.destroy();
  } finally { await s.listener.close(); }
});

test("RT-C6_oversized_preauth_frame: 인증 전 큰 길이 선언은 즉시 끊김", async () => {
  const s = await setup();
  try {
    const c = await rawConn(s.port);
    const header = Buffer.alloc(4);
    header.writeUInt32LE(64 * 1024, 0);
    c.sock.write(header);
    const outcome = await Promise.race([c.closed.then(() => "closed"), new Promise((r) => setTimeout(() => r("open"), 2000))]);
    assert.equal(outcome, "closed");
    assert.ok(s.logs.includes("frame_too_large"));
  } finally { await s.listener.close(); }
});

test("RT-C7_rate_limit_per_ip: 1분에 11번째 참여 시도는 rate_limited", async () => {
  const s = await setup();
  try {
    const k = generateSigningKeys();
    const codes: string[] = [];
    for (let i = 0; i < 11; i++) {
      const c = await rawConn(s.port);
      codes.push((await join(c, "WRONG-TOKEN", k)).res.code);
      c.sock.destroy();
    }
    assert.deepEqual(codes.slice(0, 10), Array(10).fill("join_failed"));
    assert.equal(codes[10], "rate_limited");
    assert.ok(s.logs.includes("rate_limited"));
  } finally { await s.listener.close(); }
});

test("RT-C8_revoked_member_auth: 해지된 구성원은 연결이 끊기고 다시 인증할 수 없다", async () => {
  const s = await setup();
  try {
    const k = generateSigningKeys();
    const c = await rawConn(s.port);
    const { res } = await join(c, s.token, k);
    s.store.revoke(res.memberId);
    s.listener.disconnect(res.memberId);
    await c.closed;
    const c2 = await rawConn(s.port);
    assert.equal((await auth(c2, res.memberId, k)).code, "auth_failed");
    const c3 = await rawConn(s.port);
    assert.equal((await auth(c3, res.memberId, generateSigningKeys())).code, "auth_failed");
    c2.sock.destroy(); c3.sock.destroy();
  } finally { await s.listener.close(); }
});

test("preauth_timeout: 아무것도 보내지 않으면 제한 시간 뒤 끊김", async () => {
  const s = await setup({ limits: { preAuthTimeoutMs: 200 } });
  try {
    const c = await rawConn(s.port);
    const outcome = await Promise.race([c.closed.then(() => "closed"), new Promise((r) => setTimeout(() => r("open"), 2000))]);
    assert.equal(outcome, "closed");
  } finally { await s.listener.close(); }
});

test("join_bad_user_name: 빈 이름·긴 이름은 참여 거부(토큰은 소비하지 않음)", async () => {
  const s = await setup({ burn: true });
  try {
    const k = generateSigningKeys();
    const c = await rawConn(s.port);
    assert.equal((await join(c, s.token, k, "")).res.code, "join_failed");
    const c2 = await rawConn(s.port);
    assert.equal((await join(c2, s.token, k, "x".repeat(65))).res.code, "join_failed");
    const c3 = await rawConn(s.port);
    assert.equal((await join(c3, s.token, k, "비")).res.ok, true);
    for (const x of [c, c2, c3]) x.sock.destroy();
  } finally { await s.listener.close(); }
});

test("RT-C15_preauth_slots_per_ip: 한 IP가 인증 전 연결로 자리를 다 차지하지 못한다", async () => {
  const s = await setup({ limits: { maxPreAuthPerIp: 3 } });
  try {
    const held: Raw[] = [];
    for (let i = 0; i < 3; i++) held.push(await rawConn(s.port));
    const extra = await rawConn(s.port).catch(() => null);
    const outcome = extra ? await Promise.race([extra.closed.then(() => "closed"), new Promise((r) => setTimeout(() => r("open"), 1500))]) : "closed";
    assert.equal(outcome, "closed");
    assert.ok(s.logs.includes("preauth_per_ip"));
    // 인증을 마친 연결은 자리를 비운다 → 새 연결 가능
    assert.equal((await join(held[0], s.token, generateSigningKeys())).res.ok, true);
    const again = await rawConn(s.port);
    assert.equal((await again.req("c_hello")).ok, true);
    for (const c of [...held, again]) c.sock.destroy();
  } finally { await s.listener.close(); }
});
