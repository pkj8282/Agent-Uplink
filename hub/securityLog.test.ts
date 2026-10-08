// v2.1.2 감독 기록(설계 Part C2): 발견이 있을 때만 기록, 상한 유지, 디스크 출처 중복 방지.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { SecurityLog, plainGuard } from "./securityLog.js";
import { inspectText } from "../shared/controlChars.js";
import { tempDir } from "./testing.js";

const B = String.fromCharCode(92);
const LF = String.fromCharCode(10);
const cps = (...cs: number[]) => String.fromCodePoint(...cs);
const REQ = { source: "request" as const, where: "set_name", field: "name", account: "u1" };
const DISK = { source: "disk" as const, where: "accounts", field: "name", account: "u1" };
const fileOf = (dir: string) => path.join(dir, "security", "findings.jsonl");

test("발견이 없으면 원문을 돌려주고 기록하지 않는다(정상 이모지 포함)", () => {
  const log = new SecurityLog({ dir: tempDir("uplink-seclog-") });
  const s = `평범한 이름 ${cps(0x2764, 0xfe0f)}`;
  assert.equal(log.guard(s, REQ), s);
  assert.deepEqual(log.recent(10), []);
});

test("발견하면 이스케이프한 값을 돌려주고 출처·위치·항목·계정·종류별 개수·미리보기(이스케이프, 80자)를 기록한다", () => {
  const log = new SecurityLog({ dir: tempDir("uplink-seclog-") });
  const out = log.guard(`A${cps(0xe0041)}${"x".repeat(100)}`, REQ);
  assert.equal(out, `A${B}u{E0041}${"x".repeat(100)}`);
  const [f] = log.recent(10);
  assert.equal(f.source, "request"); assert.equal(f.where, "set_name"); assert.equal(f.field, "name"); assert.equal(f.account, "u1");
  assert.deepEqual(f.counts, { tag: 1 });
  assert.equal([...f.preview].length, 80);
  assert.equal(f.preview.startsWith(`A${B}u{E0041}`), true);
  assert.equal(inspectText(f.preview).changed, false);
  assert.equal(typeof f.ts, "number");
});

test("최근 max건만 유지하고 파일 줄은 2배를 넘지 않으며, 다시 열어도 남아 있다", () => {
  const dir = tempDir("uplink-seclog-");
  const log = new SecurityLog({ dir, max: 5 });
  for (let i = 0; i < 20; i++) log.guard(`n${i}${cps(0x200b)}`, REQ);
  const r = log.recent(100);
  assert.equal(r.length, 5);
  assert.equal(r[r.length - 1].preview, `n19${B}u{200B}`);
  assert.ok(fs.readFileSync(fileOf(dir), "utf8").split(LF).filter(Boolean).length <= 10);
  assert.equal(new SecurityLog({ dir, max: 5 }).recent(100).length, 5);
});

test("디스크 출처는 같은 (위치·항목·계정·미리보기)를 다시 기록하지 않는다 — 요청 출처는 매번 기록", () => {
  const dir = tempDir("uplink-seclog-");
  const log = new SecurityLog({ dir });
  const s = `A${cps(0x200b)}`;
  log.guard(s, DISK); log.guard(s, DISK);
  new SecurityLog({ dir }).guard(s, DISK); // Hub 재시작
  log.guard(s, REQ); log.guard(s, REQ);
  const r = new SecurityLog({ dir }).recent(100);
  assert.equal(r.filter((f) => f.source === "disk").length, 1);
  assert.equal(r.filter((f) => f.source === "request").length, 2);
});

test("손상 줄·형식 밖 줄은 무시하고, 파일 속 미리보기에 숨은 문자가 있으면 정리해 읽는다", () => {
  const dir = tempDir("uplink-seclog-");
  fs.mkdirSync(path.join(dir, "security"), { recursive: true });
  const ok = { ts: 1, source: "disk", where: "accounts", field: "name", counts: { tag: 1 }, preview: `x${cps(0xe0041)}` };
  fs.writeFileSync(fileOf(dir), ["not json", JSON.stringify({ ts: "x" }), JSON.stringify(ok)].join(LF) + LF);
  const r = new SecurityLog({ dir }).recent(10);
  assert.equal(r.length, 1);
  assert.equal(r[0].preview, `x${B}u{E0041}`);
});

test("plainGuard는 기록 없이 정리만 한다(본문이면 줄바꿈 유지)", () => {
  assert.equal(plainGuard(`a${LF}b${cps(0x200b)}`, { ...DISK, keepLineBreaks: true }), `a${LF}b${B}u{200B}`);
  assert.equal(plainGuard(`a${LF}b`, DISK), `a${B}nb`);
});
