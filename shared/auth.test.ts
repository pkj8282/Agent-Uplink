import { test } from "node:test";
import assert from "node:assert/strict";
import { newNonce, isNonce, isKeyText, clientProof, hubProof, proofEquals } from "./auth.js";

const KEY = "a".repeat(64);
const H = "1".repeat(64);
const C = "2".repeat(64);

test("nonce는 64자 소문자 hex이고 매번 다르다", () => {
  const a = newNonce(); const b = newNonce();
  assert.ok(isNonce(a)); assert.ok(isNonce(b)); assert.notEqual(a, b);
});

test("isNonce·isKeyText는 형식이 틀리면 거부한다", () => {
  for (const bad of ["", "A".repeat(64), "a".repeat(63), "a".repeat(65), "g".repeat(64), 1, null, undefined, ["a".repeat(64)]]) {
    assert.equal(isNonce(bad), false, String(bad));
    assert.equal(isKeyText(bad), false, String(bad));
  }
});

test("클라이언트·Hub 증명은 결정적이고 서로 다르며 순서·키에 민감하다", () => {
  const cp = clientProof(KEY, H, C);
  assert.equal(cp, clientProof(KEY, H, C));
  assert.ok(isNonce(cp)); // 64자 hex
  assert.notEqual(cp, hubProof(KEY, H, C));
  assert.notEqual(cp, clientProof(KEY, C, H));
  assert.notEqual(cp, clientProof("b".repeat(64), H, C));
});

test("고정 벡터(openssl HMAC-SHA256으로 교차 확인한 값, 관리 앱 사본도 같은 값)", () => {
  assert.equal(clientProof(KEY, H, C), "2f58e25f4bd0947226ed246c64cc20659df6c660b692f095692c46e1caef48d0");
  assert.equal(hubProof(KEY, H, C), "d1981eb008dd0d9e75521c6b3affab90adebd25214fd22ab8ae03396451c217d");
});

test("proofEquals는 같은 값만 참, 문자열이 아니거나 형식이 틀리면 거짓", () => {
  const p = hubProof(KEY, H, C);
  assert.equal(proofEquals(p, p), true);
  assert.equal(proofEquals(p, hubProof(KEY, H, "3".repeat(64))), false);
  assert.equal(proofEquals(p, p.toUpperCase()), false);
  assert.equal(proofEquals(p, undefined), false);
  assert.equal(proofEquals(p, 123), false);
  assert.equal(proofEquals(p, p.slice(2)), false);
});
