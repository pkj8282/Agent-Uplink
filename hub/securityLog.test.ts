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

test("미리보기 경계에 이모지가 걸려도 숨은 문자가 남지 않고, 디스크 중복 판정이 재시작 후에도 맞다(최종 리뷰 ③)", () => {
  const dir = tempDir("uplink-seclog-");
  const family = cps(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467);
  const s = `${cps(0x200b)}${"x".repeat(70)}${family}${family}${family}`;
  for (let i = 0; i < 3; i++) new SecurityLog({ dir }).guard(s, DISK);
  const r = new SecurityLog({ dir }).recent(100);
  assert.equal(r.length, 1);
  assert.equal(inspectText(r[0].preview).changed, false);
});

// ── v2.1.3 RT41: 디스크 중복 제거가 최근 max건 밖에서도 맞는다(설계 ②) ──
const ZW = cps(0x200b);
/** Hub 시작 한 번: 옛 데이터 n건을 디스크 출처로 읽고 시작 스캔을 끝낸다. */
function startOnce(dir: string, n: number, max = 500): SecurityLog {
  const log = new SecurityLog({ dir, max });
  for (let i = 0; i < n; i++) log.guard(`old${i}${ZW}`, { ...DISK, account: `u${i}` });
  log.finishStartupScan();
  return log;
}

test("RT41: 서로 다른 옛 데이터 발견 600건 — 다시 시작해도 다시 기록하지 않고 요청 기록(실제 공격)을 밀어내지 않는다", () => {
  const dir = tempDir("uplink-seclog-");
  const first = startOnce(dir, 600);
  first.guard(`attack${ZW}`, REQ);
  const linesBefore = fs.readFileSync(fileOf(dir), "utf8").split("\n").filter(Boolean).length;
  const second = startOnce(dir, 600);
  assert.equal(second.recent(500).some((f) => f.source === "request" && f.preview.startsWith("attack")), true);
  assert.equal(fs.readFileSync(fileOf(dir), "utf8").split("\n").filter(Boolean).length, linesBefore);
});

test("RT41: disk-seen.json이 깨져 있어도 시작은 되고, 기록에 남은 디스크 발견으로 중복을 막는다", () => {
  const dir = tempDir("uplink-seclog-");
  startOnce(dir, 3);
  fs.writeFileSync(path.join(dir, "security", "disk-seen.json"), "{깨짐");
  const again = startOnce(dir, 3);
  assert.equal(again.recent(100).length, 3);
});

test("RT41: 키는 seenMax개까지 — 가장 오래 보지 않은 키부터 빠지고, 다시 본 키는 남는다", () => {
  const dir = tempDir("uplink-seclog-");
  const at = (i: number) => ({ ...DISK, account: `u${i}` });
  const log = new SecurityLog({ dir, seenMax: 3 });
  for (const i of [0, 1, 2, 0, 3]) log.guard(`old${i}${ZW}`, at(i)); // 1이 가장 오래 안 본 키
  log.finishStartupScan();
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "security", "disk-seen.json"), "utf8")).keys.length, 3);
  fs.rmSync(fileOf(dir)); // 기록 파일 없이 disk-seen.json만으로 판정되는지 본다
  const again = new SecurityLog({ dir, seenMax: 3 });
  for (const i of [0, 2, 3]) again.guard(`old${i}${ZW}`, at(i));
  assert.equal(again.recent(100).length, 0);
  again.guard(`old1${ZW}`, at(1)); // 빠진 키는 다시 기록된다
  assert.equal(again.recent(100).length, 1);
});

test("RT41: 시작 스캔 뒤 새 디스크 발견(받은편지함·휴지통 복원 등)도 키를 저장해 다음 시작에 다시 기록하지 않는다", async () => {
  const dir = tempDir("uplink-seclog-");
  const log = startOnce(dir, 1);
  log.guard(`restored${ZW}`, { ...DISK, where: "log", field: "text", account: "u9" });
  await new Promise((r) => setImmediate(r)); // 저장은 지금 하는 일이 끝난 뒤 한 번에
  fs.rmSync(fileOf(dir)); // 기록 파일 없이 disk-seen.json만으로 판정되는지 본다
  const again = new SecurityLog({ dir });
  again.guard(`old0${ZW}`, { ...DISK, account: "u0" });
  again.guard(`restored${ZW}`, { ...DISK, where: "log", field: "text", account: "u9" });
  again.finishStartupScan();
  assert.equal(again.recent(100).length, 0);
});

test("RT41: 시작 뒤 새 디스크 발견이 많아도(키 19,000개 + 새 1,000건) disk-seen.json 저장은 한 번으로 묶인다", async () => {
  const dir = tempDir("uplink-seclog-");
  fs.mkdirSync(path.join(dir, "security"), { recursive: true });
  const keys = Array.from({ length: 19000 }, (_, i) => i.toString(16).padStart(32, "0"));
  fs.writeFileSync(path.join(dir, "security", "disk-seen.json"), JSON.stringify({ v: 1, keys }));
  const log = new SecurityLog({ dir });
  log.finishStartupScan();
  // 키마다 0.7MB 파일 전체를 다시 쓰면 이벤트 루프가 몇 초 멈춘다 — 시간 대신 저장 횟수를 센다(부하에 흔들리지 않게).
  let saves = 0;
  const rename = fs.renameSync;
  fs.renameSync = ((a: fs.PathLike, b: fs.PathLike) => {
    if (String(b).endsWith("disk-seen.json")) saves++;
    return rename(a, b);
  }) as typeof fs.renameSync;
  try {
    for (let i = 0; i < 1000; i++) log.guard(`late${i}${ZW}`, { ...DISK, where: "inbox", field: "text", account: "u1" });
    await new Promise((r) => setImmediate(r));
  } finally {
    fs.renameSync = rename;
  }
  assert.equal(saves, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "security", "disk-seen.json"), "utf8")).keys.length, 20000);
});
