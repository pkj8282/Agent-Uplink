// 방식 3 레드팀(설계 5.1 "연결된 다른 통신 서버" 행, 5.4): 악의 서버 M이 D에 직접 붙어 프레임을 마음대로 보낸다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateSigningKeys } from "../../../shared/connCrypto.js";
import { signMesh, recordHash, type RecordBody } from "../../../shared/meshRecord.js";
import { LinkChannel } from "./link.js";
import { connect, node, settle, until, type Node } from "./testkit.js";

function intruder(target: Node) {
  const keys = generateSigningKeys();
  const [x, y] = LinkChannel.memoryPair();
  let closed = false;
  x.onClose(() => { closed = true; });
  x.setHandlers({ onRequest: (_r, reply) => reply({ ok: true, heads: [], records: [] }), onEvent: () => {} });
  target.mesh.attach({ spaceId: "spM", spaceName: "엠", serverKey: keys.publicKeyB64 }, y);
  const send = (e: object) => x.event(e as { event: string });
  const ch = "mch";
  send({ event: "cat", c: signMesh("cat", { origin: "spM", spaceName: "엠", ver: 1, channels: [{ id: ch, name: "엠 채널" }] }, keys) });
  const rec = (n: number, prev: string, over: Partial<RecordBody> = {}): { r: object; body: RecordBody } => {
    const body: RecordBody = { origin: "spM", ch, n, prev, seq: n, ts: Date.now(), from: "m1", fromName: "엠AI", hubUser: "엠", via: [], text: `엠 ${n}`, ...over };
    return { r: signMesh("rec", body, keys), body };
  };
  return { keys, send, ch, rec, closed: () => closed };
}

/** A-C-D 줄: D는 A를 C 너머로 안다. A→C 기록 이벤트를 붙잡아 둔다. */
async function world() {
  const a = node("에이", "spA"), c = node("씨", "spC"), d = node("디", "spD");
  const ach = a.addChannel("일반");
  const captured: any[] = [];
  connect(a, c, (from, obj) => { if (from === "a" && (obj.event === "rec" || obj.event === "cat")) captured.push(JSON.parse(JSON.stringify(obj))); return true; });
  connect(c, d);
  await until(() => d.mesh.servers().some((s) => s.spaceId === "spA"));
  a.say(ach, "진짜 1");
  await until(() => d.mirror(a, ach).length === 1);
  return { a, c, d, ach, captured };
}

const rejects = (n: Node, code: string) => n.logs.filter((l) => l === `mesh_reject_${code}`).length;

test("forged_record_rejected: M이 A 이름으로 자기 키 서명한 기록 → 거부, 거울 그대로", async () => {
  const { a, d, ach } = await world();
  const m = intruder(d);
  const body: RecordBody = { origin: "spA", ch: ach, n: 2, prev: "x", seq: 2, ts: Date.now(), from: "u1", fromName: "에이AI", hubUser: "에이님", via: [], text: "위조" };
  m.send({ event: "rec", r: signMesh("rec", body, m.keys) });
  await settle();
  assert.equal(rejects(d, "record_forged"), 1);
  assert.deepEqual(d.mirror(a, ach).map((x) => x.text), ["진짜 1"]);
});

test("tampered_record_rejected: A의 진짜 기록 내용을 바꿔 전달 → 서명 깨짐으로 거부", async () => {
  const { a, d, ach, captured } = await world();
  a.say(ach, "진짜 2");
  await until(() => captured.filter((e) => e.event === "rec").length === 2);
  const second = captured.filter((e) => e.event === "rec")[1];
  const m = intruder(d);
  m.send({ event: "rec", r: { ...second.r, body: { ...second.r.body, text: "바꿈" } } });
  await settle();
  assert.equal(rejects(d, "record_bad"), 1);
  await until(() => d.mirror(a, ach).length === 2);
  assert.deepEqual(d.mirror(a, ach).map((x) => x.text), ["진짜 1", "진짜 2"]);
});

test("seq_jump_does_not_block: 번호를 크게 건너뛴 기록은 빈칸으로 처리 — 거울이 막히지 않고 다음 진짜 기록을 받음(1단계 미룬 '큰 seq')", async () => {
  const { d } = await world();
  const m = intruder(d);
  const r1 = m.rec(1, "");
  m.send({ event: "rec", r: r1.r });
  m.send({ event: "rec", r: m.rec(1_000_000_000, "zzz").r });
  m.send({ event: "rec", r: m.rec(2, recordHash(r1.body)).r });
  await settle();
  const mirror = d.channels.recent(d.mesh.mirrorId("spM", m.ch), 10);
  assert.deepEqual(mirror.map((x) => x.seq), [1, 2]);
});

test("fork_strikes_disconnect: 같은 번호에 다른 내용(갈라짐)을 3번 → 거부하고 그 연결을 끊음", async () => {
  const { d } = await world();
  const m = intruder(d);
  m.send({ event: "rec", r: m.rec(1, "").r });
  for (const t of ["갈래1", "갈래2", "갈래3"]) m.send({ event: "rec", r: m.rec(1, "", { text: t }).r });
  await until(() => m.closed());
  assert.equal(rejects(d, "record_fork"), 3);
  assert.ok(d.logs.includes("mesh_link_dropped"));
  assert.deepEqual(d.channels.recent(d.mesh.mirrorId("spM", m.ch), 10).map((x) => x.text), ["엠 1"]);
});

test("catalog_key_conflict_rejected: 같은 공간 ID(A)를 다른 키로 주장한 목록 → 거부, A 목록 그대로", async () => {
  const { d, ach } = await world();
  const m = intruder(d);
  m.send({ event: "cat", c: signMesh("cat", { origin: "spA", spaceName: "가짜 에이", ver: 99, channels: [] }, m.keys) });
  await settle();
  assert.equal(rejects(d, "key_conflict"), 1);
  const a = d.mesh.servers().find((s) => s.spaceId === "spA");
  assert.equal(a?.spaceName, "에이");
  assert.deepEqual(a?.channels.map((c) => c.id), [ach]);
});

test("catalog_rollback_ignored: 예전 버전 목록을 다시 보내도 무시", async () => {
  const { a, d, ach, captured } = await world();
  const old = captured.find((e) => e.event === "cat" && e.c.body.origin === "spA");
  const ch2 = a.addChannel("새 채널");
  await until(() => d.mesh.servers().find((s) => s.spaceId === "spA")?.channels.length === 2);
  const m = intruder(d);
  m.send({ event: "cat", c: old.c });
  await settle();
  assert.deepEqual(d.mesh.servers().find((s) => s.spaceId === "spA")?.channels.map((c) => c.id).sort(), [ach, ch2].sort());
});

test("oversize_and_future_rejected: 미래 시각·너무 큰 글 기록 → 거부", async () => {
  const { d } = await world();
  const m = intruder(d);
  m.send({ event: "rec", r: m.rec(1, "", { ts: Date.now() + 10 * 60_000 }).r });
  m.send({ event: "rec", r: m.rec(1, "", { text: "x".repeat(300_000) }).r });
  await settle();
  assert.equal(rejects(d, "record_bad"), 2);
  assert.equal(d.channels.recent(d.mesh.mirrorId("spM", m.ch), 10).length, 0);
});

test("rate_flood_dropped: 한 연결에서 1초에 200개 넘는 기록은 버림", async () => {
  const { d } = await world();
  const m = intruder(d);
  let prev = "";
  for (let n = 1; n <= 260; n++) {
    const r = m.rec(n, prev);
    prev = recordHash(r.body);
    m.send({ event: "rec", r: r.r });
  }
  await settle(300);
  assert.ok(d.logs.includes("mesh_drop_rate"));
  assert.ok(d.channels.recent(d.mesh.mirrorId("spM", m.ch), 1000).length <= 200);
});

test("unknown_origin_dropped: 목록이 없는 출처의 기록은 받지 않음", async () => {
  const { d } = await world();
  const ghost = generateSigningKeys();
  const m = intruder(d);
  const body: RecordBody = { origin: "spGhost", ch: "g", n: 1, prev: "", seq: 1, ts: Date.now(), from: "g", fromName: "유령", hubUser: "유령", via: [], text: "누구?" };
  m.send({ event: "rec", r: signMesh("rec", body, ghost) });
  await settle();
  assert.ok(d.logs.includes("mesh_drop_unknown_origin"));
  assert.equal(d.channels.ids().some((id) => id.startsWith("m.spGhost.")), false);
});
