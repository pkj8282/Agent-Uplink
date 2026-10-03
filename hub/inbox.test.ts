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
