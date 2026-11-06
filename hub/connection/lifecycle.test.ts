import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tempDir } from "../testing.js";
import { Lifecycle } from "./lifecycle.js";

const fileIn = () => path.join(tempDir("uplink-life-"), "connection", "lifecycle.jsonl");

test("first_run_is_unknown: 기록이 없으면 null(처음 가동)", () => {
  const f = fileIn();
  assert.equal(new Lifecycle(f).lastRunClean(), null);
  assert.equal(fs.existsSync(f), false); // 읽기만으로는 만들지 않음
});

test("clean_then_start_is_clean: 시작 → 정상 종료 → 다음 가동은 정상", () => {
  const f = fileIn();
  const l = new Lifecycle(f);
  l.recordStart(1);
  l.recordCleanStop(2, { nextIndex: 3, lastHash: "ab" });
  assert.equal(new Lifecycle(f).lastRunClean(), true);
  const last = JSON.parse(fs.readFileSync(f, "utf8").trim().split("\n").at(-1)!);
  assert.deepEqual(last, { e: "clean_stop", ts: 2, nextIndex: 3, lastHash: "ab" });
});

test("start_without_stop_is_unclean: 시작 기록만 있으면 비정상 종료", () => {
  const f = fileIn();
  new Lifecycle(f).recordStart(1);
  assert.equal(new Lifecycle(f).lastRunClean(), false);
});

test("torn_report_is_unclean: 보고를 쓰다 꺼져 줄이 깨졌으면 비정상(안전한 쪽)", () => {
  const f = fileIn();
  const l = new Lifecycle(f);
  l.recordStart(1);
  fs.appendFileSync(f, '{"e":"clean_st');
  assert.equal(new Lifecycle(f).lastRunClean(), false);
  // 깨진 줄 뒤에도 다음 기록은 새 줄로 이어진다
  const l2 = new Lifecycle(f);
  l2.recordStart(5);
  l2.recordCleanStop(6, { nextIndex: 0, lastHash: "" });
  assert.equal(new Lifecycle(f).lastRunClean(), true);
});

test("keeps_last_1000: 기록은 최근 1,000줄만", () => {
  const f = fileIn();
  const l = new Lifecycle(f);
  for (let i = 0; i < 1100; i++) { l.recordStart(i); l.recordCleanStop(i, { nextIndex: 0, lastHash: "" }); }
  l.recordStart(9999);
  const lines = fs.readFileSync(f, "utf8").trim().split("\n");
  assert.ok(lines.length <= 1000, String(lines.length));
  assert.equal(JSON.parse(lines.at(-1)!).ts, 9999);
});
