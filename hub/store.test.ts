import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MessageStore } from "./store.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "uplink-store-"));
}

test("append는 seq를 1부터 단조 증가시킨다", () => {
  const store = new MessageStore({ dir: tmpDir() });
  const a = store.append("A", null, "첫번째");
  const b = store.append("B", null, "두번째");
  assert.equal(a.seq, 1);
  assert.equal(b.seq, 2);
  assert.equal(store.lastSeq, 2);
});

test("since는 커서 이후, 대상 일치, 자기 메시지 제외로 필터한다", () => {
  const store = new MessageStore({ dir: tmpDir() });
  store.append("B", null, "전체1"); // seq1: B의 전체 → A가 받음
  store.append("B", "A", "A에게"); // seq2: B→A → A가 받음
  store.append("B", "C", "C에게"); // seq3: B→C → A 제외
  store.append("A", null, "A자신전체"); // seq4: from==A → A 자신 제외
  const forA = store.since(0, "A");
  assert.deepEqual(forA.map((m) => m.text), ["전체1", "A에게"]);
});

test("링버퍼 크기를 넘으면 오래된 메시지를 버린다", () => {
  const store = new MessageStore({ dir: tmpDir(), ringSize: 3 });
  for (let i = 1; i <= 5; i++) store.append("A", null, `m${i}`);
  const recent = store.recent(10);
  assert.deepEqual(recent.map((m) => m.text), ["m3", "m4", "m5"]);
});

test("JSONL을 다시 읽어 seq와 최근 메시지를 복원한다", () => {
  const dir = tmpDir();
  const s1 = new MessageStore({ dir });
  s1.append("A", null, "영속1");
  s1.append("A", null, "영속2");
  const s2 = new MessageStore({ dir });
  assert.equal(s2.lastSeq, 2); // seq 이어감
  assert.equal(s2.recent(10).length, 2);
  assert.equal(s2.append("A", null, "영속3").seq, 3);
});

test("손상된 JSONL 줄은 건너뛰고 나머지를 복원한다", () => {
  const dir = tmpDir();
  const file = path.join(dir, "messages.jsonl");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({ seq: 1, ts: 1, from: "A", to: null, text: "정상" }) + "\n" +
      "{깨진 JSON\n" +
      JSON.stringify({ seq: 2, ts: 2, from: "B", to: null, text: "정상2" }) + "\n",
  );
  const store = new MessageStore({ dir });
  assert.equal(store.lastSeq, 2);
  assert.deepEqual(store.recent(10).map((m) => m.text), ["정상", "정상2"]);
});
