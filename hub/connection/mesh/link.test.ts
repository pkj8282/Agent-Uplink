import { test } from "node:test";
import assert from "node:assert/strict";
import tls from "node:tls";
import { tempDir } from "../../testing.js";
import { encodeFrame, FrameDecoder } from "../../../shared/framing.js";
import { generateSigningKeys, newJoinToken, signB64 } from "../../../shared/connCrypto.js";
import { CONN_EKM_LABEL, joinSigData } from "../../../shared/connProtocol.js";
import type { InvitePayload } from "../../../shared/invite.js";
import { ConnectionStore } from "../store.js";
import { ConnListener } from "../listener.js";
import { LinkChannel, LinkDialer, joinLink, type LinkSelf } from "./link.js";

async function setupA() {
  const dataDir = tempDir("mesh-link-");
  const store = new ConnectionStore({ dataDir });
  store.setServerConfig({ enabled: true, port: 0, profile: "tls13-chacha20", spaceId: "spA", spaceName: "에이 서버", burnOnJoin: true, shared: [] });
  const memberToken = newJoinToken();
  store.addInvite(memberToken, "비", Date.now() + 60_000);
  const logs: string[] = [];
  const links: { spaceId: string; ch: LinkChannel }[] = [];
  const handled: string[] = [];
  const listener = new ConnListener({
    store,
    onPeer: () => {},
    onPeerGone: () => {},
    handle: (_p, req, reply) => { handled.push(req.op); reply({ ok: true }); },
    onLink: (info, ch) => {
      ch.setHandlers({ onRequest: (req, reply) => { handled.push(`link:${req.op}`); reply({ ok: true, from: "A" }); }, onEvent: () => {} });
      links.push({ spaceId: info.spaceId, ch });
    },
    onLinkGone: () => {},
    log: (code) => logs.push(code),
  });
  const port = await listener.listen(0, "127.0.0.1");
  const keys = store.identity();
  const linkInvite = (token = newJoinToken(), serverKey = keys.publicKeyB64): { invite: InvitePayload; token: string } => {
    store.addLinkInvite(token, "씨 서버", Date.now() + 60_000);
    return {
      token,
      invite: {
        v: 1, kind: "link", spaceId: "spA", spaceName: "에이 서버", profile: "tls13-chacha20",
        endpoint: { type: "direct", host: "127.0.0.1", port }, serverKey, token, expiresAt: Date.now() + 60_000, hostUser: "에이", memberName: "씨 서버",
      },
    };
  };
  return { store, listener, port, logs, links, handled, linkInvite, memberToken };
}

const selfC = (): LinkSelf => ({ keys: generateSigningKeys(), spaceId: "spC", spaceName: "씨 서버" });

function up(d: { link: any; self: LinkSelf }): Promise<{ dialer: LinkDialer; ch: LinkChannel }> {
  return new Promise((resolve) => {
    const dialer = new LinkDialer({
      link: d.link, self: d.self, backoffMs: [50],
      onUp: (ch) => resolve({ dialer, ch }),
      onDown: () => {},
    });
    dialer.start();
  });
}

test("link_join_and_auth: 서버 연결 인증서로 잇고, 다시 붙을 때는 인증, 링크 op는 양쪽 다 요청 가능", async () => {
  const a = await setupA();
  try {
    const c = selfC();
    const { invite } = a.linkInvite();
    const j = await joinLink(invite, c);
    assert.equal(j.ok, true);
    if (!j.ok) return;
    assert.equal(j.link.spaceId, "spA");
    assert.equal(j.link.dir, "out");
    const inA = a.store.links().find((l) => l.spaceId === "spC");
    assert.equal(inA?.serverKey, c.keys.publicKeyB64);
    assert.equal(inA?.dir, "in");
    const { dialer, ch } = await up({ link: j.link, self: c });
    const r = await ch.request({ op: "l_heads" });
    assert.equal(r.ok, true);
    assert.equal(r.from, "A");
    // A 쪽에서도 C에게 요청
    let gotOnC = "";
    ch.setHandlers({ onRequest: (req, reply) => { gotOnC = req.op; reply({ ok: true }); }, onEvent: () => {} });
    const last = a.links[a.links.length - 1];
    assert.equal(last.spaceId, "spC");
    assert.equal((await last.ch.request({ op: "l_pull" })).ok, true);
    assert.equal(gotOnC, "l_pull");
    dialer.stop();
  } finally { await a.listener.close(); }
});

test("link_token_single_use: 같은 서버 연결 인증서는 한 번만", async () => {
  const a = await setupA();
  try {
    const { invite } = a.linkInvite();
    assert.equal((await joinLink(invite, selfC())).ok, true);
    const again = await joinLink(invite, selfC());
    assert.equal(again.ok, false);
    assert.ok(a.logs.includes("link_join_failed"));
  } finally { await a.listener.close(); }
});

test("link_wrong_sig_rejected: 서명이 다른 키면 거부", async () => {
  const a = await setupA();
  try {
    const { invite } = a.linkInvite();
    const c = selfC();
    const liar = { ...c, keys: { ...c.keys, privateKeyPem: generateSigningKeys().privateKeyPem } };
    assert.equal((await joinLink(invite, liar)).ok, false);
    assert.equal(a.store.links().length, 0);
  } finally { await a.listener.close(); }
});

test("link_removed_rejected: 끊어 둔(제거한) 서버는 인증 거부", async () => {
  const a = await setupA();
  try {
    const c = selfC();
    const j = await joinLink(a.linkInvite().invite, c);
    assert.ok(j.ok);
    if (!j.ok) return;
    a.store.removeLink("spC");
    const errors: string[] = [];
    const dialer = new LinkDialer({ link: j.link, self: c, backoffMs: [1000], onUp: () => errors.push("up"), onDown: () => {}, onError: (e) => errors.push(e) });
    dialer.start();
    for (let i = 0; i < 50 && errors.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    dialer.stop();
    assert.deepEqual(errors, ["link_auth_failed"]);
  } finally { await a.listener.close(); }
});

test("link_same_space_as_self_rejected: 내 공간 ID로 붙으려 하면 거부", async () => {
  const a = await setupA();
  try {
    const c = { ...selfC(), spaceId: "spA" };
    assert.equal((await joinLink(a.linkInvite().invite, c)).ok, false);
  } finally { await a.listener.close(); }
});

test("link_pin_mismatch: 인증서의 서버 키와 실제 서버 키가 다르면 보내기 전에 끊음", async () => {
  const a = await setupA();
  try {
    const other = generateSigningKeys();
    const { invite } = a.linkInvite(undefined, other.publicKeyB64);
    const r = await joinLink(invite, selfC());
    assert.deepEqual(r, { ok: false, code: "pin_mismatch" });
    assert.equal(a.logs.length, 0);
  } finally { await a.listener.close(); }
});

test("link_cannot_use_member_ops: 링크 연결로 c_* 요청은 op_not_allowed", async () => {
  const a = await setupA();
  try {
    const c = selfC();
    const j = await joinLink(a.linkInvite().invite, c);
    if (!j.ok) assert.fail("join");
    const { dialer, ch } = await up({ link: j.link, self: c });
    for (const op of ["c_list", "c_send", "admin_snapshot", "l_unknown"]) {
      assert.equal((await ch.request({ op })).code, "op_not_allowed");
    }
    assert.deepEqual(a.handled, []);
    dialer.stop();
  } finally { await a.listener.close(); }
});

test("member_cannot_use_link_ops: 구성원 연결로 l_* 요청은 op_not_allowed", async () => {
  const a = await setupA();
  try {
    const k = generateSigningKeys();
    const sock = tls.connect({ port: a.port, host: "127.0.0.1", rejectUnauthorized: false, minVersion: "TLSv1.3" });
    await new Promise<void>((res, rej) => { sock.once("secureConnect", () => res()); sock.once("error", rej); });
    const dec = new FrameDecoder();
    const pending = new Map<number, (r: any) => void>();
    let next = 1;
    sock.on("data", (d) => dec.push(d, (f: any) => { const p = pending.get(f.id); if (p) { pending.delete(f.id); p(f); } }));
    const req = (op: string, params: object = {}) => new Promise<any>((res) => { const id = next++; pending.set(id, res); sock.write(encodeFrame({ op, id, ...params })); });
    const h = await req("c_hello");
    const ekm = sock.exportKeyingMaterial(32, CONN_EKM_LABEL, Buffer.alloc(0)).toString("base64");
    const sig = signB64(k.privateKeyPem, joinSigData(h.challenge, ekm, a.memberToken, k.publicKeyB64));
    assert.equal((await req("c_join", { token: a.memberToken, hubKey: k.publicKeyB64, userName: "비", sig })).ok, true);
    for (const op of ["l_heads", "l_pull", "l_join", "l_auth"]) assert.equal((await req(op)).code, "op_not_allowed");
    sock.destroy();
  } finally { await a.listener.close(); }
});

test("link_channel_memory_pair: 메모리로 이은 두 채널이 요청·응답·이벤트를 주고받음(망 엔진 시험용)", async () => {
  const [x, y] = LinkChannel.memoryPair();
  y.setHandlers({ onRequest: (req, reply) => reply({ ok: true, echo: req.op }), onEvent: () => {} });
  const events: string[] = [];
  x.setHandlers({ onRequest: (_r, reply) => reply({ ok: false }), onEvent: (e) => events.push(e.event) });
  assert.equal((await x.request({ op: "l_heads" })).echo, "l_heads");
  y.event({ event: "rec" });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(events, ["rec"]);
  y.close();
  assert.equal((await x.request({ op: "l_heads" })).code, "connection_lost");
});
