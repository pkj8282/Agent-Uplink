import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tempDir } from "../testing.js";
import { generateSigningKeys } from "../../shared/connCrypto.js";
import { ConnectionStore, type MemberRecord, type JoinedSpace } from "./store.js";

const NOW = 1_800_000_000_000;

test("untouched_without_connection: 읽기만 하면 connection/ 폴더를 만들지 않는다", () => {
  const dataDir = tempDir("conn-store-");
  const s = new ConnectionStore({ dataDir });
  assert.equal(s.serverConfig(), null);
  assert.deepEqual(s.joined(), []);
  assert.deepEqual(s.members(), []);
  assert.equal(s.userName(), null);
  assert.equal(s.exists(), false);
  assert.equal(fs.existsSync(path.join(dataDir, "connection")), false);
});

test("identity_stable_across_reopen: 신원 키는 한 번 만들면 그대로", () => {
  const dataDir = tempDir("conn-store-");
  const a = new ConnectionStore({ dataDir }).identity();
  assert.equal(new ConnectionStore({ dataDir }).identity().publicKeyB64, a.publicKeyB64);
  assert.equal(new ConnectionStore({ dataDir }).identity().privateKeyPem, a.privateKeyPem);
});

test("invite_burn_and_bind: 파기·묶기·만료·없는 토큰, 원문 토큰은 저장하지 않음", () => {
  const dataDir = tempDir("conn-store-");
  const s = new ConnectionStore({ dataDir });
  const k1 = generateSigningKeys().publicKeyB64;
  const k2 = generateSigningKeys().publicKeyB64;
  s.addInvite("AAAA-BBBB", "B", NOW + 1000);
  assert.equal(s.useInvite("AAAA-BBBB", k1, NOW, true), "ok");
  assert.equal(s.useInvite("AAAA-BBBB", k1, NOW, true), "used");
  s.addInvite("CCCC-DDDD", "C", NOW + 1000);
  assert.equal(s.useInvite("CCCC-DDDD", k1, NOW, false), "ok");
  assert.equal(s.useInvite("CCCC-DDDD", k1, NOW, false), "ok");
  assert.equal(s.useInvite("CCCC-DDDD", k2, NOW, false), "bound_other");
  s.addInvite("EEEE-FFFF", "E", NOW + 1000);
  assert.equal(s.useInvite("EEEE-FFFF", k1, NOW + 1000, true), "expired");
  assert.equal(s.useInvite("ZZZZ-ZZZZ", k1, NOW, true), "invalid");
  const raw = fs.readFileSync(path.join(dataDir, "connection", "invites.json"), "utf8");
  for (const t of ["AAAA-BBBB", "CCCC-DDDD", "EEEE-FFFF"]) assert.equal(raw.includes(t), false);
  // 다시 열어도 상태 유지
  assert.equal(new ConnectionStore({ dataDir }).useInvite("AAAA-BBBB", k1, NOW, true), "used");
});

test("members_and_joined_persist", () => {
  const dataDir = tempDir("conn-store-");
  const s = new ConnectionStore({ dataDir });
  const m: MemberRecord = { memberId: "m1", hubKey: "k", userName: "비", joinedAt: NOW, revoked: false };
  s.addMember(m);
  assert.equal(s.revoke("m1"), true);
  assert.equal(s.revoke("nope"), false);
  const j: JoinedSpace = { spaceId: "sp", spaceName: "팀", endpoint: { type: "direct", host: "h", port: 1 }, serverKey: "k", profile: "tls13-chacha20", memberId: "m9", hostUser: "에이" };
  s.addJoined(j);
  s.setUserName("비");
  s.setServerConfig({ enabled: true, port: 47930, profile: "tls13-aes256gcm", spaceId: "sp", spaceName: "팀", burnOnJoin: true, shared: ["c-1"] });
  const r = new ConnectionStore({ dataDir });
  assert.equal(r.member("m1")?.revoked, true);
  assert.deepEqual(r.joined(), [j]);
  assert.equal(r.userName(), "비");
  assert.equal(r.serverConfig()?.port, 47930);
  r.removeJoined("sp");
  assert.deepEqual(new ConnectionStore({ dataDir }).joined(), []);
});

test("corrupt_file_kept: 깨진 파일은 빈 값으로 읽고 원본을 보존", () => {
  const dataDir = tempDir("conn-store-");
  fs.mkdirSync(path.join(dataDir, "connection"), { recursive: true });
  fs.writeFileSync(path.join(dataDir, "connection", "members.json"), "{");
  const s = new ConnectionStore({ dataDir });
  assert.deepEqual(s.members(), []);
  const kept = fs.readdirSync(path.join(dataDir, "connection")).filter((f) => f.startsWith("members.json.corrupt-"));
  assert.equal(kept.length, 1);
});
