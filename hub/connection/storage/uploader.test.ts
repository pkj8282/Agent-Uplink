import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { generateSigningKeys, fromBase32 } from "../../../shared/connCrypto.js";
import { decodeFragment } from "../../../shared/archive.js";
import { tempDir } from "../../testing.js";
import { MemoryBackend, StorageError } from "./backend.js";
import { Uploader, type StorageConfig } from "./uploader.js";

const SPACE = "11111111-2222-3333-4444-555555555555";
const TOKEN = "github_pat_UPLOADER_SECRET";
const cfg: StorageConfig = { kind: "github", repo: "o/r", intervalMin: 5 };

function setup(dir = tempDir("uplink-up-"), keys = generateSigningKeys(), backend = new MemoryBackend()) {
  const logs = path.join(dir, "logs");
  fs.mkdirSync(logs, { recursive: true });
  const chans = ["c1", "c2"].map((id) => ({ id, logFile: path.join(logs, `${id}.jsonl`) }));
  const seqs: Record<string, number> = {};
  for (const c of chans) {
    if (fs.existsSync(c.logFile)) seqs[c.id] = fs.readFileSync(c.logFile, "utf8").split("\n").filter(Boolean).length;
  }
  const add = (ch: string, text: string) => {
    const seq = (seqs[ch] = (seqs[ch] ?? 0) + 1);
    fs.appendFileSync(path.join(logs, `${ch}.jsonl`), JSON.stringify({ seq, ts: seq, channelId: ch, from: "u", fromName: "n", text }) + "\n");
  };
  const events: string[] = [];
  const up = new Uploader({
    dir: path.join(dir, "connection", "storage"),
    spaceId: () => SPACE,
    profile: () => "tls13-chacha20",
    keys: () => keys,
    channels: () => chans,
    makeBackend: () => backend,
    log: (code) => events.push(code),
  });
  return { dir, keys, backend, up, add, events };
}

test("uploads_only_new: 새 메시지만 올리고, 둘째 조각은 첫 조각 해시를 잇는다", async () => {
  const t = setup();
  await t.up.configure(cfg, TOKEN);
  t.add("c1", "a"); t.add("c1", "b"); t.add("c2", "c");
  assert.deepEqual(await t.up.uploadNow(), { fragments: 1, messages: 3 });
  assert.deepEqual(await t.up.uploadNow(), { fragments: 0, messages: 0 });
  t.add("c2", "d"); t.add("c1", "e");
  assert.deepEqual(await t.up.uploadNow(), { fragments: 1, messages: 2 });
  const frags = [...t.backend.files.values()].map((b) => decodeFragment(b, { spaceKey: Buffer.alloc(32) }));
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
  assert.deepEqual(JSON.parse(st), { configured: true, kind: "github", repo: "o/r", intervalMin: 5, lastUploadAt: null, lastError: null, nextIndex: 0 });
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
  for (const p of t.backend.files.keys()) assert.match(p, /^agent-uplink\/[0-9a-f-]{36}\/[0-9a-f]{16}\/\d{4}-\d{2}-\d{2}\/\d{8}\.frag$/);
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
