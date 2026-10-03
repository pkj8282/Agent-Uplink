import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DmStore } from "./dm.js";

function tmp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), "uplink-dm-")); }

test("create는 채널ID를 부여하고 findByPair로 순서 무관하게 찾는다", () => {
  const s = new DmStore({ dir: tmp() });
  const rec = s.create("u1", "u2", "A-B");
  assert.ok(rec.channelId.length > 0);
  assert.equal(s.findByPair("u1", "u2")!.channelId, rec.channelId);
  assert.equal(s.findByPair("u2", "u1")!.channelId, rec.channelId); // 순서 무관
});

test("없는 쌍은 undefined", () => {
  const s = new DmStore({ dir: tmp() });
  assert.equal(s.findByPair("u1", "u2"), undefined);
});

test("재시작 후 dm/index.json에서 복원된다", () => {
  const dir = tmp();
  const s1 = new DmStore({ dir });
  const rec = s1.create("u1", "u2", "A-B");
  const s2 = new DmStore({ dir });
  assert.equal(s2.get(rec.channelId)!.label, "A-B");
  assert.equal(s2.findByPair("u1", "u2")!.channelId, rec.channelId);
  assert.equal(s2.all().length, 1);
});
