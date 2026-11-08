import { test } from "node:test";
import assert from "node:assert/strict";
import { connect, node, registerKey, settle, until } from "./testkit.js";
import { LinkChannel } from "./link.js";
import { signMesh } from "../../../shared/meshRecord.js";
import { generateSigningKeys } from "../../../shared/connCrypto.js";

test("line_multi_hop: A-C-D로 이으면 D가 A 채널 기록을 받는다(출처·보낸 이름·순서)", async () => {
  const a = node("에이", "spA"), c = node("씨", "spC"), d = node("디", "spD");
  const ch = a.addChannel("일반");
  connect(a, c); connect(c, d);
  await until(() => d.mesh.servers().some((s) => s.spaceId === "spA"));
  a.say(ch, "하나"); a.say(ch, "둘");
  await until(() => d.mirror(a, ch).length === 2);
  const got = d.mirror(a, ch);
  assert.deepEqual(got.map((m) => m.text), ["하나", "둘"]);
  assert.deepEqual(got.map((m) => m.seq), [1, 2]);
  assert.equal(got[0].origin?.spaceName, "에이");
  assert.equal(got[0].origin?.hubUser, "에이-u");
  assert.equal(got[0].fromName, "에이-ai");
  assert.equal(got[0].from, "spA/u1");
  assert.equal(d.channels.getChannel(d.mesh.mirrorId("spA", ch))?.area, "connection");
  assert.ok(d.delivered.some((m) => m.text === "하나"));
});

test("triangle_no_dup: 고리 망(A-C, C-D, A-D)에서도 메시지는 하나씩, 전달이 멈춘다", async () => {
  const a = node("에이", "spA"), c = node("씨", "spC"), d = node("디", "spD");
  const ch = a.addChannel("일반");
  connect(a, c); connect(c, d); connect(a, d);
  await until(() => d.mesh.servers().length === 2 && c.mesh.servers().length === 2);
  for (const t of ["1", "2", "3"]) a.say(ch, t);
  await until(() => d.mirror(a, ch).length === 3 && c.mirror(a, ch).length === 3);
  await settle();
  assert.equal(d.mirror(a, ch).length, 3);
  assert.equal(c.mirror(a, ch).length, 3);
  assert.equal(d.delivered.length, 3);
});

test("reconnect_fills_gap: 끊긴 동안 쓴 기록을 다시 이으면 채운다", async () => {
  const a = node("에이", "spA"), c = node("씨", "spC");
  const ch = a.addChannel("일반");
  const cut = connect(a, c);
  a.say(ch, "1");
  await until(() => c.mirror(a, ch).length === 1);
  cut();
  await settle(20);
  a.say(ch, "2"); a.say(ch, "3");
  connect(a, c);
  await until(() => c.mirror(a, ch).length === 3);
  assert.deepEqual(c.mirror(a, ch).map((m) => m.text), ["1", "2", "3"]);
});

test("unshare_removes_mirror: 망 공유에서 뺀 채널은 거울이 내려가고 이후 기록도 안 받음", async () => {
  const a = node("에이", "spA"), c = node("씨", "spC");
  const ch = a.addChannel("일반");
  connect(a, c);
  a.say(ch, "공유 중");
  await until(() => c.mirror(a, ch).length === 1);
  a.own = [];
  a.mesh.ownChanged();
  await until(() => !c.channels.getChannel(c.mesh.mirrorId("spA", ch)));
  a.say(ch, "뺀 뒤");
  await settle();
  assert.equal(c.delivered.some((m) => m.text === "뺀 뒤"), false);
});

test("own_messages_before_share_not_sent: 망에 공유하기 전 대화는 올리지 않는다", async () => {
  const a = node("에이", "spA"), c = node("씨", "spC");
  const ch = a.addChannel("일반", false);
  connect(a, c);
  a.say(ch, "공유 전");
  a.own.push({ id: ch, name: "일반" });
  a.mesh.ownChanged();
  await until(() => c.mesh.servers().some((s) => s.channels.length === 1));
  await settle(); // 목록을 받은 C가 사슬 머리를 확인·당기기까지 끝내게(공유 전 기록이 있으면 여기서 들어옴)
  a.say(ch, "공유 뒤");
  await until(() => c.mirror(a, ch).length === 1);
  await settle();
  assert.deepEqual(c.mirror(a, ch).map((m) => m.text), ["공유 뒤"]);
});

test("restart_keeps_heads: 다시 켜도 사슬이 이어지고(갈라짐 없음) 받는 쪽도 중복 없음", async () => {
  const a = node("에이", "spA"), c = node("씨", "spC");
  const ch = a.addChannel("일반");
  let cut = connect(a, c);
  a.say(ch, "1"); a.say(ch, "2");
  await until(() => c.mirror(a, ch).length === 2);
  cut();
  a.restart(); c.restart();
  cut = connect(a, c);
  a.say(ch, "3");
  await until(() => c.mirror(a, ch).length === 3);
  await settle();
  assert.deepEqual(c.mirror(a, ch).map((m) => m.seq), [1, 2, 3]);
  assert.equal(c.logs.filter((l) => l.startsWith("mesh_reject")).length, 0);
  cut();
});

test("live_gap_pulls_missing: 실시간으로 하나를 놓치면 다음 기록에서 빈칸을 알아채고 당겨 온다", async () => {
  const a = node("에이", "spA"), c = node("씨", "spC");
  const ch = a.addChannel("일반");
  let recs = 0;
  connect(a, c, (from, obj) => !(from === "a" && obj.event === "rec" && ++recs === 2)); // A→C 두 번째 기록 이벤트만 버림
  await until(() => c.mesh.servers().length === 1);
  await settle();
  a.say(ch, "1"); a.say(ch, "2"); a.say(ch, "3");
  await until(() => c.mirror(a, ch).length === 3);
  assert.deepEqual(c.mirror(a, ch).map((m) => m.text), ["1", "2", "3"]);
});

test("catalog_flood_stops: 고리 망에서 목록 전파가 멈춘다(같은 버전은 다시 퍼뜨리지 않음)", async () => {
  // 출처(A)를 거치지 않는 고리 C-D-E: 같은 버전을 다시 퍼뜨리면 셋이 끝없이 돌림
  const a = node("에이", "spA"), c = node("씨", "spC"), d = node("디", "spD"), e = node("이", "spE");
  a.addChannel("일반");
  let frames = 0;
  const tap = () => { frames++; return true; };
  connect(a, c, tap); connect(c, d, tap); connect(d, e, tap); connect(e, c, tap);
  await until(() => e.mesh.servers().length === 3 && d.mesh.servers().length === 3);
  await settle(100);
  const before = frames;
  await settle(100);
  assert.equal(frames, before);
});

test("trim_keeps_recent_and_chain: 거울을 최근 N개로 잘라도 사슬 머리는 남아 다음 기록을 이어 받고, 당겨 줄 때도 남은 것만", async () => {
  const a = node("에이", "spA"), c = node("씨", "spC"), d = node("디", "spD");
  const ch = a.addChannel("일반");
  connect(a, c);
  await until(() => c.mesh.servers().length === 1);
  await settle();
  for (const t of ["1", "2", "3", "4", "5"]) a.say(ch, t);
  await until(() => c.mirror(a, ch).length === 5);
  assert.equal(c.mesh.trim(c.mesh.mirrorId("spA", ch), 3), 2);
  assert.deepEqual(c.mirror(a, ch).map((m) => m.text), ["3", "4", "5"]);
  a.say(ch, "6");
  await until(() => c.mirror(a, ch).length === 4);
  assert.equal(c.logs.filter((l) => l.startsWith("mesh_reject")).length, 0);
  connect(c, d); // D는 C에게서만 당김 → 잘린 뒤 남은 것부터
  await until(() => d.mirror(a, ch).length === 4);
  assert.deepEqual(d.mirror(a, ch).map((m) => m.text), ["3", "4", "5", "6"]);
});

test("pull_reply_fits_frame: 긴 기록이 많아도 당기기 응답 프레임 하나가 1MB(리스너 상한)를 넘지 않고, 전부 넘어온다", async () => {
  const a = node("에이", "spA"), c = node("씨", "spC");
  const ch = a.addChannel("일반");
  const big = "가".repeat(60_000); // UTF-8 약 180KB
  for (let i = 0; i < 12; i++) a.say(ch, `${i}:${big}`);
  let maxFrame = 0;
  connect(a, c, (_from, obj) => { if (obj.id !== undefined && obj.records) maxFrame = Math.max(maxFrame, Buffer.byteLength(JSON.stringify(obj))); return true; });
  await until(() => c.mirror(a, ch).length === 12, 8000);
  assert.ok(maxFrame <= 1024 * 1024, `가장 큰 당기기 응답 ${maxFrame}바이트`);
});


test("mesh_other_events_over_budget_dropped: 한 연결의 기록 외 이벤트는 초당 상한까지만, 연결은 유지", async () => {
  const c = node("씨", "spC");
  const [x, y] = LinkChannel.memoryPair();
  const atk = generateSigningKeys();
  registerKey("spX", atk.publicKeyB64);
  c.mesh.attach({ spaceId: "spX", spaceName: "엑스", serverKey: atk.publicKeyB64 }, y);
  for (let i = 0; i < 150; i++) x.event({ event: "zz", i });
  await until(() => c.logs.includes("mesh_drop_other_rate"));
  assert.equal(y.isClosed, false);
});


// ── 망 안의 최고 백업 번호(사용자 설계) ──

const HASH = "a".repeat(64);
const beaconFast = { beaconIntervalMs: 0 };

test("beacon_highest_index_kept: 가장 높은 번호만 기억하고, 낮은 번호는 무시", async () => {
  const a = node("에이", "spA", beaconFast), c = node("씨", "spC", beaconFast);
  connect(a, c);
  await until(() => c.mesh.servers().some((s) => s.spaceId === "spA"));
  a.mesh.setBackupHead(5, HASH);
  await until(() => c.mesh.backupHeadOf("spA") === 5);
  a.mesh.setBackupHead(3, HASH);
  a.mesh.setBackupHead(9, HASH);
  await until(() => c.mesh.backupHeadOf("spA") === 9);
});

test("beacon_unsigned_or_wrong_key_ignored: 이웃이 숫자를 부풀릴 수 없다", async () => {
  const c = node("씨", "spC");
  const a = node("에이", "spA");
  connect(a, c);
  await until(() => c.mesh.servers().some((s) => s.spaceId === "spA"));
  const [x, y] = LinkChannel.memoryPair();
  const atk = generateSigningKeys();
  registerKey("spX", atk.publicKeyB64);
  c.mesh.attach({ spaceId: "spX", spaceName: "엑스", serverKey: atk.publicKeyB64 }, y);
  const body = { origin: "spA", index: 999, hash: HASH, ts: Date.now() };
  x.event({ event: "bhead", h: signMesh("bhead", body, atk) });
  x.event({ event: "bhead", h: { body: { ...body, k: "bhead" }, signer: a.keys.publicKeyB64, sig: "AAAA" } });
  await settle();
  assert.equal(c.mesh.backupHeadOf("spA"), null);
});

test("beacon_only_for_accepted_servers: 인정하지 않은 서버의 보고는 기억하지 않는다", async () => {
  const c = node("씨", "spC", {}, { manual: true });
  const [x, y] = LinkChannel.memoryPair();
  const atk = generateSigningKeys();
  registerKey("spX", atk.publicKeyB64);
  c.mesh.attach({ spaceId: "spX", spaceName: "엑스", serverKey: atk.publicKeyB64 }, y);
  const other = generateSigningKeys();
  registerKey("spFake", other.publicKeyB64);
  x.event({ event: "bhead", h: signMesh("bhead", { origin: "spFake", index: 1, hash: HASH, ts: Date.now() }, other) });
  await settle();
  assert.equal(c.mesh.backupHeadOf("spFake"), null);
});

test("beacon_future_ts_or_bad_index_ignored: 미래 시각·잘못된 번호는 무시", async () => {
  const a = node("에이", "spA"), c = node("씨", "spC");
  connect(a, c);
  await until(() => c.mesh.servers().some((s) => s.spaceId === "spA"));
  for (const over of [{ ts: Date.now() + 3_600_000 }, { index: -1 }, { index: 1.5 }, { hash: "짧음" }]) {
    a.mesh.sendRawBeaconForTest({ origin: "spA", index: 7, hash: HASH, ts: Date.now(), ...over });
  }
  await settle();
  assert.equal(c.mesh.backupHeadOf("spA"), null);
});

test("beacon_kept_after_link_down_and_restart: 연결이 끊기고 다시 켜도 기억한다", async () => {
  const a = node("에이", "spA", beaconFast), c = node("씨", "spC", beaconFast);
  const cut = connect(a, c);
  await until(() => c.mesh.servers().some((s) => s.spaceId === "spA"));
  a.mesh.setBackupHead(5, HASH);
  await until(() => c.mesh.backupHeadOf("spA") === 5);
  cut();
  c.restart();
  assert.equal(c.mesh.backupHeadOf("spA"), 5);
});

test("beacon_has_no_channel_or_address_info: 보고에는 번호·해시·시각뿐", async () => {
  const frames: any[] = [];
  const a = node("에이", "spA", beaconFast), c = node("씨", "spC", beaconFast);
  a.addChannel("비밀채널");
  connect(a, c, (from, o) => { if (from === "a" && o.event === "bhead") frames.push(o); return true; });
  await until(() => c.mesh.servers().some((s) => s.spaceId === "spA"));
  a.mesh.setBackupHead(1, HASH);
  await until(() => frames.length > 0);
  assert.deepEqual(Object.keys(frames[0].h.body).sort(), ["hash", "index", "k", "origin", "ts"]);
});

test("rollback_of_head_and_fragments_detected_via_peer: 저장소를 8번으로 되돌려도 이웃이 10번을 기억하면 경고", async () => {
  const a = node("에이", "spA", beaconFast), b = node("비", "spB", beaconFast), y = node("와이", "spY", beaconFast);
  connect(a, b);
  await until(() => b.mesh.servers().some((s) => s.spaceId === "spA"));
  a.mesh.setBackupHead(10, HASH);
  await until(() => b.mesh.backupHeadOf("spA") === 10);
  y.mesh.addRestored({ origin: "spA", hubKey: a.keys.publicKeyB64, index: 8 });
  connect(y, b);
  await until(() => y.logs.includes("storage_restore_behind_mesh"));
});

test("restored_server_checks_peers_after_link_up: 복원 때 망이 없어도 이어지면 확인하고, 같으면 조용하다", async () => {
  const a = node("에이", "spA", beaconFast), b = node("비", "spB", beaconFast), y = node("와이", "spY", beaconFast);
  connect(a, b);
  await until(() => b.mesh.servers().some((s) => s.spaceId === "spA"));
  a.mesh.setBackupHead(8, HASH);
  await until(() => b.mesh.backupHeadOf("spA") === 8);
  y.mesh.addRestored({ origin: "spA", hubKey: a.keys.publicKeyB64, index: 8 });
  y.restart();
  connect(y, b);
  await settle(100);
  assert.equal(y.logs.includes("storage_restore_behind_mesh"), false);
});

test("peer_withholding_still_uses_highest_from_others: 한 이웃이 숨겨도 다른 이웃의 기억으로 잡는다", async () => {
  const a = node("에이", "spA", beaconFast), b = node("비", "spB", beaconFast), y = node("와이", "spY", beaconFast);
  connect(a, b);
  await until(() => b.mesh.servers().some((s) => s.spaceId === "spA"));
  a.mesh.setBackupHead(10, HASH);
  await until(() => b.mesh.backupHeadOf("spA") === 10);
  const [x, yEnd] = LinkChannel.memoryPair();
  const liar = generateSigningKeys();
  registerKey("spL", liar.publicKeyB64);
  x.setHandlers({ onRequest: (_r, reply) => reply({ ok: true, head: null, heads: [], records: [] }), onEvent: () => {} });
  y.mesh.attach({ spaceId: "spL", spaceName: "거짓", serverKey: liar.publicKeyB64 }, yEnd);
  y.mesh.addRestored({ origin: "spA", hubKey: a.keys.publicKeyB64, index: 8 });
  connect(y, b);
  await until(() => y.logs.includes("storage_restore_behind_mesh"));
});
