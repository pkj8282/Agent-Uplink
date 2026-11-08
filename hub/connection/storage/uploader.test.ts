import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { generateSigningKeys, fromBase32 } from "../../../shared/connCrypto.js";
import { decodeFragment } from "../../../shared/archive.js";
import { openEnvelope } from "../../../shared/signed.js";
import { tempDir } from "../../testing.js";
import { MemoryBackend, StorageError } from "./backend.js";
import { storageIdOf, Uploader, type StorageConfig } from "./uploader.js";

const SPACE = "11111111-2222-3333-4444-555555555555";
const TOKEN = "github_pat_UPLOADER_SECRET";
const cfg: StorageConfig = { kind: "github", repo: "o/r", intervalMin: 5 };

function setup(dir = tempDir("uplink-up-"), keys = generateSigningKeys(), backend = new MemoryBackend()) {
  const logs = path.join(dir, "logs");
  fs.mkdirSync(logs, { recursive: true });
  const chans = ["c1", "c2"].map((id) => ({ id, name: `비밀팀/${id}방`, logFile: path.join(logs, `${id}.jsonl`) }));
  const seqs: Record<string, number> = {};
  for (const c of chans) {
    if (fs.existsSync(c.logFile)) seqs[c.id] = fs.readFileSync(c.logFile, "utf8").split("\n").filter(Boolean).length;
  }
  const add = (ch: string, text: string) => {
    const seq = (seqs[ch] = (seqs[ch] ?? 0) + 1);
    fs.appendFileSync(path.join(logs, `${ch}.jsonl`), JSON.stringify({ seq, ts: seq, channelId: ch, from: "u", fromName: "n", text }) + "\n");
  };
  const events: string[] = [];
  const pruneFn = (id: string, keep: (m: any) => boolean) => {
    const f = path.join(logs, `${id}.jsonl`);
    if (!fs.existsSync(f)) return 0;
    const all = fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const kept = all.filter(keep);
    fs.writeFileSync(f, kept.map((m) => JSON.stringify(m) + "\n").join(""));
    return all.length - kept.length;
  };
  const up = new Uploader({
    prune: pruneFn,
    dir: path.join(dir, "connection", "storage"),
    spaceId: () => SPACE,
    profile: () => "tls13-chacha20",
    keys: () => keys,
    channels: () => chans,
    makeBackend: () => backend,
    log: (code) => events.push(code),
  });
  const texts = (ch: string) => fs.existsSync(path.join(logs, `${ch}.jsonl`)) ? fs.readFileSync(path.join(logs, `${ch}.jsonl`), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).text) : [];
  return { dir, keys, backend, up, add, events, texts };
}

test("uploads_only_new: 새 메시지만 올리고, 둘째 조각은 첫 조각 해시를 잇는다", async () => {
  const t = setup();
  await t.up.configure(cfg, TOKEN);
  t.add("c1", "a"); t.add("c1", "b"); t.add("c2", "c");
  assert.deepEqual(await t.up.uploadNow(), { fragments: 1, messages: 3 });
  assert.deepEqual(await t.up.uploadNow(), { fragments: 0, messages: 0 });
  t.add("c2", "d"); t.add("c1", "e");
  assert.deepEqual(await t.up.uploadNow(), { fragments: 1, messages: 2 });
  const frags = [...t.backend.files.entries()].filter(([k]) => k.endsWith(".frag")).map(([, b]) => decodeFragment(b, { spaceKey: Buffer.alloc(32) }));
  assert.equal(frags.length, 2);
  const v = await t.up.verify();
  assert.deepEqual({ ...v }, { fragments: 2, messages: 5, breaks: [], missing: [], bad: [] });
  assert.ok(t.events.includes("storage_uploaded"));
  assert.equal(typeof t.up.status().lastUploadAt, "number");
});

test("failed_upload_retries_without_gap: 실패하면 상태를 바꾸지 않고 다음에 같은 메시지를 0번으로", async () => {
  const t = setup();
  await t.up.configure(cfg, TOKEN);
  t.add("c1", "a"); t.add("c1", "b"); t.add("c1", "c");
  t.backend.failNext = new StorageError("storage_rate_limited", 1);
  await assert.rejects(t.up.uploadNow(), (e: unknown) => (e as StorageError).code === "storage_rate_limited");
  assert.equal(t.up.status().lastError, "storage_rate_limited");
  assert.equal(t.up.status().nextIndex, 0);
  assert.ok(t.events.includes("storage_upload_failed"));
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(await t.up.uploadNow(), { fragments: 1, messages: 3 });
  assert.equal(t.up.status().lastError, null);
  const only = [...t.backend.files.keys()];
  assert.match(only[0], /\/00000000\.frag$/);
});

test("lost_response_adopts_remote: 올라갔는데 응답만 잃으면 저장소의 그 조각을 이어받는다", async () => {
  const t = setup();
  await t.up.configure(cfg, TOKEN);
  t.add("c1", "a");
  const realPut = t.backend.put.bind(t.backend);
  t.backend.put = async (p, b) => { await realPut(p, b); throw new StorageError("storage_unreachable"); };
  assert.deepEqual(await t.up.uploadNow(), { fragments: 1, messages: 1 }); // 같은 실행 안에서 저장소 조각을 확인해 이어받음
  assert.equal(t.up.status().lastError, null);
  t.backend.put = realPut;
  t.add("c1", "b");
  assert.deepEqual(await t.up.uploadNow(), { fragments: 1, messages: 1 }); // a는 이미 올라감 → b만
  const v = await t.up.verify();
  assert.equal(v.fragments, 2);
  assert.equal(v.messages, 2);
  assert.deepEqual(v.breaks, []);
});

test("chain_continues_after_restart: 재시작한 업로더가 사슬을 잇는다", async () => {
  const t = setup();
  await t.up.configure(cfg, TOKEN);
  t.add("c1", "a");
  await t.up.uploadNow();
  const t2 = setup(t.dir, t.keys, t.backend);
  t2.add("c1", "b");
  assert.deepEqual(await t2.up.uploadNow(), { fragments: 1, messages: 1 });
  const v = await t2.up.verify();
  assert.deepEqual([v.fragments, v.messages, v.breaks.length, v.missing.length], [2, 2, 0, 0]);
});

test("large_backlog_splits_fragments: 512KiB 넘으면 여러 조각, 각 조각 1MB 미만", async () => {
  const t = setup();
  await t.up.configure(cfg, TOKEN);
  const big = "가".repeat(10_000); // UTF-8 30KB
  for (let i = 0; i < 40; i++) t.add("c1", big);
  const r = await t.up.uploadNow();
  assert.equal(r.messages, 40);
  assert.ok(r.fragments >= 3, String(r.fragments));
  for (const b of t.backend.files.values()) assert.ok(b.length < 1_000_000, String(b.length));
  const v = await t.up.verify();
  assert.equal(v.messages, 40);
  assert.deepEqual(v.breaks, []);
});

test("verify_reports_missing_and_tampered: 가운데 삭제는 빠짐·끊김, 변조는 bad", async () => {
  const t = setup();
  await t.up.configure(cfg, TOKEN);
  for (const x of ["a", "b", "c"]) { t.add("c1", x); await t.up.uploadNow(); }
  const keys = [...t.backend.files.keys()].sort();
  t.backend.files.delete(keys[1]);
  let v = await t.up.verify();
  assert.deepEqual(v.missing, [1]);
  assert.deepEqual(v.breaks, [2]);
  const last = t.backend.files.get(keys[2])!;
  const s = last.toString("utf8");
  const i = s.lastIndexOf("\n") + 5;
  t.backend.files.set(keys[2], Buffer.from(s.slice(0, i) + (s[i] === "A" ? "B" : "A") + s.slice(i + 1)));
  v = await t.up.verify();
  assert.deepEqual(v.bad.map((b) => b.code), ["frag_bad_signature"]);
  assert.deepEqual(v.missing, [1, 2]); // 읽을 수 없는 조각도 빠진 것으로
  // 마지막 조각을 지워도 알아챈다(사슬만으로는 안 보임)
  t.backend.files.delete(keys[2]);
  v = await t.up.verify();
  assert.deepEqual(v.missing, [1, 2]);
  assert.deepEqual(v.bad, []);
});

test("recovery_key_once: 복구 키는 연결 응답에서만, 상태에는 키·토큰 없음", async () => {
  const t = setup();
  const { recoveryKey } = await t.up.configure(cfg, TOKEN);
  assert.match(recoveryKey, /^[A-Z2-7]{4}(-[A-Z2-7]{1,4})+$/);
  const st = JSON.stringify(t.up.status());
  assert.equal(st.includes(TOKEN), false);
  assert.equal(st.includes(recoveryKey), false);
  assert.deepEqual(JSON.parse(st), { configured: true, kind: "github", repo: "o/r", intervalMin: 5, prune: { enabled: false, days: 30, lastPruneAt: null }, lastUploadAt: null, lastError: null, nextIndex: 0 });
  const secrets = JSON.parse(fs.readFileSync(path.join(t.dir, "connection", "storage", "secrets.json"), "utf8"));
  assert.equal(fromBase32(recoveryKey.replace(/-/g, ""))!.toString("base64"), secrets.spaceKey);
  // 다시 연결해도 공간 열쇠는 같다(사슬·이전 백업 유지)
  assert.equal((await t.up.configure(cfg, TOKEN)).recoveryKey, recoveryKey);
  // 연결 확인이 실패하면 아무것도 저장하지 않는다
  const t2 = setup();
  t2.backend.failNext = new StorageError("storage_auth_failed");
  await assert.rejects(t2.up.configure(cfg, TOKEN));
  assert.equal(t2.up.status().configured, false);
  assert.equal(fs.existsSync(path.join(t2.dir, "connection", "storage", "secrets.json")), false);
  // 해제하면 토큰을 지운다(공간 열쇠는 남김)
  t.up.clear();
  assert.equal(t.up.status().configured, false);
  const after = JSON.parse(fs.readFileSync(path.join(t.dir, "connection", "storage", "secrets.json"), "utf8"));
  assert.equal(after.token, undefined);
  assert.equal(after.spaceKey, secrets.spaceKey);
});

test("paths_have_no_names: 저장 경로는 ID·날짜·번호뿐", async () => {
  const t = setup();
  await t.up.configure(cfg, TOKEN);
  t.add("c1", "기획 회의");
  await t.up.uploadNow();
  for (const p of t.backend.files.keys()) assert.match(p, /^agent-uplink\/[0-9a-f-]{36}\/[0-9a-f]{16}\/(\d{4}-\d{2}-\d{2}\/\d{8}\.frag|head\.json)$/);
});

test("upload_time_only_when_uploaded: 올린 게 없으면 마지막 업로드 시각을 바꾸지 않는다(사용자 GUI 지적)", async () => {
  let now = 1_000_000;
  const t = setup();
  (t.up as any).d.now = () => now;
  await t.up.configure(cfg, TOKEN);
  assert.equal(t.up.status().lastUploadAt, null);
  await t.up.uploadNow(); // 메시지 없음
  assert.equal(t.up.status().lastUploadAt, null);
  t.add("c1", "a");
  now = 2_000_000;
  await t.up.uploadNow();
  assert.equal(t.up.status().lastUploadAt, 2_000_000);
  now = 3_000_000;
  assert.deepEqual(await t.up.uploadNow(), { fragments: 0, messages: 0 });
  assert.equal(t.up.status().lastUploadAt, 2_000_000);
});

const DAY = 86_400_000;

test("prune_only_uploaded_and_old: 올렸고 N일 지난 메시지만 지운다", async () => {
  const t = setup();
  (t.up as any).d.now = () => 100 * DAY;
  await t.up.configure(cfg, TOKEN);
  t.add("c1", "옛1"); t.add("c1", "옛2"); // ts = 1, 2(아주 오래됨)
  await t.up.uploadNow();
  t.add("c1", "안 올린 옛것"); // 오래됐지만 아직 안 올림
  t.up.setPrune({ enabled: true, days: 30 });
  const r = await t.up.pruneIfDue();
  assert.deepEqual(r, { removed: 2 });
  assert.deepEqual(t.texts("c1"), ["안 올린 옛것"]);
  assert.ok(t.events.includes("prune_done"));
  assert.equal(t.up.status().prune?.lastPruneAt, 100 * DAY);
});

test("prune_skips_when_verify_fails: 검증이 깨끗하지 않으면 아무것도 안 지운다", async () => {
  const t = setup();
  (t.up as any).d.now = () => 100 * DAY;
  await t.up.configure(cfg, TOKEN);
  t.add("c1", "a"); await t.up.uploadNow();
  t.add("c1", "b"); await t.up.uploadNow();
  t.backend.files.delete([...t.backend.files.keys()].sort()[0]);
  t.up.setPrune({ enabled: true, days: 30 });
  assert.deepEqual(await t.up.pruneIfDue(), { removed: 0 });
  assert.deepEqual(t.texts("c1"), ["a", "b"]);
  assert.ok(t.events.includes("prune_skipped"));
});

test("prune_off_by_default_and_once_per_day: 기본 꺼짐, 켜도 하루 한 번", async () => {
  let now = 100 * DAY;
  const t = setup();
  (t.up as any).d.now = () => now;
  await t.up.configure(cfg, TOKEN);
  t.add("c1", "a"); await t.up.uploadNow();
  assert.deepEqual(t.up.status().prune, { enabled: false, days: 30, lastPruneAt: null });
  assert.deepEqual(await t.up.pruneIfDue(), { removed: 0 });
  assert.deepEqual(t.texts("c1"), ["a"]);
  t.up.setPrune({ enabled: true, days: 30 });
  assert.deepEqual(await t.up.pruneIfDue(), { removed: 1 });
  t.add("c1", "b"); await t.up.uploadNow();
  now += DAY / 2;
  assert.deepEqual(await t.up.pruneIfDue(), { removed: 0 }); // 24시간 안 지남
  now += DAY;
  assert.deepEqual(await t.up.pruneIfDue(), { removed: 1 });
  assert.throws(() => t.up.setPrune({ enabled: true, days: 6 }));
  assert.throws(() => t.up.setPrune({ enabled: true, days: 366 }));
});

test("switch_target_restarts_chain: 저장소를 바꾸면 새 저장소에 대화 전체를 0번부터 올린다(같은 저장소로 다시 연결하면 이어 감)", async () => {
  const t = setup();
  await t.up.configure(cfg, TOKEN);
  t.add("c1", "a"); t.add("c1", "b");
  await t.up.uploadNow();
  // 같은 저장소로 다시 연결 → 이어 감
  await t.up.configure(cfg, TOKEN);
  assert.equal(t.up.status().nextIndex, 1);
  // 다른 저장소로 → 처음부터(복구 키는 그대로)
  const before = (await t.up.configure(cfg, TOKEN)).recoveryKey;
  const r = await t.up.configure({ kind: "github", repo: "o/other", intervalMin: 5 }, TOKEN);
  assert.equal(r.recoveryKey, before);
  assert.equal(t.up.status().nextIndex, 0);
  assert.equal(t.up.status().lastUploadAt, null);
  t.backend.files.clear(); // 새 저장소는 비어 있음
  assert.deepEqual(await t.up.uploadNow(), { fragments: 1, messages: 2 });
  const v = await t.up.verify();
  assert.deepEqual([v.fragments, v.messages, v.breaks, v.missing], [1, 2, [], []]);
});

test("switch_target_legacy_state: 저장소 정보가 없는 예전 진행 기록도 지금 설정과 다르면 처음부터", async () => {
  const t = setup();
  await t.up.configure(cfg, TOKEN);
  t.add("c1", "a");
  await t.up.uploadNow();
  const f = path.join(t.dir, "connection", "storage", "state.json");
  const st = JSON.parse(fs.readFileSync(f, "utf8"));
  delete st.target;
  fs.writeFileSync(f, JSON.stringify(st));
  await t.up.configure({ kind: "github", repo: "o/other", intervalMin: 5 }, TOKEN);
  assert.equal(t.up.status().nextIndex, 0);
});

test("fragment_carries_channel_names_encrypted: 조각 암호문 안에 든 채널의 이름이 있고, 저장소 바이트에는 이름 평문이 없다", async () => {
  const t = setup();
  const { recoveryKey } = await t.up.configure(cfg, TOKEN);
  t.add("c1", "a"); t.add("c1", "b");
  await t.up.uploadNow();
  const [bytes] = [...t.backend.files.values()];
  assert.equal(bytes.toString("utf8").includes("비밀팀"), false);
  const d = decodeFragment(bytes, { spaceKey: fromBase32(recoveryKey)! });
  assert.ok(d.ok);
  if (d.ok) assert.deepEqual(d.body.channels, [{ id: "c1", name: "비밀팀/c1방" }]);
});


const fragKeys = (be: MemoryBackend) => [...be.files.keys()].filter((k) => k.endsWith(".frag")).sort();

function squat(be: MemoryBackend, from: string, index: number): void {
  be.files.set(from.replace(/\d{8}\.frag$/, `${String(index).padStart(8, "0")}.frag`), Buffer.from("가짜 조각"));
}

test("squatted_index_is_skipped: 다음 번호를 다른 파일이 차지해도 건너뛰어 계속 올리고, 건너뛴 곳은 사슬 끊김이 아니다", async () => {
  const be = new MemoryBackend();
  const s = setup(undefined, undefined, be);
  await s.up.configure(cfg, TOKEN);
  s.add("c1", "첫째");
  await s.up.uploadNow();
  squat(be, fragKeys(be)[0], 1);
  s.add("c1", "둘째");
  await s.up.uploadNow();
  assert.ok(fragKeys(be).some((k) => k.endsWith("00000002.frag")));
  const v = await s.up.verify();
  assert.deepEqual(v.breaks, []);
  assert.deepEqual(v.missing, []);
  assert.equal(v.messages, 2);
});

test("squat_limit: 너무 많이 막혀 있으면 오류로 멈춘다", async () => {
  const be = new MemoryBackend();
  const s = setup(undefined, undefined, be);
  await s.up.configure(cfg, TOKEN);
  s.add("c1", "첫째");
  await s.up.uploadNow();
  const first = fragKeys(be)[0];
  for (let i = 1; i <= 25; i++) squat(be, first, i);
  s.add("c1", "둘째");
  await assert.rejects(s.up.uploadNow());
});

test("head_written_after_upload: 올릴 때마다 서명한 마지막 번호 파일을 덮어쓴다", async () => {
  const be = new MemoryBackend();
  const keys = generateSigningKeys();
  const s = setup(undefined, keys, be);
  await s.up.configure(cfg, TOKEN);
  const heads = () => [...be.files.keys()].filter((k) => k.endsWith("/head.json"));
  s.add("c1", "하나");
  await s.up.uploadNow();
  assert.equal(heads().length, 1);
  s.add("c1", "둘");
  await s.up.uploadNow();
  const env = openEnvelope(be.files.get(heads()[0])!.toString("utf8"), keys.publicKeyB64);
  assert.ok(env.ok);
  assert.equal(env.ok && env.body.index, 1);
});

test("head_failure_does_not_fail_upload: 마지막 번호 파일 쓰기가 실패해도 올리기는 성공, 다음 주기에 다시", async () => {
  const be = new MemoryBackend();
  const s = setup(undefined, undefined, be);
  await s.up.configure(cfg, TOKEN);
  const orig = be.overwrite.bind(be);
  let fail = true;
  be.overwrite = (async (p: string, b: Buffer) => { if (fail) throw new StorageError("storage_unreachable"); return orig(p, b); }) as typeof be.overwrite;
  s.add("c1", "하나");
  await s.up.uploadNow();
  assert.equal([...be.files.keys()].some((k) => k.endsWith("/head.json")), false);
  fail = false;
  await s.up.uploadNow();
  assert.equal([...be.files.keys()].some((k) => k.endsWith("/head.json")), true);
});


test("storageIdOf: 저장소마다 다르고 값이 드러나지 않는다", () => {
  const a = storageIdOf({ kind: "github", repo: "o/r", intervalMin: 5 });
  assert.notEqual(a, storageIdOf({ kind: "github", repo: "o/other", intervalMin: 5 }));
  assert.equal(a, storageIdOf({ kind: "github", repo: "o/r", intervalMin: 60 }));
  assert.equal(a.includes("o/r"), false);
});


test("storageIdOf_includes_branch: GitHub 브랜치가 다르면 다른 저장소", () => {
  assert.notEqual(storageIdOf({ kind: "github", repo: "o/r", intervalMin: 5 }), storageIdOf({ kind: "github", repo: "o/r", branch: "b2", intervalMin: 5 } as StorageConfig));
});
