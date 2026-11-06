import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { generateSigningKeys } from "./connCrypto.js";
import { checkChain, decodeFragment, encodeFragment, MAX_FRAGMENT_PLAINTEXT } from "./archive.js";
import type { Message } from "./protocol.js";

const keys = generateSigningKeys();
const spaceKey = randomBytes(32);
const msgs: Message[] = [
  { seq: 1, ts: 1, channelId: "c1", from: "u1", fromName: "기획", text: "안녕\n둘째 줄" },
  { seq: 2, ts: 2, channelId: "c1", from: "m:u2", fromName: "비", text: "hi", origin: { scope: "remote", spaceName: "팀", hubUser: "비" } },
];
const header = (index: number, prevHash = "") => ({ spaceId: "11111111-2222-3333-4444-555555555555", hubKey: keys.publicKeyB64, profile: "tls13-aes256gcm" as const, epoch: 1, index, prevHash, createdAt: 1000 + index });

function lines(b: Buffer): string[] {
  return b.toString("utf8").split("\n");
}

test("roundtrip_both_profiles: 두 암호 프로필 모두 만들고 풀면 같은 내용", () => {
  for (const profile of ["tls13-aes256gcm", "tls13-chacha20"] as const) {
    const f = encodeFragment({ header: { ...header(0), profile }, body: { messages: msgs }, spaceKey, privateKeyPem: keys.privateKeyPem });
    assert.equal(f.hash.length, 64);
    assert.equal(f.bytes.includes(Buffer.from("안녕")), false); // 평문이 보이지 않음
    const d = decodeFragment(f.bytes, { spaceKey, expectHubKey: keys.publicKeyB64 });
    assert.equal(d.ok, true);
    if (!d.ok) return;
    assert.deepEqual(d.body.messages, msgs);
    assert.equal(d.header.profile, profile);
    assert.equal(d.header.index, 0);
    assert.equal(d.header.v, 1);
    assert.equal(d.hash, f.hash);
  }
  assert.equal(MAX_FRAGMENT_PLAINTEXT, 512 * 1024);
});

test("tamper_rejected: 암호문·머리·서명 키·공간 열쇠·형식 변조는 모두 거부(RED PoC)", () => {
  const f = encodeFragment({ header: header(3, "ab".repeat(32)), body: { messages: msgs }, spaceKey, privateKeyPem: keys.privateKeyPem });
  const L = lines(f.bytes);
  // 암호문 1글자 바꿈
  const ct = L[3];
  const flipped = (ct[10] === "A" ? "B" : "A");
  const t1 = [...L.slice(0, 3), ct.slice(0, 10) + flipped + ct.slice(11)].join("\n");
  assert.equal((decodeFragment(Buffer.from(t1), { spaceKey }) as any).code, "frag_bad_signature");
  // 머리의 index만 바꿈
  const h = JSON.parse(L[1]);
  const t2 = [L[0], JSON.stringify({ ...h, index: 4 }), L[2], L[3]].join("\n");
  assert.equal((decodeFragment(Buffer.from(t2), { spaceKey }) as any).code, "frag_bad_signature");
  // 다른 Hub 키로 다시 서명(머리의 hubKey도 바꿈) → 기대 키와 다름
  const other = generateSigningKeys();
  const g = encodeFragment({ header: { ...header(3), hubKey: other.publicKeyB64 }, body: { messages: msgs }, spaceKey, privateKeyPem: other.privateKeyPem });
  assert.equal((decodeFragment(g.bytes, { spaceKey, expectHubKey: keys.publicKeyB64 }) as any).code, "frag_hub_mismatch");
  // 다른 공간 열쇠
  assert.equal((decodeFragment(f.bytes, { spaceKey: randomBytes(32) }) as any).code, "frag_decrypt_failed");
  // 형식 표시가 아님
  assert.equal((decodeFragment(Buffer.from(["NOTFRAG", ...L.slice(1)].join("\n")), { spaceKey }) as any).code, "frag_malformed");
  assert.equal((decodeFragment(Buffer.from("garbage"), { spaceKey }) as any).code, "frag_malformed");
});

test("profile_downgrade_rejected: 머리의 암호 프로필을 바꾸면 거부", () => {
  const f = encodeFragment({ header: header(0), body: { messages: msgs }, spaceKey, privateKeyPem: keys.privateKeyPem });
  const L = lines(f.bytes);
  const h = JSON.parse(L[1]);
  for (const profile of ["none", "tls13-chacha20"]) {
    const t = [L[0], JSON.stringify({ ...h, profile }), L[2], L[3]].join("\n");
    assert.equal(decodeFragment(Buffer.from(t), { spaceKey }).ok, false, profile);
  }
});

test("chain_check: 빠짐·이전 해시 불일치·갈라짐 감지", () => {
  const a = { index: 0, prevHash: "", hash: "a" };
  const b = { index: 1, prevHash: "a", hash: "b" };
  const c = { index: 2, prevHash: "b", hash: "c" };
  assert.deepEqual(checkChain([a, b, c]), { ok: true, breaks: [] });
  assert.deepEqual(checkChain([c, a, b]), { ok: true, breaks: [] }); // 순서 무관
  assert.deepEqual(checkChain([a, c]), { ok: false, breaks: [2] });
  assert.deepEqual(checkChain([a, { ...b, prevHash: "x" }, c]), { ok: false, breaks: [1] });
  assert.equal(checkChain([a, b, { ...b, hash: "b2" }]).ok, false); // 같은 번호 두 개
  assert.deepEqual(checkChain([{ ...a, prevHash: "zz" }]), { ok: false, breaks: [0] }); // 첫 조각은 이전 해시가 비어야 함
  assert.deepEqual(checkChain([]), { ok: true, breaks: [] });
});
