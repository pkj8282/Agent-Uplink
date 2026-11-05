import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import {
  generateSigningKeys, signB64, verifyB64, spkiFingerprint, derivePieces, toBase32, fromBase32, newJoinToken,
} from "./connCrypto.js";
import { PROFILES, isProfileId, DEFAULT_PROFILE } from "./cryptoProfile.js";

test("sign_verify_roundtrip: 서명은 같은 데이터에서만 검증되고, 망가진 입력은 false", () => {
  const k = generateSigningKeys();
  const d = Buffer.from("x");
  const sig = signB64(k.privateKeyPem, d);
  assert.equal(verifyB64(k.publicKeyB64, d, sig), true);
  assert.equal(verifyB64(k.publicKeyB64, Buffer.from("y"), sig), false);
  assert.equal(verifyB64("garbage", d, "!!"), false);
  assert.equal(verifyB64(generateSigningKeys().publicKeyB64, d, sig), false);
});

test("fingerprint_is_sha256_of_spki: 지문은 SPKI DER의 SHA-256 hex", () => {
  const k = generateSigningKeys();
  assert.match(spkiFingerprint(k.publicKeyB64), /^[0-9a-f]{64}$/);
  assert.equal(spkiFingerprint(k.publicKeyB64), createHash("sha256").update(Buffer.from(k.publicKeyB64, "base64")).digest("hex"));
});

test("derive_pieces_order_matters: 조각별 유도 — 같은 입력은 같고, 조각·라벨이 다르면 다르다", () => {
  const m = Buffer.alloc(32, 7);
  const a = derivePieces(m, 4, 5, "t");
  assert.equal(a.length, 20);
  assert.deepEqual(a, derivePieces(m, 4, 5, "t"));
  assert.notDeepEqual(a.subarray(0, 5), a.subarray(5, 10));
  assert.notDeepEqual(a, derivePieces(m, 4, 5, "u"));
});

test("base32_roundtrip_and_reject: 대소문자·하이픈 무시, 알파벳 밖 문자는 null", () => {
  const b = randomBytes(20);
  assert.deepEqual(fromBase32(toBase32(b).toLowerCase().replace(/(.{4})/g, "$1-")), b);
  assert.equal(fromBase32("ABC1"), null);
  assert.match(toBase32(b), /^[A-Z2-7]+$/);
});

test("join_token_shape: 4글자 묶음 8개", () => {
  const t = newJoinToken();
  assert.match(t, /^([A-Z2-7]{4}-){7}[A-Z2-7]{4}$/);
  assert.notEqual(t, newJoinToken());
});

test("profiles_allowlist: 허용 목록은 정확히 두 개", () => {
  assert.deepEqual(Object.keys(PROFILES).sort(), ["tls13-aes256gcm", "tls13-chacha20"]);
  assert.equal(PROFILES["tls13-aes256gcm"].tlsCipher, "TLS_AES_256_GCM_SHA384");
  assert.equal(PROFILES["tls13-aes256gcm"].aead, "aes-256-gcm");
  assert.equal(PROFILES["tls13-chacha20"].tlsCipher, "TLS_CHACHA20_POLY1305_SHA256");
  assert.equal(PROFILES["tls13-chacha20"].aead, "chacha20-poly1305");
  assert.equal(DEFAULT_PROFILE, "tls13-aes256gcm");
  assert.equal(isProfileId("tls13-chacha20"), true);
  assert.equal(isProfileId("tls12-x"), false);
  assert.equal(isProfileId("toString"), false);
});
