import { test } from "node:test";
import assert from "node:assert/strict";
import { generateSigningKeys } from "../../../shared/connCrypto.js";
import { signMesh } from "../../../shared/meshRecord.js";
import { LinkChannel } from "./link.js";
import { connect, node, settle, until, type Node } from "./testkit.js";

const G = (n: Node) => n.gov!;

async function trio() {
  const a = node("에이", "spA", { relayTimeoutMs: 300 }, { gov: true });
  const c = node("씨", "spC", { relayTimeoutMs: 300 }, { gov: true });
  const d = node("디", "spD", { relayTimeoutMs: 300 }, { gov: true });
  const ach = a.addChannel("에이 일반"), cch = c.addChannel("씨 일반"), dch = d.addChannel("디 일반");
  connect(a, c); connect(c, d);
  await until(() => [a, c, d].every((n) => n.mesh.servers().length === 2));
  await settle();
  return { a, c, d, ach, cch, dch };
}

test("unanimous_case_applies: 모두 '메인=A'를 고르면 적용 — A는 망 전체를 올리고, 나머지는 A 확인 뒤 자기 채널 올리기를 멈춤", async () => {
  const { a, c, d, cch, dch } = await trio();
  for (const n of [a, c, d]) G(n).setChoice({ case: "main", main: "spA", standby: [] });
  await until(() => [a, c, d].every((n) => G(n).effectiveCase().case === "main"));
  await until(() => !G(c).uploadPlan().own && !G(d).uploadPlan().own);
  const pa = G(a).uploadPlan();
  assert.equal(pa.own, true);
  assert.deepEqual(pa.mirrors.sort(), [a.mesh.mirrorId("spC", cch), a.mesh.mirrorId("spD", dch)].sort());
  assert.deepEqual(G(c).uploadPlan().mirrors, []);
});

test("disagreement_falls_back: 하나라도 다르게 고르면 분산화(각자 자기 채널)", async () => {
  const { a, c, d } = await trio();
  G(a).setChoice({ case: "main", main: "spA", standby: [] });
  G(c).setChoice({ case: "main", main: "spC", standby: [] });
  G(d).setChoice({ case: "main", main: "spA", standby: [] });
  await settle(150);
  for (const n of [a, c, d]) {
    assert.equal(G(n).effectiveCase().case, "distributed");
    assert.deepEqual(G(n).uploadPlan(), { own: true, mirrors: [] });
  }
});

test("coordinator_case_applies: 총괄 A를 인정한 서버는 A가 정한 경우(메인=D)를 따른다(A 자신도)", async () => {
  const { a, c, d } = await trio();
  G(a).declareCoordinator(true);
  await until(() => G(c).coordinators().includes("spA") && G(d).coordinators().includes("spA"));
  G(c).accept("spA"); G(d).accept("spA");
  G(a).issue({ type: "case", choice: { case: "main", main: "spD", standby: [] } });
  await until(() => [a, c, d].every((n) => G(n).effectiveCase().main === "spD"));
  await until(() => !G(a).uploadPlan().own && !G(c).uploadPlan().own);
  assert.equal(G(d).uploadPlan().own, true);
  assert.equal(G(d).uploadPlan().mirrors.length, 2);
});

test("not_accepted_ignores_commands: 총괄을 인정하지 않은 서버는 명령을 따르지 않는다(명령은 받음)", async () => {
  const { a, c, d } = await trio();
  G(a).declareCoordinator(true);
  await until(() => G(d).coordinators().includes("spA"));
  G(a).issue({ type: "case", choice: { case: "single", main: "spA", standby: [] } });
  G(a).issue({ type: "cut", target: "spC" });
  await until(() => G(d).status().commandsSeen === 2);
  await settle(50);
  assert.equal(G(d).blocked("spC"), false);
  assert.equal(G(d).effectiveCase().case, "distributed");
  assert.equal(d.mesh.servers().some((s) => s.spaceId === "spC"), true);
});

test("accept_requires_declared_coordinator: 총괄을 선언하지 않은 서버는 인정할 수 없다", async () => {
  const { c } = await trio();
  assert.throws(() => G(c).accept("spA"), /not_coordinator/);
});

function intruder(target: Node) {
  const keys = generateSigningKeys();
  const [x, y] = LinkChannel.memoryPair();
  x.setHandlers({ onRequest: (_r, reply) => reply({ ok: true, heads: [], records: [] }), onEvent: () => {} });
  target.mesh.attach({ spaceId: "spM", spaceName: "엠", serverKey: keys.publicKeyB64 }, y);
  return { keys, send: (e: object) => x.event(e as { event: string }) };
}

test("command_forged_ignored: A 이름을 단 다른 키 명령은 무시", async () => {
  const { a, d } = await trio();
  G(a).declareCoordinator(true);
  await until(() => G(d).coordinators().includes("spA"));
  G(d).accept("spA");
  const m = intruder(d);
  m.send({ event: "cmd", m: signMesh("cmd", { origin: "spA", n: 50, cmd: { type: "cut", target: "spC" } }, m.keys) });
  await settle();
  assert.equal(G(d).blocked("spC"), false);
  assert.ok(d.logs.includes("mesh_reject_gov_forged"));
});

test("command_replay_ignored: 예전 명령(번호 낮음)을 다시 보내도 되돌아가지 않음", async () => {
  const { a, c, d } = await trio();
  const captured: any[] = [];
  const e = node("이", "spE", {}, { gov: true });
  connect(a, e, (from, obj) => { if (from === "a" && obj.event === "cmd") captured.push(JSON.parse(JSON.stringify(obj))); return true; });
  G(a).declareCoordinator(true);
  await until(() => G(d).coordinators().includes("spA"));
  G(d).accept("spA");
  G(a).issue({ type: "case", choice: { case: "main", main: "spA", standby: [] } });
  G(a).issue({ type: "case", choice: { case: "main", main: "spD", standby: [] } });
  await until(() => G(d).effectiveCase().main === "spD" && captured.length === 2);
  intruder(d).send(captured[0]);
  await settle();
  assert.equal(G(d).effectiveCase().main, "spD");
  void c;
});

test("cut_blocks_server: 총괄의 '망에서 끊기' — 인정한 서버는 그 서버와 끊고 기록·목록을 거부, 다시 붙어도 끊음", async () => {
  const { a, c, d, dch } = await trio();
  G(a).declareCoordinator(true);
  await until(() => G(c).coordinators().includes("spA"));
  G(c).accept("spA");
  G(a).issue({ type: "cut", target: "spD" });
  await until(() => G(c).blocked("spD"));
  await until(() => !c.channels.getChannel(c.mesh.mirrorId("spD", dch)));
  assert.equal([...c.mesh.links].some((l) => l.info.spaceId === "spD"), false);
  connect(c, d);
  await settle();
  assert.equal([...c.mesh.links].some((l) => l.info.spaceId === "spD"), false);
  assert.ok(c.logs.includes("mesh_blocked_link"));
  assert.equal(c.mesh.servers().some((s) => s.spaceId === "spD"), false); // 망 서버 목록에서도 빠짐(화면·구성원 공유)
});

test("unshare_stops_relay: 총괄의 '공유 채널 중단' — 대상 서버는 망 공유에서 빼고, 다른 서버는 그 채널 거울·중계를 멈춤", async () => {
  const { a, c, d, dch } = await trio();
  G(a).declareCoordinator(true);
  await until(() => G(c).coordinators().includes("spA") && G(d).coordinators().includes("spA"));
  G(c).accept("spA"); G(d).accept("spA");
  G(a).issue({ type: "unshare", target: "spD", ch: dch });
  await until(() => !d.own.some((x) => x.id === dch));
  await until(() => !c.channels.getChannel(c.mesh.mirrorId("spD", dch)));
  assert.deepEqual(await c.mesh.relayWrite({ mirrorId: c.mesh.mirrorId("spD", dch), from: "x", fromName: "x", hubUser: "x", text: "x" }), { ok: false, code: "channel_not_found" });
});

test("nowrite_blocks_relay_write: 총괄의 '중계 쓰기 막기' — C를 거친 쓰기는 거부, 읽기는 그대로", async () => {
  const { a, c, d, dch } = await trio();
  G(a).declareCoordinator(true);
  await until(() => G(d).coordinators().includes("spA") && G(c).coordinators().includes("spA"));
  G(d).accept("spA");
  G(a).issue({ type: "noWrite", entry: "spC" });
  await until(() => G(d).noWrite("spC", "누구든"));
  const r = await c.mesh.relayWrite({ mirrorId: c.mesh.mirrorId("spD", dch), from: "c1", fromName: "씨AI", hubUser: "씨", text: "막힘?" });
  assert.deepEqual(r, { ok: false, code: "relay_write_blocked" });
  d.say(dch, "읽기는 됨");
  await until(() => c.mirror(d, dch).length === 1);
  assert.deepEqual(await a.mesh.relayWrite({ mirrorId: a.mesh.mirrorId("spD", dch), from: "a1", fromName: "에이AI", hubUser: "에이", text: "A는 됨" }), { ok: true, seq: 2 });
});

test("standby_keeps_full_copy: 예비 서버는 전체 사본(잘라내지 않음·처음부터 당김), 나머지는 최근 500개만", async () => {
  const { a, c, d } = await trio();
  for (const n of [a, c, d]) G(n).setChoice({ case: "main", main: "spA", standby: ["spC"] });
  await until(() => [a, c, d].every((n) => G(n).effectiveCase().case === "main"));
  assert.deepEqual(G(c).trimPlan(), []);
  assert.equal(G(c).initialWindow(), Infinity);
  assert.equal(G(a).initialWindow(), Infinity);
  assert.equal(G(d).initialWindow(), 500);
  assert.equal(G(d).trimPlan().length, 2);
});

test("no_upload_gap: 메인이 아직 같은 경우를 쓰지 않으면 다른 서버는 자기 채널을 계속 올린다", async () => {
  const { a, c, d } = await trio();
  G(c).setChoice({ case: "main", main: "spA", standby: [] });
  G(d).setChoice({ case: "main", main: "spA", standby: [] });
  await settle(100);
  assert.equal(G(c).uploadPlan().own, true);
  assert.equal(G(d).uploadPlan().own, true);
  G(a).setChoice({ case: "main", main: "spA", standby: [] });
  await until(() => !G(c).uploadPlan().own);
});

test("promote_standby: 총괄이 예비(C)를 메인으로 올리면 C가 망 전체를 올린다", async () => {
  const { a, c, d } = await trio();
  G(a).declareCoordinator(true);
  await until(() => G(c).coordinators().includes("spA") && G(d).coordinators().includes("spA"));
  G(c).accept("spA"); G(d).accept("spA");
  G(a).issue({ type: "case", choice: { case: "main", main: "spA", standby: ["spC"] } });
  await until(() => G(c).effectiveCase().main === "spA");
  G(a).issue({ type: "case", choice: { case: "main", main: "spC", standby: [] } });
  await until(() => G(c).effectiveCase().main === "spC");
  assert.equal(G(c).uploadPlan().own, true);
  assert.equal(G(c).uploadPlan().mirrors.length, 2);
});

test("revoke_acceptance_lifts_effects: 인정을 철회하면 그 총괄의 효과(끊기·경우)가 풀린다", async () => {
  const { a, c } = await trio();
  G(a).declareCoordinator(true);
  await until(() => G(c).coordinators().includes("spA"));
  G(c).accept("spA");
  G(a).issue({ type: "noWrite", entry: "spD" });
  G(a).issue({ type: "case", choice: { case: "single", main: "spA", standby: [] } });
  await until(() => G(c).effectiveCase().case === "single" && G(c).noWrite("spD", "x"));
  G(c).accept(null);
  assert.equal(G(c).noWrite("spD", "x"), false);
  assert.equal(G(c).effectiveCase().case, "distributed");
});

test("gov_restart_keeps_state: 다시 켜도 인정·명령 효과·선택이 남는다", async () => {
  const { a, c } = await trio();
  G(a).declareCoordinator(true);
  await until(() => G(c).coordinators().includes("spA"));
  G(c).accept("spA");
  G(a).issue({ type: "noWrite", entry: "spD" });
  await until(() => G(c).noWrite("spD", "x"));
  G(c).setChoice({ case: "main", main: "spA", standby: [] });
  c.restart();
  assert.equal(G(c).noWrite("spD", "x"), true);
  assert.equal(G(c).status().accepted, "spA");
  assert.equal(G(c).choice().main, "spA");
});

test("cut_only_neighbor_still_propagates: 총괄의 유일한 이웃을 끊어도 명령은 먼저 퍼진다", async () => {
  const { a, c, d } = await trio();
  G(a).declareCoordinator(true);
  await until(() => G(d).coordinators().includes("spA"));
  G(d).accept("spA");
  G(a).issue({ type: "cut", target: "spC" }); // A의 이웃은 C 하나
  await until(() => G(d).blocked("spC"));
  assert.equal([...a.mesh.links].some((l) => l.info.spaceId === "spC"), false);
  void c;
});

test("no_upload_gap_until_main_confirms: 내 쪽 실제 경우가 '메인=D'여도 D가 그 경우를 쓴다고 알리기 전엔 내 채널을 계속 올린다", async () => {
  const { a, c, d } = await trio();
  G(a).declareCoordinator(true);
  await until(() => G(c).coordinators().includes("spA"));
  G(c).accept("spA"); // D는 인정 안 함 → D는 분산화로 남음
  G(a).issue({ type: "case", choice: { case: "main", main: "spD", standby: [] } });
  await until(() => G(c).effectiveCase().main === "spD");
  await settle(100);
  assert.equal(G(d).effectiveCase().case, "distributed");
  assert.equal(G(c).uploadPlan().own, true);
  G(d).accept("spA");
  await until(() => !G(c).uploadPlan().own);
});
