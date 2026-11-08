import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { generateSigningKeys } from "../../../shared/connCrypto.js";
import type { Channel, Message } from "../../../shared/protocol.js";
import { ChannelStore } from "../../channels.js";
import { tempDir } from "../../testing.js";
import { MemoryBackend, StorageError } from "../storage/backend.js";
import { SpaceSync, type SpaceDeps } from "./sync.js";
import { decodeSpaceInvite, encodeSpaceInvite, makeJoinRequest } from "../../../shared/spaceInvite.js";
import { generateWrapKeys, isWrapPublicKey } from "../../../shared/keywrap.js";

/** Hub 하나 흉내: 자기 데이터 폴더·채널 저장소·신원 키, 원격 메시지는 delivered에 쌓인다. 저장소는 함께 쓰는 MemoryBackend. */
function node(backend: MemoryBackend, user: string) {
  const dir = tempDir(`uplink-s1-${user}-`);
  const channels = new ChannelStore({ dir });
  const keys = generateSigningKeys();
  const delivered: { ch: Channel; msg: Message }[] = [];
  const events: string[] = [];
  let t = 1_000_000;
  const deps: SpaceDeps = {
    spacesDir: path.join(dir, "connection", "spaces1"),
    keys,
    channels,
    makeBackend: () => backend,
    deliver: (ch, msg) => delivered.push({ ch, msg }),
    guard: (s) => s,
    log: (code) => events.push(code),
    userName: () => user,
    now: () => (t += 1000),
  };
  return { dir, channels, keys, delivered, events, deps };
}

/** 관리자 A: 로컬 서버 채널 두 개를 공간으로. */
function ownerSetup(backend: MemoryBackend) {
  const a = node(backend, "에이");
  a.channels.register({ id: "loc-main", kind: "server", label: "팀/main", members: null });
  a.channels.register({ id: "loc-dev", kind: "server", label: "팀/dev", members: null });
  return a;
}

const ownerChannels = () => [{ channelId: "loc-main", name: "작업방" }, { channelId: "loc-dev", name: "개발방" }];

async function makeSpace(backend: MemoryBackend) {
  const a = ownerSetup(backend);
  const sa = await SpaceSync.createAsOwner(a.deps, { spaceName: "팀", repo: "me/space", token: "ghp_A", intervalSec: 30, ownerChannels });
  return { a, sa };
}

async function addMember(backend: MemoryBackend, sa: SpaceSync, name: string) {
  const b = node(backend, name);
  const code = sa.invite(name, 60_000);
  const sb = await SpaceSync.join(b.deps, code, "ghp_" + name);
  assert.equal(sb.status().state, "pending");
  await sa.tick(); // 관리자 승인
  await sb.tick(); // 열쇠 받기·거울 채널
  assert.equal(sb.status().state, "active");
  return { b, sb };
}

const mirror = (sb: SpaceSync, spaceChannelId: string) => `s1:${sb.status().spaceId}:${spaceChannelId}`;

test("owner_member_exchange: 만들기 → 초대 → 참여 → 승인 → 양쪽 메시지 교환·출처 표시", async () => {
  const be = new MemoryBackend();
  const { a, sa } = await makeSpace(be);
  const { b, sb } = await addMember(be, sa, "비");
  // 구성원 거울 채널은 로컬 영역, 라벨 공간이름/채널이름
  const ch = b.channels.getChannel(mirror(sb, "loc-main"))!;
  assert.ok(ch);
  assert.equal(ch.area, undefined);
  assert.equal(ch.label, "팀/작업방");
  // A의 로컬 세션이 씀 → B에 보임
  a.channels.append("loc-main", "a-ai", "기획", "안녕 비");
  await sa.tick();
  await sb.tick();
  const got = b.delivered.map((d) => [d.ch.id, d.msg.fromName, d.msg.text, d.msg.origin?.hubUser]);
  assert.deepEqual(got, [[mirror(sb, "loc-main"), "기획", "안녕 비", "에이"]]);
  // B의 로컬 세션이 씀 → A에 보임
  b.channels.append(mirror(sb, "loc-dev"), "b-ai", "구현", "안녕 에이");
  await sb.tick();
  await sa.tick();
  assert.deepEqual(a.delivered.map((d) => [d.ch.id, d.msg.text, d.msg.origin?.scope, d.msg.origin?.hubUser, d.msg.origin?.spaceName]), [["loc-dev", "안녕 에이", "remote", "비", "팀"]]);
  assert.deepEqual(sa.status().members.map((m) => [m.userName, m.revoked]), [["에이", false], ["비", false]]);
});

test("concurrent_writers_no_dup_no_echo: 둘이 동시에 써도 충돌·중복·되올리기 없음", async () => {
  const be = new MemoryBackend();
  const { a, sa } = await makeSpace(be);
  const { b, sb } = await addMember(be, sa, "비");
  a.channels.append("loc-main", "a", "A", "A1");
  b.channels.append(mirror(sb, "loc-main"), "b", "B", "B1");
  await Promise.all([sa.tick(), sb.tick()]);
  await Promise.all([sa.tick(), sb.tick()]);
  await Promise.all([sa.tick(), sb.tick()]);
  assert.deepEqual(a.delivered.map((d) => d.msg.text), ["B1"]);
  assert.deepEqual(b.delivered.map((d) => d.msg.text), ["A1"]);
  // 받아 온 원격 메시지는 다시 올리지 않는다: 각 Hub의 조각에는 자기 메시지 하나씩만
  const frags = [...be.files.keys()].filter((k) => k.includes("/frag/"));
  assert.equal(frags.length, 2);
});

test("invite_single_use: 같은 초대 코드로 두 번째 Hub는 승인되지 않는다", async () => {
  const be = new MemoryBackend();
  const { sa } = await makeSpace(be);
  const b = node(be, "비");
  const c = node(be, "씨");
  const code = sa.invite("비", 60_000);
  const sb = await SpaceSync.join(b.deps, code, "ghp_b");
  await sa.tick();
  const sc = await SpaceSync.join(c.deps, code, "ghp_c");
  await sa.tick();
  await sb.tick();
  await sc.tick();
  assert.equal(sb.status().state, "active");
  assert.equal(sc.status().state, "pending");
  assert.equal(sa.status().members.length, 2);
});

test("names_sealed_in_storage: 저장소 어디에도 공간·채널·사용자 이름·대화 평문이 없다", async () => {
  const be = new MemoryBackend();
  const { a, sa } = await makeSpace(be);
  const { sb } = await addMember(be, sa, "비밀구성원");
  a.channels.append("loc-main", "a", "기획자", "비밀 대화 내용");
  await sa.tick();
  await sb.tick();
  const all = [...be.files.entries()].map(([k, v]) => `${k}\n${v.toString("utf8")}`).join("\n");
  for (const secret of ["팀", "작업방", "개발방", "비밀구성원", "에이", "기획자", "비밀 대화 내용", "ghp_"]) assert.equal(all.includes(secret), false, secret);
});

test("chain_break_stops_ingest: 변조된 조각은 받지 않고 기록, 다른 조각은 계속", async () => {
  const be = new MemoryBackend();
  const { a, sa } = await makeSpace(be);
  const { b, sb } = await addMember(be, sa, "비");
  b.channels.append(mirror(sb, "loc-main"), "b", "B", "첫째");
  await sb.tick();
  const p = [...be.files.keys()].find((k) => k.includes("/frag/"))!;
  const s = be.files.get(p)!.toString("utf8");
  const i = s.lastIndexOf("\n") + 5;
  be.files.set(p, Buffer.from(s.slice(0, i) + (s[i] === "A" ? "B" : "A") + s.slice(i + 1)));
  await sa.tick();
  assert.deepEqual(a.delivered.map((d) => d.msg.text), []);
  assert.ok(a.events.includes("space1_fragment_rejected"));
});

test("lost_response_adopts_own_fragment: 올라갔는데 응답만 잃어도 사슬이 끊기지 않는다", async () => {
  const be = new MemoryBackend();
  const { a, sa } = await makeSpace(be);
  const { b, sb } = await addMember(be, sa, "비");
  const realPut = be.put.bind(be);
  let lose = true;
  be.put = async (p, bytes) => { await realPut(p, bytes); if (lose && p.includes("/frag/")) { lose = false; throw new (await import("../storage/backend.js")).StorageError("storage_unreachable"); } };
  b.channels.append(mirror(sb, "loc-main"), "b", "B", "하나");
  await sb.tick(); // 응답 유실 → 오류로 끝남
  b.channels.append(mirror(sb, "loc-main"), "b", "B", "둘");
  await sb.tick(); // 다음 번엔 이어받고 새 것만
  b.channels.append(mirror(sb, "loc-main"), "b", "B", "셋");
  await sb.tick();
  await sa.tick();
  assert.deepEqual(a.delivered.map((d) => d.msg.text), ["하나", "둘", "셋"]);
});

test("squatted_path_skipped: 협력자가 내 다음 번호를 가짜 파일로 선점해도 다음 번호로 올리고 읽는 쪽은 건너뛴다", async () => {
  const be = new MemoryBackend();
  const { a, sa } = await makeSpace(be);
  const { b, sb } = await addMember(be, sa, "비");
  const hub = (sb as any).myHubId as string;
  const day = new Date((b.deps.now as () => number)() + 1000).toISOString().slice(0, 10);
  be.files.set(`agent-uplink/s1/${sb.status().spaceId}/frag/${hub}/${day}/00000000.frag`, Buffer.from("UPLINKFRAG1\n{}\nx\ny"));
  b.channels.append(mirror(sb, "loc-main"), "b", "B", "선점 뒤");
  await sb.tick();
  await sa.tick();
  assert.deepEqual(a.delivered.map((d) => d.msg.text), ["선점 뒤"]);
});

// ── T4: 퇴출·열쇠 세대·위조 거부(레드팀) ──

test("revoke_rotates_epoch: 퇴출하면 세대가 올라가고, 남은 구성원만 새 열쇠를 받는다", async () => {
  const be = new MemoryBackend();
  const { a, sa } = await makeSpace(be);
  const { b, sb } = await addMember(be, sa, "비");
  const { c, sb: sc } = await (async () => { const r = await addMember(be, sa, "씨"); return { c: r.b, sb: r.sb }; })();
  const cHub = sc.status().members.find((m) => m.me)!.hubId;
  assert.equal(await sa.revoke(cHub), true);
  assert.equal(sa.status().epoch, 2);
  await sb.tick();
  await sc.tick();
  assert.equal(sb.status().state, "active");
  assert.equal(sb.status().epoch, 2);
  assert.equal(sc.status().state, "revoked");
  assert.equal((sc as any).sec.epochKeys["2"], undefined); // C는 새 열쇠를 못 받음
  a.channels.append("loc-main", "a", "A", "퇴출 뒤 비밀");
  await sa.tick();
  await sb.tick();
  await sc.tick();
  assert.deepEqual(b.delivered.map((d) => d.msg.text), ["퇴출 뒤 비밀"]);
  assert.deepEqual(c.delivered.map((d) => d.msg.text), []);
  assert.deepEqual(sa.status().members.map((m) => [m.userName, m.revoked]), [["에이", false], ["비", false], ["씨", true]]);
});

test("revoked_hub_fragments_rejected: 퇴출된 Hub가 옛 열쇠·권한으로 계속 올려도 거부(RED PoC)", async () => {
  const be = new MemoryBackend();
  const { a, sa } = await makeSpace(be);
  const { b, sb } = await addMember(be, sa, "비");
  const { b: c, sb: sc } = await addMember(be, sa, "씨");
  c.channels.append(mirror(sc, "loc-main"), "c", "C", "퇴출 전");
  await sc.tick();
  await sa.tick();
  await sb.tick();
  const oldRoster = structuredClone((sc as any).st.roster);
  await sa.revoke(sc.status().members.find((m) => m.me)!.hubId);
  // 공격: C가 옛 명부(세대 1)를 그대로 쓰는 척하며 조각을 더 올린다
  (sc as any).st.roster = oldRoster;
  c.channels.append(mirror(sc, "loc-main"), "c", "C", "퇴출 뒤 끼어들기");
  await (sc as any).writeOwn();
  await sa.tick();
  await sb.tick();
  assert.deepEqual(a.delivered.map((d) => d.msg.text), ["퇴출 전"]);
  assert.deepEqual(b.delivered.map((d) => d.msg.text), ["퇴출 전"]);
  assert.ok(a.events.includes("space1_fragment_rejected"));
});

test("forged_roster_and_key_rejected: 구성원이 관리자인 척 쓴 명부·열쇠 파일은 거부, 자리 선점해도 관리자의 다음 명부는 받는다(RED PoC)", async () => {
  const be = new MemoryBackend();
  const { a, sa } = await makeSpace(be);
  const { b, sb } = await addMember(be, sa, "비");
  const { b: c, sb: sc } = await addMember(be, sa, "씨");
  const sp = sb.status().spaceId;
  const { signEnvelope } = await import("../../../shared/signed.js");
  const v = (sa as any).st.rosterVersion as number;
  const roster = structuredClone((sa as any).st.roster);
  // B(구성원)가 다음 명부 번호를 자기 서명으로 선점: 구성원을 자기만 남기려 함
  roster.version = v + 1;
  roster.prevHash = (sa as any).st.rosterHash;
  roster.members = roster.members.filter((m: any) => m.hubId === (sb as any).myHubId);
  be.files.set(`agent-uplink/s1/${sp}/roster/${String(v + 1).padStart(8, "0")}.json`, Buffer.from(signEnvelope(roster, b.keys.privateKeyPem, b.keys.publicKeyB64)));
  // B가 C용 가짜 열쇠 파일
  be.files.set(`agent-uplink/s1/${sp}/keys/1/${(sc as any).myHubId}.1.json`, Buffer.from(signEnvelope({ v: 1, spaceId: sp, epoch: 1, hubId: (sc as any).myHubId, wrapped: { epk: "x", nonce: "y", ct: "z" } }, b.keys.privateKeyPem, b.keys.publicKeyB64)));
  await sc.tick();
  assert.equal(sc.status().state, "active");
  assert.equal(sc.status().members.filter((m) => !m.revoked).length, 3);
  assert.ok(c.events.includes("space1_roster_rejected"));
  // 관리자가 채널을 하나 더 공유 → 선점된 번호를 건너 다음 번호로 명부를 쓰고, C는 그것을 받는다
  a.channels.register({ id: "loc-new", kind: "server", label: "팀/새방", members: null });
  (sa as any).ownerChannels = () => [...ownerChannels(), { channelId: "loc-new", name: "새방" }];
  await sa.tick();
  await sc.tick();
  assert.ok(c.channels.getChannel(mirror(sc, "loc-new")));
  void b;
});

test("request_forgery_rejected: 서명 없는·증명 틀린 참여 요청은 무시", async () => {
  const be = new MemoryBackend();
  const { a, sa } = await makeSpace(be);
  const sp = sa.status().spaceId;
  sa.invite("비", 60_000);
  const { generateSigningKeys: gen } = await import("../../../shared/connCrypto.js");
  const { signEnvelope } = await import("../../../shared/signed.js");
  const eve = gen();
  const inviteId = (sa as any).sec.invites[0].inviteId;
  be.files.set(`agent-uplink/s1/${sp}/requests/junk-1.json`, Buffer.from("{}"));
  be.files.set(`agent-uplink/s1/${sp}/requests/eve-2.json`, Buffer.from(signEnvelope({ v: 1, spaceId: sp, inviteId, hubKey: eve.publicKeyB64, xKey: "x", proof: "WRONG", ts: 1 }, eve.privateKeyPem, eve.publicKeyB64)));
  await sa.tick();
  assert.equal(sa.status().members.length, 1);
  assert.ok(a.events.includes("space1_request_rejected"));
});


test("space1_join_over_existing_refused: 이미 있는 공간에 다시 참여해 비밀·설정을 덮어쓰지 못한다", async () => {
  const backend = new MemoryBackend();
  const { a, sa } = await makeSpace(backend);
  const spaceId = sa.status().spaceId;
  const dir = path.join(a.deps.spacesDir, spaceId);
  const files = () => ["config.json", "secrets.json"].map((f) => fs.readFileSync(path.join(dir, f), "utf8"));
  const own = sa.invite("나", 60_000);
  const before = files();
  await assert.rejects(SpaceSync.join(a.deps, own, "ghp_x"), /space_already_joined/);
  const k = generateSigningKeys();
  const forged = encodeSpaceInvite({
    v: 1, kind: "space1", spaceId, spaceName: "가짜", repo: "evil/repo", ownerKey: k.publicKeyB64, inviteId: "i1", token: "t".repeat(32),
    expiresAt: 2_000_000_000_000, memberName: "피해자", hostUser: "공격자",
  } as never, k.privateKeyPem);
  let touched = false;
  await assert.rejects(SpaceSync.join({ ...a.deps, makeBackend: () => { touched = true; return backend; } }, forged, "ghp_x"), /space_key_changed/);
  assert.equal(touched, false);
  assert.deepEqual(files(), before);
});


test("isWrapPublicKey: X25519 SPKI만 받는다", () => {
  assert.equal(isWrapPublicKey(generateWrapKeys().publicB64), true);
  assert.equal(isWrapPublicKey("AAAA"), false);
  assert.equal(isWrapPublicKey(generateSigningKeys().publicKeyB64), false); // Ed25519 키는 감쌀 수 없음
});

test("join_request_bad_xkey_rejected: 망가진 xKey의 참여 요청은 거부되고 다른 구성원 퇴출을 막지 못한다", async () => {
  const be = new MemoryBackend();
  const { a, sa } = await makeSpace(be);
  const { sb } = await addMember(be, sa, "비");
  const dec = decodeSpaceInvite(sa.invite("엠", 60_000), 0);
  assert.ok(dec.ok);
  const spaceId = sa.status().spaceId;
  await be.put(`agent-uplink/s1/${spaceId}/requests/mal-1.json`, Buffer.from(makeJoinRequest(dec.invite, generateSigningKeys(), "AAAA", 1)));
  await sa.tick();
  assert.ok(a.events.includes("space1_request_rejected"));
  assert.equal(sa.status().members.length, 2);
  const bHub = sb.status().members.find((m) => m.me)!.hubId;
  assert.equal(await sa.revoke(bHub), true);
  assert.equal(sa.status().epoch, 2);
});

function failing(be: MemoryBackend, match: string) {
  const orig = be.put.bind(be);
  const ctl = { on: false };
  be.put = (async (p: string, b: Buffer) => {
    if (ctl.on && p.includes(match)) throw new StorageError("storage_unreachable");
    return orig(p, b);
  }) as typeof be.put;
  return ctl;
}

test("approve_write_failure_retries: 열쇠 쓰기가 실패하면 구성원을 추가하지 않고 다음 동기화에서 다시 승인", async () => {
  const be = new MemoryBackend();
  const { sa } = await makeSpace(be);
  const b = node(be, "비");
  const ctl = failing(be, "/keys/");
  const sb = await SpaceSync.join(b.deps, sa.invite("비", 60_000), "ghp_b");
  ctl.on = true;
  await sa.tick().catch(() => {});
  assert.equal(sa.status().members.length, 1);
  ctl.on = false;
  await sa.tick();
  await sb.tick();
  assert.equal(sb.status().state, "active");
});

test("revoke_failure_leaves_roster_unchanged: 퇴출 도중 실패하면 세대·구성원 그대로, 다시 하면 된다", async () => {
  const be = new MemoryBackend();
  const { sa } = await makeSpace(be);
  const { sb } = await addMember(be, sa, "비");
  const { sb: sc } = await addMember(be, sa, "씨");
  const cHub = sc.status().members.find((m) => m.me)!.hubId;
  const ctl = failing(be, "/roster/");
  ctl.on = true;
  await assert.rejects(sa.revoke(cHub));
  assert.equal(sa.status().epoch, 1);
  assert.equal(sa.status().members.filter((m) => !m.revoked).length, 3);
  ctl.on = false;
  assert.equal(await sa.revoke(cHub), true);
  await sb.tick();
  assert.equal(sb.status().epoch, 2);
});

test("member_picks_key_matching_roster_check: 퇴출을 여러 번 시도해 열쇠 파일이 여럿이어도 맞는 열쇠를 고른다", async () => {
  const be = new MemoryBackend();
  const { a, sa } = await makeSpace(be);
  const { b, sb } = await addMember(be, sa, "비");
  const { sb: sc } = await addMember(be, sa, "씨");
  const cHub = sc.status().members.find((m) => m.me)!.hubId;
  const ctl = failing(be, "/roster/");
  ctl.on = true;
  await assert.rejects(sa.revoke(cHub));
  await assert.rejects(sa.revoke(cHub));
  ctl.on = false;
  assert.equal(await sa.revoke(cHub), true);
  await sb.tick();
  assert.equal(sb.status().state, "active");
  assert.equal(sb.status().epoch, 2);
  a.channels.append("loc-main", "a", "A", "새 세대 비밀");
  await sa.tick();
  await sb.tick();
  assert.deepEqual(b.delivered.map((d) => d.msg.text), ["새 세대 비밀"]);
});


test("join_invite_spacename_guarded: 초대의 공간 이름도 표시 전에 감독한다", async () => {
  const be = new MemoryBackend();
  const { sa } = await makeSpace(be);
  const dec = decodeSpaceInvite(sa.invite("비", 60_000), 0);
  assert.ok(dec.ok);
  const b = node(be, "비");
  const seen: string[] = [];
  b.deps.guard = (s) => { seen.push(s); return s.replace(/\u200B/g, "[숨김]"); };
  const ownerKey = (sa as any).d.keys;
  const code = encodeSpaceInvite({ ...dec.invite, spaceName: "팀\u200B이름" }, ownerKey.privateKeyPem);
  const sb = await SpaceSync.join(b.deps, code, "ghp_b");
  assert.equal(sb.status().spaceName.includes("\u200B"), false);
});


test("join_request_low_order_xkey_rejected: 전부 0인 X25519 키도 거부되어 관리자 동기화가 멈추지 않는다", async () => {
  const zero = Buffer.concat([Buffer.from("302a300506032b656e032100", "hex"), Buffer.alloc(32)]).toString("base64");
  assert.equal(isWrapPublicKey(zero), false);
  const be = new MemoryBackend();
  const { a, sa } = await makeSpace(be);
  const dec = decodeSpaceInvite(sa.invite("엠", 60_000), 0);
  assert.ok(dec.ok);
  await be.put(`agent-uplink/s1/${sa.status().spaceId}/requests/mal-1.json`, Buffer.from(makeJoinRequest(dec.invite, generateSigningKeys(), zero, 1)));
  await sa.tick();
  assert.ok(a.events.includes("space1_request_rejected"));
  assert.equal(sa.status().lastError, null);
});

test("approve_bad_key_error_not_retried: 저장소 문제가 아닌 승인 실패는 재시도하지 않고 동기화를 멈추지 않는다", async () => {
  const be = new MemoryBackend();
  const { a, sa } = await makeSpace(be);
  const b = node(be, "비");
  await SpaceSync.join(b.deps, sa.invite("비", 60_000), "ghp_b");
  (sa as any).writeKey = async () => { throw new TypeError("bad key"); };
  await sa.tick();
  assert.equal(sa.status().lastError, null);
  assert.ok(a.events.includes("space1_request_rejected"));
  assert.equal(sa.status().members.length, 1);
});


test("request_read_failure_retried: 참여 요청 읽기가 한 번 실패해도 다음 동기화에서 승인된다", async () => {
  const be = new MemoryBackend();
  const { sa } = await makeSpace(be);
  const b = node(be, "비");
  const sb = await SpaceSync.join(b.deps, sa.invite("비", 60_000), "ghp_b");
  const orig = be.get.bind(be);
  let fail = true;
  be.get = (async (p: string) => { if (fail && p.includes("/requests/")) { fail = false; throw new StorageError("storage_unreachable"); } return orig(p); }) as typeof be.get;
  await sa.tick().catch(() => {});
  await sa.tick();
  await sb.tick();
  assert.equal(sb.status().state, "active");
});
