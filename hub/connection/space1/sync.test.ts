import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { generateSigningKeys } from "../../../shared/connCrypto.js";
import type { Channel, Message } from "../../../shared/protocol.js";
import { ChannelStore } from "../../channels.js";
import { tempDir } from "../../testing.js";
import { MemoryBackend } from "../storage/backend.js";
import { SpaceSync, type SpaceDeps } from "./sync.js";

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
