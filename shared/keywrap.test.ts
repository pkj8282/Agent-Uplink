import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { generateWrapKeys, seal, unseal, unwrapKey, wrapKey } from "./keywrap.js";
import { openEnvelope, signEnvelope } from "./signed.js";
import { generateSigningKeys } from "./connCrypto.js";

test("wrap_roundtrip_and_rejects: 받는이만 풀 수 있고, aad·변조가 다르면 실패", () => {
  const bob = generateWrapKeys();
  const eve = generateWrapKeys();
  const key = randomBytes(32);
  const w = wrapKey(key, bob.publicB64, "space|1|bob");
  assert.deepEqual(unwrapKey(w, bob.privatePem, "space|1|bob"), key);
  assert.equal(unwrapKey(w, eve.privatePem, "space|1|bob"), null);
  assert.equal(unwrapKey(w, bob.privatePem, "space|2|bob"), null);
  const ct = Buffer.from(w.ct, "base64");
  ct[0] ^= 1;
  assert.equal(unwrapKey({ ...w, ct: ct.toString("base64") }, bob.privatePem, "space|1|bob"), null);
  assert.equal(unwrapKey({ ...w, epk: "garbage" }, bob.privatePem, "space|1|bob"), null);
  assert.equal(unwrapKey({} as any, bob.privatePem, "x"), null);
  // 같은 열쇠를 감싸도 매번 다르게(임시 키)
  assert.notEqual(wrapKey(key, bob.publicB64, "a").ct, wrapKey(key, bob.publicB64, "a").ct);
});

test("envelope_roundtrip_and_rejects: 서명 봉투는 서명자·본문 변조를 잡는다", () => {
  const a = generateSigningKeys();
  const b = generateSigningKeys();
  const raw = signEnvelope({ x: 1, y: ["한글"] }, a.privateKeyPem, a.publicKeyB64);
  const o = openEnvelope(raw);
  assert.equal(o.ok, true);
  if (o.ok) { assert.deepEqual(o.body, { x: 1, y: ["한글"] }); assert.equal(o.signer, a.publicKeyB64); }
  assert.equal(openEnvelope(raw, a.publicKeyB64).ok, true);
  assert.equal(openEnvelope(raw, b.publicKeyB64).ok, false); // 기대한 서명자가 아님
  const j = JSON.parse(raw);
  assert.equal(openEnvelope(JSON.stringify({ ...j, body: { x: 2, y: ["한글"] } })).ok, false);
  assert.equal(openEnvelope(JSON.stringify({ ...j, signer: b.publicKeyB64 })).ok, false); // 서명자만 바꿔치기
  assert.equal(openEnvelope("not json").ok, false);
  assert.equal(openEnvelope(JSON.stringify({ body: {}, signer: a.publicKeyB64 })).ok, false);
  // 키 순서가 달라도 같은 본문이면 통과(정규화)
  const reordered = JSON.stringify({ sig: j.sig, signer: j.signer, body: { y: ["한글"], x: 1 } });
  assert.equal(openEnvelope(reordered, a.publicKeyB64).ok, true);
});

test("seal_roundtrip_and_rejects: 이름·채널 봉함", () => {
  const key = randomBytes(32);
  const s = seal(key, "roster|3", { names: { h: "비" }, channels: [{ channelId: "c", name: "main" }] });
  assert.equal(JSON.stringify(s).includes("main"), false);
  assert.deepEqual(unseal(key, "roster|3", s), { names: { h: "비" }, channels: [{ channelId: "c", name: "main" }] });
  assert.equal(unseal(key, "roster|4", s), null);
  assert.equal(unseal(randomBytes(32), "roster|3", s), null);
  assert.equal(unseal(key, "roster|3", { nonce: "x", ct: "y" }), null);
});
