import { test } from "node:test";
import assert from "node:assert/strict";
import { generateSigningKeys } from "../../../shared/connCrypto.js";
import { signMesh } from "../../../shared/meshRecord.js";
import { LinkChannel } from "./link.js";
import { connect, node, settle, until, type Node } from "./testkit.js";
import { registerKey } from "./testkit.js";

/** 악의 서버 M: D에 직접 붙어 프레임을 마음대로 보낸다. */
function intruder(target: Node) {
  const keys = generateSigningKeys();
  const [x, y] = LinkChannel.memoryPair();
  registerKey("spM", keys.publicKeyB64);
  target.mesh.attach({ spaceId: "spM", spaceName: "엠", serverKey: keys.publicKeyB64 }, y);
  x.setHandlers({ onRequest: (_r, reply) => reply({ ok: true, heads: [], records: [] }), onEvent: () => {} });
  return { keys, send: (e: object) => x.event(e as { event: string }) };
}

async function line() {
  const a = node("에이", "spA", { relayTimeoutMs: 300 }), c = node("씨", "spC"), d = node("디", "spD");
  const dch = d.addChannel("디 일반");
  const cutAC = connect(a, c), cutCD = connect(c, d);
  await until(() => a.mesh.servers().some((s) => s.spaceId === "spD" && s.channels.length === 1));
  await settle();
  return { a, c, d, dch, cutAC, cutCD };
}

const relayBody = (over: object = {}) => ({
  reqId: "req-1", entry: "spA", entryName: "에이", target: "spD", ch: "x", from: "u9", fromName: "가짜", hubUser: "가짜", text: "위조", ts: Date.now(), ...over,
});

test("relay_write_multi_hop: A가 C를 거쳐 D 채널에 쓰면 D에 저장되고 seq 응답, 기록이 망으로 퍼져 A 거울에도 보임", async () => {
  const { a, d, dch } = await line();
  const r = await a.mesh.relayWrite({ mirrorId: a.mesh.mirrorId("spD", dch), from: "b1", fromName: "비AI", hubUser: "비", text: "안녕 디" });
  assert.deepEqual(r, { ok: true, seq: 1 });
  const onD = d.channels.recent(dch, 10);
  assert.equal(onD.length, 1);
  assert.equal(onD[0].text, "안녕 디");
  assert.equal(onD[0].from, "spA/b1");
  assert.equal(onD[0].origin?.hubUser, "비");
  assert.equal(onD[0].origin?.spaceName, "에이");
  await until(() => a.mirror(d, dch).length === 1);
  assert.equal(a.mirror(d, dch)[0].text, "안녕 디");
});

test("relay_forged_rejected: 다른 키로 A 이름을 단 쓰기 요청은 거부", async () => {
  const { d, dch } = await line();
  const m = intruder(d);
  m.send({ event: "relay", q: signMesh("relay", relayBody({ ch: dch }), m.keys), ttl: 8 });
  await settle();
  assert.equal(d.channels.recent(dch, 10).length, 0);
  assert.ok(d.logs.includes("mesh_reject_relay_forged"));
});

test("relay_replay_ignored: 같은 쓰기 요청을 다시 보내도 한 번만 저장", async () => {
  const { a, d, dch } = await line();
  const m = intruder(d);
  const q = signMesh("relay", relayBody({ ch: dch, reqId: "req-replay", text: "한 번" }), a.keys);
  m.send({ event: "relay", q, ttl: 8 });
  await until(() => d.channels.recent(dch, 10).length === 1);
  m.send({ event: "relay", q, ttl: 8 });
  m.send({ event: "relay", q, ttl: 3 });
  await settle();
  assert.equal(d.channels.recent(dch, 10).length, 1);
});

test("relay_stale_rejected: 10분 넘게 지난 쓰기 요청은 거부(기억 밖 재전송 차단)", async () => {
  const { a, d, dch } = await line();
  const m = intruder(d);
  m.send({ event: "relay", q: signMesh("relay", relayBody({ ch: dch, reqId: "old", ts: Date.now() - 11 * 60_000 }), a.keys), ttl: 8 });
  await settle();
  assert.equal(d.channels.recent(dch, 10).length, 0);
});

test("relay_unshared_rejected: 망에 공유하지 않은 채널로 온 쓰기는 거부", async () => {
  const { a, d } = await line();
  const hidden = d.addChannel("비공개", false);
  const m = intruder(d);
  m.send({ event: "relay", q: signMesh("relay", relayBody({ ch: hidden, reqId: "req-h" }), a.keys), ttl: 8 });
  await settle();
  assert.equal(d.channels.recent(hidden, 10).length, 0);
  assert.ok(d.logs.includes("mesh_reject_relay_unshared"));
});

test("relay_timeout: 대상까지 길이 끊겼으면 relay_timeout", async () => {
  const { a, dch, cutCD } = await line();
  cutCD();
  await settle(20);
  assert.deepEqual(await a.mesh.relayWrite({ mirrorId: a.mesh.mirrorId("spD", dch), from: "b1", fromName: "비AI", hubUser: "비", text: "닿지 않음" }), { ok: false, code: "relay_timeout" });
});

test("relay_unknown_channel: 망 거울이 아닌 채널은 channel_not_found", async () => {
  const { a } = await line();
  assert.deepEqual(await a.mesh.relayWrite({ mirrorId: "m.spD.nope", from: "b1", fromName: "비AI", hubUser: "비", text: "x" }), { ok: false, code: "channel_not_found" });
});

test("relay_flood_limited: 이어진 서버 하나가 중계 쓰기를 쏟아부어도 대상 채널에는 10초에 60개까지만", async () => {
  const { d, dch } = await line();
  const m = intruder(d);
  m.send({ event: "cat", c: signMesh("cat", { origin: "spM", spaceName: "엠", ver: 1, channels: [] }, m.keys) });
  await settle();
  for (let i = 0; i < 150; i++) m.send({ event: "relay", q: signMesh("relay", relayBody({ entry: "spM", entryName: "엠", ch: dch, reqId: `flood-${i}`, text: `도배 ${i}` }), m.keys), ttl: 8 });
  await settle(300);
  const n = d.channels.recent(dch, 1000).length;
  assert.ok(n <= 60, `저장된 중계 쓰기 ${n}개`);
  assert.ok(d.logs.includes("mesh_drop_relay_rate"));
});


test("relay_replay_after_flood_from_other_entry_dropped: 다른 서버가 중복 제거 기억을 밀어내도 캡처한 중계를 다시 넣을 수 없다", async () => {
  let t = Date.now();
  const clock = { now: () => t };
  const a = node("에이", "spA", { ...clock, relayTimeoutMs: 2000 }), d = node("디", "spD", clock);
  const dch = d.addChannel("디 일반");
  const captured: any[] = [];
  connect(a, d, (from, o) => { if (from === "a" && o.event === "relay") captured.push(JSON.parse(JSON.stringify(o))); return true; });
  await until(() => a.mesh.servers().some((s) => s.spaceId === "spD" && s.channels.length === 1));
  const r = await a.mesh.relayWrite({ mirrorId: a.mesh.mirrorId("spD", dch), from: "u1", fromName: "n", hubUser: "h", text: "한 번만" });
  assert.equal(r.ok, true);
  const m = intruder(d);
  m.send({ event: "cat", c: signMesh("cat", { origin: "spM", spaceName: "엠", ver: 1, channels: [] }, m.keys) });
  await settle();
  for (let batch = 0; batch < 52; batch++) { // 초당 이벤트 예산 안에서 5001개 넘게
    for (let i = 0; i < 99; i++) m.send({ event: "relay", ttl: 1, q: signMesh("relay", { reqId: `flood-${batch}-${i}`, entry: "spM", entryName: "엠", target: "spZ", ch: "x", from: "a", fromName: "a", hubUser: "u", text: "t", ts: t }, m.keys) });
    await settle(5);
    t += 1100;
  }
  await settle(50);
  const before = d.channels.recent(dch, 100).length;
  m.send(captured[0]);
  await settle(50);
  assert.equal(d.channels.recent(dch, 100).length, before);
  assert.equal(before, 1);
});
