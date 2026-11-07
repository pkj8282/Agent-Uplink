import { test } from "node:test";
import assert from "node:assert/strict";
import { generateSigningKeys } from "./connCrypto.js";
import { generateWrapKeys } from "./keywrap.js";
import { signEnvelope } from "./signed.js";
import { decodeSpaceInvite, encodeSpaceInvite, joinProof, makeJoinRequest, readJoinRequest, type SpaceInvite } from "./spaceInvite.js";

const owner = generateSigningKeys();
const base = (): SpaceInvite => ({
  v: 1, kind: "space1", spaceId: "11111111-2222-3333-4444-555555555555", spaceName: "팀", repo: "me/space-repo",
  ownerKey: owner.publicKeyB64, inviteId: "inv-abc123", token: "TOKENTOKENTOKEN", expiresAt: Date.now() + 60_000, memberName: "비", hostUser: "에이",
});

test("space_invite_roundtrip: 만들고 풀면 같은 내용, 접두사 UPLINKS1-", () => {
  const code = encodeSpaceInvite(base(), owner.privateKeyPem);
  assert.match(code, /^UPLINKS1-/);
  const d = decodeSpaceInvite(code, Date.now());
  assert.equal(d.ok, true);
  if (d.ok) { assert.equal(d.invite.repo, "me/space-repo"); assert.equal(d.invite.memberName, "비"); assert.equal(d.invite.branch, undefined); }
  const withBranch = decodeSpaceInvite(encodeSpaceInvite({ ...base(), branch: "data" }, owner.privateKeyPem), Date.now());
  assert.equal(withBranch.ok && withBranch.invite.branch, "data");
});

test("space_invite_rejects: 위조·만료·다른 버전·나쁜 저장소·방식 2 코드", () => {
  const code = encodeSpaceInvite(base(), owner.privateKeyPem);
  const other = generateSigningKeys();
  assert.equal((decodeSpaceInvite(encodeSpaceInvite({ ...base(), ownerKey: other.publicKeyB64 }, owner.privateKeyPem), Date.now()) as any).code, "invite_bad_signature");
  assert.equal((decodeSpaceInvite(encodeSpaceInvite({ ...base(), expiresAt: Date.now() - 1 }, owner.privateKeyPem), Date.now()) as any).code, "invite_expired");
  assert.equal((decodeSpaceInvite(code.replace("UPLINKS1-", "UPLINKS2-"), Date.now()) as any).code, "invite_version");
  assert.equal((decodeSpaceInvite("UPLINK1-ABCD", Date.now()) as any).code, "invite_not_space"); // 방식 2 초대
  assert.equal((decodeSpaceInvite(encodeSpaceInvite({ ...base(), repo: "../x" }, owner.privateKeyPem), Date.now()) as any).code, "invite_malformed");
  assert.equal((decodeSpaceInvite(encodeSpaceInvite({ ...base(), spaceId: "../../etc" }, owner.privateKeyPem), Date.now()) as any).code, "invite_malformed");
  assert.equal((decodeSpaceInvite("garbage", Date.now()) as any).code, "invite_malformed");
  // 공백·줄바꿈이 섞여도 됨
  assert.equal(decodeSpaceInvite(code.replace(/(.{20})/g, "$1\n "), Date.now()).ok, true);
});

test("join_proof_bound_to_hub: 증명은 요청자 공개키에 묶여 다른 Hub가 다시 쓸 수 없다", () => {
  const inv = base();
  const bob = generateSigningKeys();
  const bobX = generateWrapKeys();
  const raw = makeJoinRequest(inv, bob, bobX.publicB64, 1000);
  const r = readJoinRequest(raw, inv.spaceId, (id) => (id === inv.inviteId ? inv.token : null));
  assert.equal(r.ok, true);
  if (r.ok) { assert.equal(r.req.hubKey, bob.publicKeyB64); assert.equal(r.req.xKey, bobX.publicB64); assert.equal(r.req.inviteId, inv.inviteId); }
  // 엿본 증명을 다른 키로: 본문을 바꾸면 서명이 깨지고, 자기 키로 다시 서명하면 증명이 안 맞는다
  const eve = generateSigningKeys();
  const stolen = JSON.parse(raw).body;
  const replay = signEnvelope({ ...stolen, hubKey: eve.publicKeyB64 }, eve.privateKeyPem, eve.publicKeyB64);
  assert.equal(readJoinRequest(replay, inv.spaceId, () => inv.token).ok, false);
  // 토큰이 틀리면 실패, 모르는 초대도 실패, 다른 공간도 실패
  assert.equal(readJoinRequest(raw, inv.spaceId, () => "WRONG").ok, false);
  assert.equal(readJoinRequest(raw, inv.spaceId, () => null).ok, false);
  assert.equal(readJoinRequest(raw, "other-space", () => inv.token).ok, false);
  assert.equal(joinProof("t", "s", "i", "h", "x").length > 20, true);
});
