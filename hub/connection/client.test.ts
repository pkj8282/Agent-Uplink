import { test } from "node:test";
import assert from "node:assert/strict";
import tls from "node:tls";
import { startConnServer } from "../testing.js";
import { generateSigningKeys } from "../../shared/connCrypto.js";
import { selfSignedCertPem } from "../../shared/x509.js";
import { decodeInvite, type InvitePayload } from "../../shared/invite.js";
import { ConnectionStore } from "./store.js";
import { ConnListener } from "./listener.js";
import { ConnClient, joinSpace } from "./client.js";

function inviteOf(code: string): InvitePayload {
  const r = decodeInvite(code, Date.now());
  if (!r.ok) throw new Error(r.code);
  return r.invite;
}

const until = async (cond: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 20));
  }
};

test("join_and_auth_against_real_listener: 초대로 참여 → 클라이언트가 인증하고 요청을 보낸다", async () => {
  const s = await startConnServer();
  const keys = generateSigningKeys();
  const r = await joinSpace(inviteOf(s.invite("비")), keys, "비");
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.space.spaceName, "시험공간");
  assert.equal(r.space.hostUser, "에이");
  assert.equal(s.store.member(r.space.memberId)?.userName, "비");
  const states: string[] = [];
  const c = new ConnClient({ space: r.space, keys, onEvent: () => {}, onState: (st) => states.push(st) });
  c.start();
  await until(() => c.connected);
  assert.equal((await c.request({ op: "c_list" })).echo, "c_list");
  c.stop();
  await s.listener.close();
  assert.deepEqual(states.slice(0, 1), ["connected"]);
});

test("RT-C9_server_impersonation_pin: 다른 키의 서버에는 한 바이트도 보내지 않는다", async () => {
  const s = await startConnServer();
  const impostorKeys = generateSigningKeys();
  let received = 0;
  const impostor = tls.createServer({ key: impostorKeys.privateKeyPem, cert: selfSignedCertPem(impostorKeys, "agent-uplink", Date.now()), minVersion: "TLSv1.3" }, (sock) => {
    sock.on("data", (d) => { received += d.length; });
    sock.on("error", () => {});
  });
  const port = await new Promise<number>((r) => impostor.listen(0, "127.0.0.1", () => r((impostor.address() as { port: number }).port)));
  const inv = inviteOf(s.invite());
  const r = await joinSpace({ ...inv, endpoint: { type: "direct", host: "127.0.0.1", port } }, generateSigningKeys(), "비");
  assert.deepEqual(r, { ok: false, code: "pin_mismatch" });
  await new Promise((res) => setTimeout(res, 100));
  assert.equal(received, 0);
  impostor.close();
  await s.listener.close();
});

test("RT-C10_cipher_mismatch: 프로필과 다른 암호만 하는 서버에는 붙지 않는다", async () => {
  const s = await startConnServer({ profile: "tls13-chacha20" });
  const keys = generateSigningKeys();
  const r = await joinSpace(inviteOf(s.invite()), keys, "비");
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const states: string[] = [];
  const errors: string[] = [];
  const c = new ConnClient({ space: { ...r.space, profile: "tls13-aes256gcm" }, keys, onEvent: () => {}, onState: (st) => states.push(st), onError: (e) => errors.push(e), backoffMs: [30] });
  c.start();
  await until(() => errors.length >= 1);
  c.stop();
  assert.equal(c.connected, false);
  assert.equal(states.includes("connected"), false);
  assert.ok(errors.every((e) => e === "tls_failed" || e === "cipher_mismatch"), errors.join(","));
  await s.listener.close();
});

test("relay_endpoint_refused: 중계 연결 지점은 v3.0에서 거절(형식만 지원)", async () => {
  const s = await startConnServer();
  const inv = inviteOf(s.invite());
  const r = await joinSpace({ ...inv, endpoint: { type: "relay", relay: "relay.example", serverId: "x" } }, generateSigningKeys(), "비");
  assert.deepEqual(r, { ok: false, code: "relay_unsupported" });
  await s.listener.close();
});

test("unreachable_and_bad_token: 꺼진 포트는 unreachable, 틀린 토큰은 join_failed", async () => {
  const s = await startConnServer();
  const inv = inviteOf(s.invite());
  assert.equal((await joinSpace({ ...inv, token: "AAAA-AAAA" }, generateSigningKeys(), "비")).ok, false);
  await s.listener.close();
  const r = await joinSpace(inv, generateSigningKeys(), "비");
  assert.deepEqual(r, { ok: false, code: "unreachable" });
});

test("reconnects_after_listener_restart: 서버가 다시 뜨면 자동 재접속", async () => {
  const s = await startConnServer({ burn: false });
  const keys = generateSigningKeys();
  const r = await joinSpace(inviteOf(s.invite()), keys, "비");
  assert.ok(r.ok);
  if (!r.ok) return;
  const states: string[] = [];
  const c = new ConnClient({ space: r.space, keys, onEvent: () => {}, onState: (st) => states.push(st), backoffMs: [50, 50] });
  c.start();
  await until(() => c.connected);
  await s.listener.close();
  await until(() => !c.connected);
  assert.deepEqual((await c.request({ op: "c_list" })).code, "connection_lost");
  const again = new ConnListener({ store: new ConnectionStore({ dataDir: s.dataDir }), onPeer: () => {}, onPeerGone: () => {}, handle: (_p, _q, reply) => reply({ ok: true }), log: () => {} });
  await again.listen(s.port, "127.0.0.1");
  await until(() => c.connected);
  assert.deepEqual(states, ["connected", "disconnected", "connected"]);
  c.stop();
  await again.close();
});

test("events_reach_client: 서버가 보낸 이벤트는 onEvent로", async () => {
  const s = await startConnServer();
  const keys = generateSigningKeys();
  const r = await joinSpace(inviteOf(s.invite()), keys, "비");
  assert.ok(r.ok);
  if (!r.ok) return;
  const events: unknown[] = [];
  const c = new ConnClient({ space: r.space, keys, onEvent: (e) => events.push(e), onState: () => {} });
  c.start();
  await until(() => c.connected && s.peers.length > 0);
  s.peers[s.peers.length - 1].send({ event: "shared", servers: [] });
  await until(() => events.length === 1);
  assert.deepEqual(events[0], { event: "shared", servers: [] });
  c.stop();
  await s.listener.close();
});
