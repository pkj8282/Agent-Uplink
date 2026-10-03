import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { InboxStore } from "./inbox.js";

function tmp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), "uplink-inbox-")); }
function item(text: string) {
  return { ts: Date.now(), channelId: "lobby", channelKind: "server" as const, channelLabel: "l", from: "u2", fromName: "B", text };
}

test("append는 계정별 seq를 1부터 증가시킨다", () => {
  const s = new InboxStore({ dir: tmp() });
  assert.equal(s.append("u1", item("x")).seq, 1);
  assert.equal(s.append("u1", item("y")).seq, 2);
  assert.equal(s.append("u9", item("z")).seq, 1); // 계정마다 독립
});

test("since는 커서 이후만, 상한까지 준다", () => {
  const s = new InboxStore({ dir: tmp() });
  for (let i = 1; i <= 5; i++) s.append("u1", item("m" + i));
  assert.deepEqual(s.since("u1", 0, 2).map((x) => x.text), ["m1", "m2"]); // 상한 2
  assert.deepEqual(s.since("u1", 2, 10).map((x) => x.text), ["m3", "m4", "m5"]);
});

test("재시작 후 seq와 내용을 복원한다", () => {
  const dir = tmp();
  const s1 = new InboxStore({ dir });
  s1.append("u1", item("영속"));
  const s2 = new InboxStore({ dir });
  assert.equal(s2.lastSeq("u1"), 1);
  assert.equal(s2.append("u1", item("다음")).seq, 2);
  assert.deepEqual(s2.since("u1", 0, 10).map((x) => x.text), ["영속", "다음"]);
});

test("compact는 소비된 항목을 버리고 seq·나머지를 유지하며 영속한다", () => {
  const dir = tmp();
  const s = new InboxStore({ dir });
  for (let i = 1; i <= 5; i++) s.append("u1", item("m" + i));
  s.compact("u1", 3); // seq<=3 제거
  assert.equal(s.size("u1"), 2);
  assert.equal(s.lastSeq("u1"), 5); // seq 카운터는 유지
  assert.deepEqual(s.since("u1", 3, 10).map((x) => x.text), ["m4", "m5"]);
  // 재시작 후에도 나머지가 복원되고 seq가 이어진다
  const s2 = new InboxStore({ dir });
  assert.deepEqual(s2.since("u1", 3, 10).map((x) => x.text), ["m4", "m5"]);
  assert.equal(s2.append("u1", item("m6")).seq, 6);
});

test("compact 후 since는 커서 오프셋을 정확히 계산한다", () => {
  const dir = tmp();
  const s = new InboxStore({ dir });
  for (let i = 1; i <= 6; i++) s.append("u1", item("m" + i));
  s.compact("u1", 2); // m1,m2 제거 → 남은 첫 seq=3
  assert.deepEqual(s.since("u1", 4, 10).map((x) => x.text), ["m5", "m6"]); // seq>4
  assert.deepEqual(s.since("u1", 2, 1).map((x) => x.text), ["m3"]); // 상한 1
});

test("remove는 인박스를 메모리와 파일에서 지운다", () => {
  const dir = tmp();
  const s = new InboxStore({ dir });
  s.append("u1", item("x"));
  assert.ok(fs.existsSync(path.join(dir, "notifications", "u1.jsonl")));
  s.remove("u1");
  assert.equal(s.lastSeq("u1"), 0); // 새 박스처럼
  assert.equal(fs.existsSync(path.join(dir, "notifications", "u1.jsonl")), false);
});
