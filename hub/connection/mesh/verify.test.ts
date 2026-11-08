// 서버 인정(독립 리뷰 M5, 사용자 설계): 목록으로 들은 서버는 후보일 뿐이고, 쌍별 인증 코드에 맞게 답하거나 주인이 승인해야 정식으로 들어온다.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { generateSigningKeys, type SigningKeys } from "../../../shared/connCrypto.js";
import { signMesh } from "../../../shared/meshRecord.js";
import { LinkChannel } from "./link.js";
import { connect, node, registerKey, settle, until, type Node } from "./testkit.js";
import { decodeVerifyCode, encodeVerifyCode, newVerifySecrets, openVerifyAnswer, sealVerifyAnswer } from "./verify.js";

const ctx = { verifierId: "spC", proverId: "spA", proverKey: "keyA", challenge: "chal-1" };
const secrets = () => ({ cid: "c1", ...newVerifySecrets() });

test("seal_open_roundtrip: 같은 코드·같은 문맥이면 열린다", () => {
  const s = secrets();
  assert.equal(openVerifyAnswer(s, ctx, sealVerifyAnswer(s, ctx)), true);
});

test("answer_bound_to_verifier_and_key: 다른 확인 서버·답하는 서버·키로 옮겨 쓰면 실패", () => {
  const s = secrets();
  const sealed = sealVerifyAnswer(s, ctx);
  for (const over of [{ verifierId: "spX" }, { proverId: "spX" }, { proverKey: "keyX" }]) assert.equal(openVerifyAnswer(s, { ...ctx, ...over }, sealed), false);
});

test("replayed_ciphertext_refused: 지난 답을 다음 질문에 다시 보내면 실패", () => {
  const s = secrets();
  assert.equal(openVerifyAnswer(s, { ...ctx, challenge: "chal-2" }, sealVerifyAnswer(s, ctx)), false);
});

test("tampered_ciphertext_refused: 바뀐 암호문·다른 코드는 실패", () => {
  const s = secrets();
  const sealed = sealVerifyAnswer(s, ctx);
  const ct = Buffer.from(sealed.ct, "base64");
  ct[0] ^= 1;
  assert.equal(openVerifyAnswer(s, ctx, { ...sealed, ct: ct.toString("base64") }), false);
  assert.equal(openVerifyAnswer(secrets(), ctx, sealed), false);
  assert.equal(openVerifyAnswer(s, ctx, { nonce: 1, ct: null } as never), false);
});

test("codes_differ_per_verifier: 코드는 만들 때마다 다르다", () => {
  const a = newVerifySecrets(), b = newVerifySecrets();
  assert.notEqual(a.enc, b.enc);
  assert.notEqual(a.check, b.check);
  assert.equal(Buffer.from(a.enc, "base64").length, 32);
  assert.equal(Buffer.from(a.check, "base64").length, 20);
});

test("verify_code_format: 왕복하고, 망가진 코드는 거부", () => {
  const code = encodeVerifyCode({ issuer: "spC", cid: "c1", ...newVerifySecrets() });
  assert.equal(decodeVerifyCode(code)?.issuer, "spC");
  for (const bad of ["", "abc", code.slice(0, -4), `x${code}`]) assert.equal(decodeVerifyCode(bad), null, bad);
});

const manual = { manual: true };
const fast = { verifyRetryMs: 20 };

function intruder(target: Node, id = "spM") {
  const keys = generateSigningKeys();
  const [x, y] = LinkChannel.memoryPair();
  x.setHandlers({ onRequest: (_r, reply) => reply({ ok: true, heads: [], records: [] }), onEvent: () => {} });
  registerKey(id, keys.publicKeyB64);
  target.mesh.attach({ spaceId: id, spaceName: id, serverKey: keys.publicKeyB64 }, y);
  return { keys, send: (e: object) => x.event(e as { event: string }), close: () => x.close() };
}

function fakeCat(id: string, ver = 1): { c: object; keys: SigningKeys } {
  const keys = generateSigningKeys();
  registerKey(id, keys.publicKeyB64);
  return { keys, c: signMesh("cat", { origin: id, spaceName: `가짜${id}`, ver, channels: [{ id: "ch1", name: "일반" }] }, keys) };
}

const known = (n: Node, id: string) => n.mesh.servers().some((s) => s.spaceId === id);
const candidate = (n: Node, id: string) => n.mesh.candidates().find((c) => c.origin === id);

test("fake_catalog_flood_only_fills_candidates: 가짜 서버 80개는 후보에만, 디스크·전달·재시작 뒤에도 없음", async () => {
  const d = node("디", "spD", {}, manual), obs = node("관찰", "spO", {}, manual);
  const out: any[] = [];
  connect(d, obs, (from, o) => { if (from === "a") out.push(JSON.parse(JSON.stringify(o))); return true; });
  const m = intruder(d);
  for (let i = 0; i < 80; i++) m.send({ event: "cat", c: fakeCat(`fake${i}`).c });
  await until(() => d.mesh.candidates().length > 0);
  await settle();
  assert.equal(d.mesh.servers().filter((s) => s.spaceId.startsWith("fake")).length, 0);
  assert.ok(d.mesh.candidates().length <= 16);
  assert.equal(out.some((o) => o.event === "cat" && String(o.c.body.origin).startsWith("fake")), false);
  assert.equal(fs.readFileSync(path.join(d.dataDir, "mesh", "dir.json"), "utf8").includes("fake"), false);
  d.restart();
  assert.equal(d.mesh.candidates().length, 0);
});

test("candidate_gets_no_mirror_no_relay: 후보의 기록·중계는 받지 않고 거울도 없다", async () => {
  const d = node("디", "spD", {}, manual);
  const m = intruder(d);
  const f = fakeCat("fake1");
  m.send({ event: "cat", c: f.c });
  await until(() => !!candidate(d, "fake1"));
  m.send({ event: "rec", r: signMesh("rec", { origin: "fake1", ch: "ch1", n: 1, prev: "", seq: 1, ts: Date.now(), from: "x", fromName: "x", hubUser: "x", via: [], text: "t" }, f.keys) });
  await settle();
  assert.equal(d.channels.ids().some((id) => id.startsWith("m.fake1.")), false);
  assert.ok(d.logs.includes("mesh_drop_unknown_origin"));
});

test("candidate_quota_per_link: 한 연결이 다른 연결의 후보를 밀어내지 못한다", async () => {
  const d = node("디", "spD", {}, manual);
  const m1 = intruder(d, "spM1"), m2 = intruder(d, "spM2");
  m2.send({ event: "cat", c: fakeCat("good1").c });
  await until(() => !!candidate(d, "good1"));
  for (let i = 0; i < 30; i++) m1.send({ event: "cat", c: fakeCat(`fake${i}`).c });
  await settle();
  assert.ok(candidate(d, "good1"));
  assert.ok(d.mesh.candidates().filter((c) => c.via === "spM1").length <= 16);
});

test("direct_link_accepted_automatically: 후보가 가득 차도 직접 이은 서버는 들어오고 재시작 뒤에도 남는다", async () => {
  const d = node("디", "spD", {}, manual), a = node("에이", "spA", {}, manual);
  const m = intruder(d);
  for (let i = 0; i < 80; i++) m.send({ event: "cat", c: fakeCat(`fake${i}`).c });
  await settle();
  a.addChannel("일반");
  connect(a, d);
  await until(() => known(d, "spA"));
  d.restart();
  assert.equal(known(d, "spA"), true);
});

function line(extra = fast) {
  const a = node("에이", "spA", extra, manual), b = node("비", "spB", extra, manual), c = node("씨", "spC", extra, manual);
  const frames: string[] = [];
  const tap = (_from: "a" | "b", o: unknown) => { frames.push(JSON.stringify(o)); return true; };
  const ach = a.addChannel("일반");
  connect(a, b, tap);
  connect(b, c, tap);
  return { a, b, c, ach, frames };
}

test("correct_code_auto_accepts_through_relay: C가 준 코드를 A가 답하면 B를 거쳐 자동 인정, B는 코드를 못 본다", async () => {
  const { a, c, ach, frames } = line();
  await until(() => !!candidate(c, "spA"));
  const code = c.mesh.issueVerifyCode("에이용");
  assert.equal(a.mesh.registerVerifyCode(code).ok, true);
  await until(() => known(c, "spA"));
  assert.equal(candidate(c, "spA"), undefined);
  const d = decodeVerifyCode(code)!;
  assert.ok(frames.some((f) => f.includes("v_resp")));
  assert.equal(frames.some((f) => f.includes(d.enc) || f.includes(d.check) || f.includes(code)), false);
  a.say(ach, "코드로 인정 뒤");
  await until(() => c.mirror(a, ach).length === 1);
});

test("wrong_code_stays_candidate_with_warning: 틀린 답이면 경고와 함께 후보로 남고, 주인은 승인할 수 있다", async () => {
  const { a, c } = line();
  await until(() => !!candidate(c, "spA"));
  const good = decodeVerifyCode(c.mesh.issueVerifyCode("에이용"))!;
  assert.equal(a.mesh.registerVerifyCode(encodeVerifyCode({ ...good, ...newVerifySecrets() })).ok, true);
  await until(() => candidate(c, "spA")?.warning === true);
  assert.equal(known(c, "spA"), false);
  assert.equal(c.mesh.acceptServer("spA"), true);
  assert.equal(known(c, "spA"), true);
});

test("no_code_needs_manual_accept: 코드가 없으면 후보로 남고, 주인이 승인하면 대화가 들어온다", async () => {
  const { a, c, ach } = line();
  await until(() => !!candidate(c, "spA"));
  await settle();
  assert.equal(known(c, "spA"), false);
  assert.equal(c.mesh.acceptServer("spA"), true);
  a.say(ach, "승인 뒤");
  await until(() => c.mirror(a, ach).length === 1);
  c.restart();
  assert.equal(known(c, "spA"), true);
});

test("reject_server_removes_candidate: 거절하면 후보에서 사라지고 다시 안 뜬다", async () => {
  const { a, c } = line();
  await until(() => !!candidate(c, "spA"));
  assert.equal(c.mesh.rejectServer("spA"), true);
  assert.equal(candidate(c, "spA"), undefined);
  a.addChannel("새 채널");
  await settle();
  assert.equal(candidate(c, "spA"), undefined);
});

test("answers_only_the_code_issuer: 코드를 준 적 없는 서버의 질문엔 답하지 않는다", async () => {
  const { a, c, frames } = line();
  await until(() => !!candidate(c, "spA"));
  c.mesh.issueVerifyCode("다른 서버용"); // C는 코드를 냈지만 A는 받은 적 없음
  await until(() => frames.some((f) => f.includes("v_chal")));
  await settle(100);
  assert.equal(frames.some((f) => f.includes("v_resp")), false);
  assert.equal(known(c, "spA"), false);
  assert.equal(a.mesh.listVerifyCodes().held.length, 0);
});

test("code_bound_to_first_server: 코드는 처음 맞힌 서버에 묶여 다른 서버가 쓰면 실패", async () => {
  const { a, b, c } = line();
  const e = node("이", "spE", fast, manual);
  await until(() => !!candidate(c, "spA"));
  const code = c.mesh.issueVerifyCode("에이용");
  a.mesh.registerVerifyCode(code);
  await until(() => known(c, "spA"));
  e.addChannel("일반");
  e.mesh.registerVerifyCode(code);
  connect(e, b);
  await until(() => !!candidate(c, "spE"));
  await until(() => candidate(c, "spE")?.warning === true);
  assert.equal(known(c, "spE"), false);
});

test("delete_management_code_returns_to_candidate: 코드를 지우면 그 코드로 인정된 서버는 후보로 돌아간다", async () => {
  const { a, c } = line();
  await until(() => !!candidate(c, "spA"));
  const code = c.mesh.issueVerifyCode("에이용");
  a.mesh.registerVerifyCode(code);
  await until(() => known(c, "spA"));
  const cid = c.mesh.listVerifyCodes().managed[0].cid;
  assert.equal(c.mesh.deleteVerifyCode("managed", cid), true);
  assert.equal(known(c, "spA"), false);
  assert.ok(candidate(c, "spA"));
});

test("remove_link_drops_its_candidates: 연결이 끊기면 그 연결이 알려 준 후보는 사라진다", async () => {
  const d = node("디", "spD", {}, manual);
  const m = intruder(d);
  m.send({ event: "cat", c: fakeCat("fake1").c });
  await until(() => !!candidate(d, "fake1"));
  m.close();
  await until(() => !candidate(d, "fake1"));
});

test("verify_secrets_stay_out_of_logs: 코드와 비밀은 기록에 남지 않고, 저장 파일 밖으로 안 나간다", async () => {
  const { a, c } = line();
  await until(() => !!candidate(c, "spA"));
  const code = c.mesh.issueVerifyCode("에이용");
  a.mesh.registerVerifyCode(code);
  await until(() => known(c, "spA"));
  const d = decodeVerifyCode(code)!;
  for (const n of [a, c]) assert.equal(n.logs.some((l) => l.includes(d.enc) || l.includes(d.check)), false);
  for (const row of [...c.mesh.listVerifyCodes().managed, ...a.mesh.listVerifyCodes().held]) assert.equal(JSON.stringify(row).includes(d.enc), false);
});
