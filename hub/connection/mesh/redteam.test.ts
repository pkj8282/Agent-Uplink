// 방식 3 레드팀(설계 5.1 "연결된 다른 통신 서버" 행, 5.4): 악의 서버 M이 D에 직접 붙어 프레임을 마음대로 보낸다.
import { test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { generateSigningKeys } from "../../../shared/connCrypto.js";
import { signMesh, recordHash, type RecordBody } from "../../../shared/meshRecord.js";
import { LinkChannel } from "./link.js";
import { connect, node, settle, until, type Node } from "./testkit.js";
import { registerKey } from "./testkit.js";

function intruder(target: Node) {
  const keys = generateSigningKeys();
  const [x, y] = LinkChannel.memoryPair();
  let closed = false;
  x.onClose(() => { closed = true; });
  x.setHandlers({ onRequest: (_r, reply) => reply({ ok: true, heads: [], records: [] }), onEvent: () => {} });
  registerKey("spM", keys.publicKeyB64);
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
async function world(dExtra: Parameters<typeof node>[2] = {}) {
  const a = node("에이", "spA"), c = node("씨", "spC"), d = node("디", "spD", dExtra);
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

test("fork_never_strikes: 같은 번호에 다른 내용이 와도 벌점·끊김 없이 먼저 받은 것을 유지하고 알린다", async () => {
  const { d } = await world();
  const m = intruder(d);
  m.send({ event: "rec", r: m.rec(1, "").r });
  for (const t of ["갈래1", "갈래2", "갈래3"]) m.send({ event: "rec", r: m.rec(1, "", { text: t }).r });
  await until(() => d.logs.includes("mesh_fork_detected"));
  await settle();
  assert.equal(m.closed(), false);
  assert.equal(rejects(d, "record_fork"), 0);
  assert.equal(d.logs.includes("mesh_link_dropped"), false);
  assert.deepEqual(d.channels.recent(d.mesh.mirrorId("spM", m.ch), 10).map((x) => x.text), ["엠 1"]);
  assert.equal(d.logs.filter((l) => l === "mesh_fork_detected").length, 1); // 사슬당 한 번
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
  const frozen = Date.now();
  const { d } = await world({ now: () => frozen }); // 시계 고정: 처리 속도와 무관하게 '같은 1초'
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

test("catalog_race_impersonation_blocked: 진짜 A 목록보다 먼저 온 가짜 'A' 목록(M 키)은 받지 않고, 나중에 온 진짜 A를 받으며 정상 이웃을 끊지 않음", async () => {
  const a = node("에이", "spA"), c = node("씨", "spC"), d = node("디", "spD");
  a.addChannel("일반");
  connect(a, c);
  await until(() => c.mesh.servers().some((s) => s.spaceId === "spA"));
  const m = intruder(d); // D는 아직 A를 모름
  for (let v = 1; v <= 3; v++) m.send({ event: "cat", c: signMesh("cat", { origin: "spA", spaceName: "가짜 에이", ver: 100 + v, channels: [] }, m.keys) });
  await settle();
  connect(c, d); // 이제 진짜 A 목록이 C를 거쳐 옴
  await until(() => d.mesh.servers().some((s) => s.spaceId === "spA" && s.spaceName === "에이"));
  assert.equal(d.mesh.keyOf("spA"), a.keys.publicKeyB64);
  assert.equal([...d.mesh.links].some((l) => l.info.spaceId === "spC"), true); // 정상 이웃 C 연결 유지
});


// ── 독립 리뷰 M6: 서명 밖 필드 ──

function dataContains(dir: string, needle: string): boolean {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory() ? dataContains(f, needle) : fs.readFileSync(f, "utf8").includes(needle)) return true;
  }
  return false;
}

/** 관찰자가 붙은 D + D에 직접 붙은 악의 서버 M. D가 관찰자에게 전달하는 프레임을 모은다. */
async function padWorld(opts: { gov?: boolean } = {}) {
  const d = node("디", "spD", {}, opts), obs = node("관찰", "spO");
  const out: any[] = [];
  connect(d, obs, (from, o) => { if (from === "a") out.push(JSON.parse(JSON.stringify(o))); return true; });
  const m = intruder(d);
  await until(() => d.mesh.servers().some((s) => s.spaceId === "spM"));
  return { d, m, out };
}

test("padded_record_stored_and_forwarded_without_padding: 서명 밖 필드는 저장·전달 때 사라진다", async () => {
  const { d, m, out } = await padWorld();
  const { r } = m.rec(1, "");
  m.send({ event: "rec", r: { ...r, pad: "PADPADPAD" } });
  await until(() => d.channels.recent(d.mesh.mirrorId("spM", m.ch), 10).length === 1);
  await until(() => out.some((o) => o.event === "rec"));
  assert.equal(out.find((o) => o.event === "rec").r.pad, undefined);
  assert.equal(dataContains(path.join(d.dataDir, "mesh"), "PADPADPAD"), false);
});

test("oversized_signed_body_refused: 서명자가 본문을 부풀린 기록은 벌점 없이 버린다", async () => {
  const { d, m } = await padWorld();
  const body = { origin: "spM", ch: m.ch, n: 1, prev: "", seq: 1, ts: Date.now(), from: "m1", fromName: "엠AI", hubUser: "엠", via: [], text: "t", blob: "x".repeat(1_500_000) };
  m.send({ event: "rec", r: signMesh("rec", body, m.keys) });
  await until(() => d.logs.includes("mesh_drop_oversized"));
  assert.equal(d.channels.recent(d.mesh.mirrorId("spM", m.ch), 10).length, 0);
  assert.equal(rejects(d, "record_bad"), 0);
  assert.equal(m.closed(), false);
});

test("padded_cat_relay_ack_coord_forwarded_clean: 목록·중계·확인·총괄 알림도 서명 밖 필드 없이 전달", async () => {
  const { d, m, out } = await padWorld({ gov: true });
  const pad = { pad: "PADPADPAD" };
  m.send({ event: "cat", c: { ...signMesh("cat", { origin: "spM", spaceName: "엠", ver: 2, channels: [{ id: m.ch, name: "엠 채널" }] }, m.keys), ...pad } });
  m.send({ event: "relay", ttl: 5, q: { ...signMesh("relay", { reqId: "r1", entry: "spM", entryName: "엠", target: "spZ", ch: "x", from: "a", fromName: "a", hubUser: "u", text: "t", ts: Date.now() }, m.keys), ...pad } });
  m.send({ event: "ack", a: { ...signMesh("ack", { reqId: "r2", entry: "spZ", target: "spM", ok: true, seq: 1 }, m.keys), ...pad } });
  m.send({ event: "coord", m: { ...signMesh("coord", { origin: "spM", ver: 1, on: true }, m.keys), ...pad } });
  await until(() => ["relay", "ack", "coord"].every((k) => out.some((o) => o.event === k)) && out.some((o) => o.event === "cat" && o.c.body.origin === "spM" && o.c.body.ver === 2));
  assert.equal(out.some((o) => JSON.stringify(o).includes("PADPADPAD")), false);
  assert.equal(dataContains(path.join(d.dataDir, "mesh"), "PADPADPAD"), false);
});


// ── 전달 태그·불일치 신호(사용자 설계) ──

/** 프레임을 모으는 악의 서버. 같은 키로 여러 서버에 붙을 수 있다. */
function controlled(id: string, keys = generateSigningKeys()) {
  registerKey(id, keys.publicKeyB64);
  const seen: any[] = [];
  const attach = (target: Node) => {
    const [x, y] = LinkChannel.memoryPair();
    x.setHandlers({ onRequest: (_r, reply) => reply({ ok: true, heads: [], records: [] }), onEvent: (e) => { seen.push(e); } });
    target.mesh.attach({ spaceId: id, spaceName: id, serverKey: keys.publicKeyB64 }, y);
    return (e: object) => x.event(e as { event: string });
  };
  const cat = () => ({ event: "cat", c: signMesh("cat", { origin: id, spaceName: id, ver: 1, channels: [{ id: "ch", name: "채널" }] }, keys) });
  const rec = (text: string, n = 1, prev = "") => signMesh("rec", { origin: id, ch: "ch", n, prev, seq: n, ts: Date.now(), from: "x", fromName: "x", hubUser: "x", via: [], text } as RecordBody, keys);
  return { id, keys, seen, attach, cat, rec };
}

test("tag_replaced_on_forward: 전달할 때 태그를 자기 것으로 바꿔 한 칸만 남는다", async () => {
  const a = node("에이", "spA"), c = node("씨", "spC"), d = node("디", "spD"), e = node("이", "spE");
  const ach = a.addChannel("일반");
  const tags: Record<string, any> = {};
  connect(a, c, (from, o) => { if (from === "a" && o.event === "rec") tags.ac = o; return true; });
  connect(c, d, (from, o) => { if (from === "a" && o.event === "rec") tags.cd = o; return true; });
  connect(d, e, (from, o) => { if (from === "a" && o.event === "rec") tags.de = o; return true; });
  await until(() => e.mesh.servers().some((s) => s.spaceId === "spA"));
  a.say(ach, "하나");
  await until(() => e.mirror(a, ach).length === 1);
  assert.deepEqual(tags.ac.tag, { from: "spA" });
  assert.deepEqual(tags.cd.tag, { from: "spA" });
  assert.deepEqual(tags.de.tag, { from: "spC" });
  assert.equal(tags.de.r.tag, undefined);
  assert.equal(JSON.stringify(tags.de).includes("spD"), false); // 지나온 전체 경로는 남지 않음
});

test("tag_format_bounded: 형식이 틀린 태그는 버리고 기록은 받는다", async () => {
  const d = node("디", "spD"), obs = node("관찰", "spO");
  const out: any[] = [];
  connect(d, obs, (from, o) => { if (from === "a" && o.event === "rec") out.push(o); return true; });
  const m = controlled("spM");
  const send = m.attach(d);
  send(m.cat());
  await until(() => d.mesh.servers().some((s) => s.spaceId === "spM"));
  send({ event: "rec", r: m.rec("a"), tag: { from: "x".repeat(999) } });
  await until(() => out.length === 1);
  assert.deepEqual(out[0].tag, { from: "spM" });
});

test("fork_report_requires_two_signed_versions: 서명이 없거나 같은 내용인 신호는 무시", async () => {
  const d = node("디", "spD");
  const m = controlled("spM");
  const send = m.attach(d);
  send(m.cat());
  await until(() => d.mesh.servers().some((s) => s.spaceId === "spM"));
  const r1 = m.rec("a");
  send({ event: "fork", a: r1, b: r1 });
  send({ event: "fork", a: r1, b: { ...r1, body: { ...r1.body, text: "서명 없음" } } });
  send({ event: "fork", a: r1, b: signMesh("rec", { ...r1.body, text: "다른 키" }, generateSigningKeys()) });
  await settle();
  assert.equal(d.logs.includes("mesh_fork_reported"), false);
  assert.equal(rejects(d, "record_fork"), 0);
});

test("fork_report_sent_to_tagged_neighbor_once: 발견하면 내게 준 이웃에게 증거와 함께 한 번만", async () => {
  const d = node("디", "spD");
  const m = controlled("spM"), other = controlled("spH");
  const send = m.attach(d), sendH = other.attach(d);
  send(m.cat());
  await until(() => d.mesh.servers().some((s) => s.spaceId === "spM"));
  const r1 = m.rec("내용1"), r2 = m.rec("내용2");
  send({ event: "rec", r: r1 });
  await until(() => d.channels.recent(d.mesh.mirrorId("spM", "ch"), 10).length === 1);
  sendH({ event: "rec", r: r2, tag: { from: "spK" } });
  sendH({ event: "rec", r: m.rec("내용3"), tag: { from: "spK" } });
  await until(() => m.seen.some((e) => e.event === "fork"));
  await settle();
  const reports = m.seen.filter((e) => e.event === "fork");
  assert.equal(reports.length, 1);
  assert.equal(reports[0].tagA, "spM");
  assert.equal(reports[0].tagB, "spK");
  assert.deepEqual([reports[0].a.body.text, reports[0].b.body.text], ["내용1", "내용2"]);
});

test("fork_report_walks_upstream: M → H1, K → H2처럼 전달자가 달라도 각자 자기 이웃에게 알리고 거슬러 올라간다", async () => {
  const mm = node("엠", "spMM"), k = node("케이", "spK"), h1 = node("에이치1", "spH1"), h2 = node("에이치2", "spH2");
  const o = controlled("spO");
  const toM = o.attach(mm), toK = o.attach(k);
  toM(o.cat()); toK(o.cat());
  connect(mm, h1); connect(k, h2); connect(h1, h2);
  await until(() => [h1, h2].every((n) => n.mesh.servers().some((s) => s.spaceId === "spO")));
  await settle();
  toM({ event: "rec", r: o.rec("내용1") });
  toK({ event: "rec", r: o.rec("내용2") });
  await until(() => o.seen.filter((e) => e.event === "fork").length >= 2);
  for (const n of [mm, k]) assert.ok(n.logs.includes("mesh_fork_reported"), n.name);
  for (const n of [h1, h2]) assert.ok(n.logs.includes("mesh_fork_detected"), n.name);
  for (const n of [mm, k, h1, h2]) assert.equal(n.logs.includes("mesh_link_dropped"), false, n.name);
});

test("origin_detects_version_it_did_not_sign: 원래 작성 서버는 자기가 쓰지 않은 기록을 알아챈다", async () => {
  const a = node("에이", "spA");
  const ach = a.addChannel("일반");
  const m = controlled("spM");
  const send = m.attach(a);
  a.say(ach, "진짜");
  await until(() => m.seen.some((e) => e.event === "rec"));
  const real = m.seen.find((e) => e.event === "rec").r;
  send({ event: "fork", a: real, b: signMesh("rec", { ...real.body, text: "가짜" }, a.keys), tagA: "spX", tagB: "spY" });
  await until(() => a.logs.includes("mesh_fork_not_signed_by_me"));
});

test("origin_with_pruned_hash_reports_unknown: 해시가 없으면 확인 불가로 알린다", async () => {
  const a = node("에이", "spA");
  const ach = a.addChannel("일반");
  const m = controlled("spM");
  const send = m.attach(a);
  await settle();
  const body = { origin: "spA", ch: ach, n: 99, prev: "", seq: 99, ts: Date.now(), from: "x", fromName: "x", hubUser: "x", via: [], text: "1" } as RecordBody;
  send({ event: "fork", a: signMesh("rec", body, a.keys), b: signMesh("rec", { ...body, text: "2" }, a.keys), tagA: "spX", tagB: "spY" });
  await until(() => a.logs.includes("mesh_fork_own_unknown"));
});


test("new_fork_visible_after_old_one_and_rate_limited: 다른 번호의 갈라짐은 다시 알리되, 서버당 빈도는 제한한다", async () => {
  const d = node("디", "spD");
  const m = controlled("spM");
  const send = m.attach(d);
  send(m.cat());
  await until(() => d.mesh.servers().some((s) => s.spaceId === "spM"));
  let prev = "";
  for (let n = 1; n <= 7; n++) { const r = m.rec(`정상${n}`, n, prev); send({ event: "rec", r }); prev = recordHash(r.body); }
  await until(() => d.channels.recent(d.mesh.mirrorId("spM", "ch"), 10).length === 7);
  send({ event: "rec", r: m.rec("갈래", 1) });
  send({ event: "rec", r: m.rec("갈래", 2, "x".repeat(64)) });
  await until(() => d.logs.filter((l) => l === "mesh_fork_detected").length === 2);
  for (let n = 3; n <= 7; n++) send({ event: "rec", r: m.rec("갈래", n, "x".repeat(64)) });
  await settle();
  assert.equal(d.logs.filter((l) => l === "mesh_fork_detected").length, 5);
});

test("fork_log_shows_verified_neighbor: 경고의 전달자는 검증된 이웃이고, 상대가 주장한 태그를 믿지 않는다", async () => {
  const details: any[] = [];
  const d = node("디", "spD", { log: (code: string, detail?: object) => { if (code === "mesh_fork_detected") details.push(detail); } });
  const m = controlled("spM"), other = controlled("spH");
  const send = m.attach(d), sendH = other.attach(d);
  send(m.cat());
  await until(() => d.mesh.servers().some((s) => s.spaceId === "spM"));
  send({ event: "rec", r: m.rec("내용1") });
  await until(() => d.channels.recent(d.mesh.mirrorId("spM", "ch"), 10).length === 1);
  sendH({ event: "rec", r: m.rec("내용2"), tag: { from: "innocentServer" } });
  await until(() => details.length === 1);
  assert.equal(details[0].otherVia, "spH");
});
