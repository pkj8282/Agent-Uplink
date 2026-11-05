import { test } from "node:test";
import assert from "node:assert/strict";
import { generateSigningKeys, toBase32, fromBase32, newJoinToken } from "./connCrypto.js";
import { encodeInvite, decodeInvite, type InvitePayload } from "./invite.js";

const now = Date.UTC(2026, 10, 6);
const k = generateSigningKeys();
const base: InvitePayload = {
  v: 1, kind: "join", spaceId: "space-1", spaceName: "팀", profile: "tls13-aes256gcm",
  endpoint: { type: "direct", host: "203.0.113.5", port: 47930 },
  serverKey: k.publicKeyB64, token: newJoinToken(), expiresAt: now + 3600_000, hostUser: "에이",
};

/** 서명은 그대로 두고 내용만 바꾼 위조 코드. */
function forge(code: string, mutate: (p: any) => void): string {
  const body = JSON.parse(fromBase32(code.slice("UPLINK1-".length))!.toString("utf8"));
  mutate(body.p);
  return "UPLINK1-" + toBase32(Buffer.from(JSON.stringify(body), "utf8"));
}

test("invite_roundtrip: 만든 코드를 그대로 풀면 같은 내용", () => {
  const code = encodeInvite(base, k.privateKeyPem);
  assert.match(code, /^UPLINK1-[A-Z2-7]+$/);
  const r = decodeInvite(code, now);
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.invite, base);
  const spaced = code.replace(/(.{40})/g, "$1\n ");
  assert.equal(decodeInvite(spaced, now).ok, true);
  const relay: InvitePayload = { ...base, endpoint: { type: "relay", relay: "relay.example", serverId: "s1" } };
  const rr = decodeInvite(encodeInvite(relay, k.privateKeyPem), now);
  assert.equal(rr.ok, true);
  if (rr.ok) assert.deepEqual(rr.invite.endpoint, relay.endpoint);
});

test("invite_tamper_rejected: 주소·포트를 바꾼 위조는 서명 오류", () => {
  const code = encodeInvite(base, k.privateKeyPem);
  assert.deepEqual(decodeInvite(forge(code, (p) => { p.endpoint.port = 1; }), now), { ok: false, code: "invite_bad_signature" });
  assert.deepEqual(decodeInvite(forge(code, (p) => { p.serverKey = generateSigningKeys().publicKeyB64; }), now), { ok: false, code: "invite_bad_signature" });
});

test("invite_downgrade_profile_rejected: 프로필 바꿔치기 차단, 목록 밖 프로필 거부", () => {
  const code = encodeInvite(base, k.privateKeyPem);
  assert.deepEqual(decodeInvite(forge(code, (p) => { p.profile = "tls13-chacha20"; }), now), { ok: false, code: "invite_bad_signature" });
  assert.deepEqual(decodeInvite(forge(code, (p) => { p.profile = "tls12-x"; }), now), { ok: false, code: "invite_profile_unknown" });
});

test("invite_expired: 만료된 코드 거부", () => {
  const code = encodeInvite({ ...base, expiresAt: now - 1 }, k.privateKeyPem);
  assert.deepEqual(decodeInvite(code, now), { ok: false, code: "invite_expired" });
});

test("invite_garbage: 빈 값·깨진 문자·다른 버전·너무 긴 값", () => {
  assert.deepEqual(decodeInvite("", now), { ok: false, code: "invite_malformed" });
  assert.deepEqual(decodeInvite("UPLINK1-!!", now), { ok: false, code: "invite_malformed" });
  assert.deepEqual(decodeInvite("UPLINK2-AAAA", now), { ok: false, code: "invite_version" });
  assert.deepEqual(decodeInvite("UPLINK1-" + "A".repeat(5000), now), { ok: false, code: "invite_malformed" });
  assert.deepEqual(decodeInvite("UPLINK1-" + toBase32(Buffer.from('{"p":1}')), now), { ok: false, code: "invite_malformed" });
  const code = encodeInvite(base, k.privateKeyPem);
  assert.deepEqual(decodeInvite(forge(code, (p) => { p.v = 2; }), now), { ok: false, code: "invite_version" });
  assert.deepEqual(decodeInvite(forge(code, (p) => { p.endpoint = { type: "direct", host: "", port: 99999 }; }), now), { ok: false, code: "invite_malformed" });
});

test("RT-C14_space_id_path_traversal: 공간 ID는 참여자 PC의 폴더 이름이 되므로 안전한 문자만", () => {
  for (const bad of ["../../evil", "a/b", "a\\b", "..", "x".repeat(65), "공간"]) {
    const code = encodeInvite({ ...base, spaceId: bad }, k.privateKeyPem); // 서명은 맞는(악의적 서버가 만든) 코드
    assert.deepEqual(decodeInvite(code, now), { ok: false, code: "invite_malformed" }, bad);
  }
  assert.equal(decodeInvite(encodeInvite({ ...base, spaceId: "0c5f2a1e-9a7b-4c1d-8e2f-123456789abc" }, k.privateKeyPem), now).ok, true);
});
