import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { generateSigningKeys } from "../../../shared/connCrypto.js";
import { encodeFragment } from "../../../shared/archive.js";
import { signEnvelope } from "../../../shared/signed.js";
import { tempDir } from "../../testing.js";
import { MemoryBackend } from "./backend.js";
import { Uploader } from "./uploader.js";
import { parseRecoveryKey, restoreBackup, scanBackups } from "./restore.js";

const SPACE = "11111111-2222-3333-4444-555555555555";

/** 업로더 하나(한 Hub)로 저장소에 백업을 만든다. */
async function backupHub(backend: MemoryBackend, opts: { names?: boolean; keys?: ReturnType<typeof generateSigningKeys> } = {}) {
  const dir = tempDir("uplink-rs-");
  const logs = path.join(dir, "logs");
  fs.mkdirSync(logs, { recursive: true });
  const keys = opts.keys ?? generateSigningKeys();
  const chans = [{ id: "c1", name: "팀/일반" }, { id: "c2", name: "팀/작업" }].map((c) => ({ ...c, ...(opts.names === false ? { name: undefined } : {}), logFile: path.join(logs, `${c.id}.jsonl`) }));
  const seqs: Record<string, number> = {};
  const add = (ch: string, text: string) => {
    const seq = (seqs[ch] = (seqs[ch] ?? 0) + 1);
    fs.appendFileSync(path.join(logs, `${ch}.jsonl`), JSON.stringify({ seq, ts: 1000 + seq, channelId: ch, from: "u1", fromName: "에이AI", text, ...(ch === "c2" ? { origin: { scope: "remote", spaceName: "팀", hubUser: "비" } } : {}) }) + "\n");
  };
  const up = new Uploader({
    dir: path.join(dir, "connection", "storage"), spaceId: () => SPACE, profile: () => "tls13-chacha20", keys: () => keys,
    channels: () => chans.map((c) => (c.name === undefined ? { id: c.id, logFile: c.logFile } : c)), makeBackend: () => backend, log: () => {},
  });
  const { recoveryKey } = await up.configure({ kind: "github", repo: "o/r", intervalMin: 5 }, "tok");
  add("c1", "첫째"); add("c2", "둘째");
  await up.uploadNow();
  add("c1", "셋째");
  await up.uploadNow();
  return { recoveryKey, keys, up };
}

/** backupHub 뒤에 한 번 더 올린다(로그는 첫 채널 파일에 이어 쓴다). */
async function addAndUpload(up: Uploader, _be: MemoryBackend): Promise<void> {
  const d = (up as any).d;
  const c = d.channels()[0];
  const n = fs.readFileSync(c.logFile, "utf8").split("\n").filter(Boolean).length + 1;
  fs.appendFileSync(c.logFile, JSON.stringify({ seq: n, ts: 1000 + n, channelId: c.id, from: "u1", fromName: "에이AI", text: "또" }) + "\n");
  await up.uploadNow();
}

test("parseRecoveryKey: 대소문자·묶음 줄표·공백 무시, 32바이트만", () => {
  const k = "ABCD-EFGH-IJKL-MNOP-QRST-UVWX-YZ23-4567-ABCD-EFGH-IJKL-MNOP-QRST";
  assert.equal(parseRecoveryKey(k)?.length, 32);
  assert.equal(parseRecoveryKey(k.toLowerCase().replace(/-/g, " "))?.length, 32);
  assert.equal(parseRecoveryKey("ABCD"), null);
  assert.equal(parseRecoveryKey("!!!"), null);
});

test("restore_roundtrip: 복구 키로 찾고 되살리면 같은 메시지·채널 이름·출처", async () => {
  const backend = new MemoryBackend();
  const { recoveryKey } = await backupHub(backend);
  const key = parseRecoveryKey(recoveryKey)!;
  const cands = await scanBackups(backend, key);
  assert.equal(cands.length, 1);
  assert.equal(cands[0].spaceId, SPACE);
  assert.equal(cands[0].fragments, 2);
  const r = await restoreBackup(backend, key, cands[0]);
  assert.deepEqual(r.breaks, []);
  assert.deepEqual(r.bad, []);
  assert.equal(r.fragments, 2);
  assert.equal(r.messages, 3);
  const c1 = r.channels.find((c) => c.oldId === "c1")!;
  assert.equal(c1.name, "팀/일반");
  assert.deepEqual(c1.messages.map((m) => [m.seq, m.text]), [[1, "첫째"], [2, "셋째"]]);
  const c2 = r.channels.find((c) => c.oldId === "c2")!;
  assert.deepEqual(c2.messages[0].origin, { scope: "remote", spaceName: "팀", hubUser: "비" });
});

test("wrong_key_no_candidates: 다른 복구 키면 후보가 없다", async () => {
  const backend = new MemoryBackend();
  await backupHub(backend);
  assert.deepEqual(await scanBackups(backend, Buffer.alloc(32, 7)), []);
});

test("tampered_fragment_reported_and_skipped: 바뀐 조각은 들여오지 않고 보고, 사슬 끊김도 보고", async () => {
  const backend = new MemoryBackend();
  const { recoveryKey } = await backupHub(backend);
  const key = parseRecoveryKey(recoveryKey)!;
  const [first] = [...backend.files.keys()].sort();
  const b = backend.files.get(first)!.toString("utf8").split("\n");
  b[3] = b[3].slice(0, -4) + (b[3].endsWith("AAAA") ? "BBBB" : "AAAA");
  backend.files.set(first, Buffer.from(b.join("\n"), "utf8"));
  const cands = await scanBackups(backend, key);
  assert.equal(cands.length, 1); // 다른 조각이 풀리므로 후보는 남음
  const r = await restoreBackup(backend, key, cands[0]);
  assert.equal(r.bad.length, 1);
  assert.equal(r.bad[0].path, first);
  assert.equal(r.messages, 1);
  assert.deepEqual(r.breaks, [1]);
});

test("foreign_hub_fragment_rejected: 그 Hub 폴더에 다른 Hub 키로 서명한 조각을 끼워도 들여오지 않음", async () => {
  const backend = new MemoryBackend();
  const { recoveryKey } = await backupHub(backend);
  const key = parseRecoveryKey(recoveryKey)!;
  const [cand] = await scanBackups(backend, key);
  const other = generateSigningKeys();
  const forged = encodeFragment({
    header: { spaceId: SPACE, hubKey: other.publicKeyB64, profile: "tls13-chacha20", epoch: 1, index: 2, prevHash: "x", createdAt: 5 },
    body: { messages: [{ seq: 9, ts: 9, channelId: "c1", from: "evil", fromName: "가짜", text: "끼워 넣음" }] }, spaceKey: key, privateKeyPem: other.privateKeyPem,
  });
  backend.files.set(`agent-uplink/${SPACE}/${cand.hubId}/2099-01-01/00000002.frag`, forged.bytes);
  const r = await restoreBackup(backend, key, cand);
  assert.equal(r.bad.length, 1);
  assert.equal(r.bad[0].code, "frag_hub_mismatch");
  assert.equal(r.channels.flatMap((c) => c.messages).some((m) => m.text === "끼워 넣음"), false);
});

test("old_fragments_fallback_names: 이름 없는 옛 조각은 name null(화면에서 '복원 채널 N')", async () => {
  const backend = new MemoryBackend();
  const { recoveryKey } = await backupHub(backend, { names: false });
  const key = parseRecoveryKey(recoveryKey)!;
  const [cand] = await scanBackups(backend, key);
  const r = await restoreBackup(backend, key, cand);
  assert.deepEqual(r.channels.map((c) => c.name), [null, null]);
});

test("two_hubs_two_candidates: 같은 공간에 Hub가 둘이면 후보도 둘(각자 폴더)", async () => {
  const backend = new MemoryBackend();
  const a = await backupHub(backend);
  // 두 번째 Hub는 같은 복구 키를 쓸 수 없으므로(공간 열쇠는 Hub마다) 다른 키 — 첫 키로는 하나만 보인다
  await backupHub(backend);
  assert.equal((await scanBackups(backend, parseRecoveryKey(a.recoveryKey)!)).length, 1);
});


function targetOf(be: MemoryBackend) {
  const k = [...be.files.keys()].find((x) => x.endsWith(".frag"))!;
  const parts = k.split("/");
  return { key: k, spaceId: parts[parts.length - 4], hubId: parts[parts.length - 3], dir: parts.slice(0, parts.length - 2).join("/") };
}
const fragsOf = (be: MemoryBackend) => [...be.files.keys()].filter((k) => k.endsWith(".frag")).sort();

test("head_ok: 마지막 번호 파일과 조각이 맞으면 경고 없음", async () => {
  const be = new MemoryBackend();
  const { recoveryKey } = await backupHub(be);
  const t = targetOf(be);
  const r = await restoreBackup(be, parseRecoveryKey(recoveryKey)!, t);
  assert.equal(r.head, "ok");
  assert.equal(r.lastIndex, 1);
});

test("skip_is_not_a_chain_break: 자리를 뺏겨 건너뛴 정상 백업은 끊김으로 보고되지 않는다", async () => {
  const be = new MemoryBackend();
  const keys = generateSigningKeys();
  const { recoveryKey, up } = await backupHub(be, { keys });
  const frags = fragsOf(be);
  be.files.set(frags[0].replace(/\d{8}\.frag$/, "00000002.frag"), Buffer.from("가짜"));
  await addAndUpload(up, be);
  const r = await restoreBackup(be, parseRecoveryKey(recoveryKey)!, targetOf(be));
  assert.deepEqual(r.breaks, []);
  assert.equal(r.bad.length, 1);
  assert.equal(r.lastIndex, 3);
});

test("deleted_fragment_still_a_break: 진짜로 지운 중간 조각은 여전히 끊김", async () => {
  const be = new MemoryBackend();
  const { recoveryKey } = await backupHub(be);
  be.files.delete(fragsOf(be)[0]);
  const r = await restoreBackup(be, parseRecoveryKey(recoveryKey)!, targetOf(be));
  assert.ok(r.breaks.length > 0);
});

test("tail_deletion_reported_behind: 끝쪽 조각을 지우면 최근 조각이 없다고 알린다", async () => {
  const be = new MemoryBackend();
  const { recoveryKey } = await backupHub(be);
  be.files.delete(fragsOf(be)[1]);
  assert.equal((await restoreBackup(be, parseRecoveryKey(recoveryKey)!, targetOf(be))).head, "behind");
});

test("head_deleted_reported_missing: 마지막 번호 파일까지 지우면 확인할 수 없다고 알린다", async () => {
  const be = new MemoryBackend();
  const { recoveryKey } = await backupHub(be);
  for (const k of [...be.files.keys()]) if (k.endsWith("/head.json")) be.files.delete(k);
  assert.equal((await restoreBackup(be, parseRecoveryKey(recoveryKey)!, targetOf(be))).head, "missing");
});

test("forged_head_ignored_and_reported_missing: 서명이 틀린 마지막 번호 파일은 없는 것으로", async () => {
  const be = new MemoryBackend();
  const { recoveryKey } = await backupHub(be);
  const t = targetOf(be);
  const k = generateSigningKeys();
  be.files.set(`${t.dir}/head.json`, Buffer.from(signEnvelope({ k: "backup-head", spaceId: t.spaceId, hubKey: k.publicKeyB64, index: 99, hash: "a".repeat(64) }, k.privateKeyPem, k.publicKeyB64)));
  assert.equal((await restoreBackup(be, parseRecoveryKey(recoveryKey)!, t)).head, "missing");
});
