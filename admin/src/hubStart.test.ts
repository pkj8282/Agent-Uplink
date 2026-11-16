import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { freePort, tempDir } from "../../hub/testing.js";
import { AdminClient } from "./adminClient.js";
import { checkLaunch, startHub, type SpawnLike } from "./hubStart.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const HUB_ENTRY_TS = path.join(REPO, "hub", "index.ts");

/** 시험 데이터 폴더: hub.json + (marker면) Hub가 잠근 표식 secured.json. */
function dirWith(launch: unknown, raw?: string, marker = false): string {
  const d = tempDir("uplink-hubstart-");
  fs.writeFileSync(path.join(d, "hub.json"), raw ?? JSON.stringify({ tcpPort: 1, httpPort: 2, pid: 1, startedAt: 0, ...(launch === undefined ? {} : { launch }) }));
  if (marker) fs.writeFileSync(path.join(d, "secured.json"), "{}");
  return d;
}
const good = (over: object = {}) => ({ execPath: process.execPath, execArgv: ["--import", "tsx"], entry: HUB_ENTRY_TS, env: { UPLINK_IDLE_MINUTES: "0.05" }, ...over });

/** 가짜 spawn: 받은 인자를 기록하고 아무것도 실행하지 않는다. */
function fakeSpawn() {
  const calls: { cmd: string; args: string[]; opts: any }[] = [];
  const spawn: SpawnLike = (cmd, args, opts) => { calls.push({ cmd, args: [...args], opts }); return { unref() { /* 없음 */ }, once() { /* 없음 */ } } as any; };
  return { calls, spawn };
}
const target = (dataDir: string, port = 1) => ({ port, keyPath: path.join(dataDir, "admin.key"), dataDir });

test("check_launch_missing_file_is_no_launch_info: hub.json이 없거나 launch가 없으면(옛 Hub) no_launch_info", () => {
  assert.deepEqual(checkLaunch(tempDir("uplink-hubstart-")), { ok: false, code: "no_launch_info" });
  assert.deepEqual(checkLaunch(dirWith(undefined)), { ok: false, code: "no_launch_info" });
});

test("check_launch_rejects_corrupt_json: 손상된 hub.json은 믿지 않는다", () => {
  assert.deepEqual(checkLaunch(dirWith(undefined, "{ not json")), { ok: false, code: "launch_untrusted" });
  assert.deepEqual(checkLaunch(dirWith("문자열")), { ok: false, code: "launch_untrusted" });
  assert.deepEqual(checkLaunch(dirWith(good({ execArgv: "--import tsx" }))), { ok: false, code: "launch_untrusted" });
});

test("check_launch_rejects_non_node_exec: node가 아닌 실행 파일(cmd·powershell·electron)은 거부", () => {
  const sysDir = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32");
  for (const exe of [path.join(sysDir, "cmd.exe"), path.join(sysDir, "WindowsPowerShell", "v1.0", "powershell.exe")]) {
    assert.deepEqual(checkLaunch(dirWith(good({ execPath: exe }))), { ok: false, code: "launch_untrusted" }, exe);
  }
  const fakeElectron = path.join(tempDir("uplink-hubstart-"), "electron.exe");
  fs.writeFileSync(fakeElectron, "");
  assert.deepEqual(checkLaunch(dirWith(good({ execPath: fakeElectron }))), { ok: false, code: "launch_untrusted" });
});

test("check_launch_rejects_relative_or_missing_paths: 상대 경로·없는 파일·hub/index가 아닌 진입 파일은 거부", () => {
  for (const over of [
    { execPath: "node.exe" },
    { execPath: path.join(tempDir("uplink-hubstart-"), "node.exe") }, // 없는 파일
    { entry: "hub/index.ts" },
    { entry: path.join(REPO, "hub", "nope", "index.js") },
    { entry: path.join(REPO, "hub", "server.ts") }, // hub/index가 아님
    { entry: path.join(REPO, "cli", "index.ts") },
  ]) assert.deepEqual(checkLaunch(dirWith(good(over))), { ok: false, code: "launch_untrusted" }, JSON.stringify(over));
  const ok = checkLaunch(dirWith(good(), undefined, true));
  assert.equal(ok.ok, true);
});

test("check_launch_rejects_foreign_env_keys: UPLINK_가 아닌 env 키(NODE_OPTIONS 등)·NUL 문자는 거부", () => {
  assert.deepEqual(checkLaunch(dirWith(good({ env: { NODE_OPTIONS: "--require evil.js" } }))), { ok: false, code: "launch_untrusted" });
  assert.deepEqual(checkLaunch(dirWith(good({ env: { UPLINK_X: "a\u0000b" } }))), { ok: false, code: "launch_untrusted" });
  assert.deepEqual(checkLaunch(dirWith(good({ execArgv: ["--import", "tsx\u0000"] }))), { ok: false, code: "launch_untrusted" });
  assert.deepEqual(checkLaunch(dirWith(good({ env: { UPLINK_X: 5 } }))), { ok: false, code: "launch_untrusted" });
});

test("start_hub_uses_arg_array_without_shell: 셸 없이 인자 배열로, 진입 파일 이름의 특수 문자도 한 인자", async () => {
  const weird = path.join(tempDir("uplink-hubstart-"), "a & calc", "hub");
  fs.mkdirSync(weird, { recursive: true });
  const entry = path.join(weird, "index.js");
  fs.writeFileSync(entry, "");
  const d = dirWith(good({ entry, env: { UPLINK_TCP_PORT: "47999" } }), undefined, true);
  const f = fakeSpawn();
  const r = await startHub(target(d), { spawn: f.spawn, isUp: async () => false, owners: async () => true });
  assert.deepEqual(r, { ok: true, started: true });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].cmd, process.execPath);
  assert.deepEqual(f.calls[0].args, ["--import", "tsx", entry]);
  assert.equal(f.calls[0].opts.shell, false);
  assert.equal(f.calls[0].opts.detached, true);
  assert.equal(f.calls[0].opts.windowsHide, true);
  assert.equal(f.calls[0].opts.env.UPLINK_TCP_PORT, "47999");
  for (const k of Object.keys(f.calls[0].opts.env)) assert.equal(k.startsWith("ELECTRON_"), false, k);
});

test("start_hub_skips_when_already_up: Hub가 이미 떠 있으면 다시 띄우지 않는다", async () => {
  const f = fakeSpawn();
  assert.deepEqual(await startHub(target(dirWith(good())), { spawn: f.spawn, isUp: async () => true }), { ok: true, started: false });
  assert.equal(f.calls.length, 0);
});

test("start_hub_untrusted_does_not_spawn: 믿을 수 없는 실행 정보면 실행하지 않고 코드를 돌려준다", async () => {
  const f = fakeSpawn();
  assert.deepEqual(await startHub(target(dirWith(good({ execPath: "node.exe" }))), { spawn: f.spawn, isUp: async () => false }), { ok: false, code: "launch_untrusted" });
  assert.deepEqual(await startHub(target(tempDir("uplink-hubstart-")), { spawn: f.spawn, isUp: async () => false }), { ok: false, code: "no_launch_info" });
  assert.equal(f.calls.length, 0);
});

test("start_hub_twice_spawns_once: 동시에 두 번 눌러도 한 번만 띄운다", async () => {
  const d = dirWith(good(), undefined, true);
  const f = fakeSpawn();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const isUp = async () => { await gate; return false; };
  const p1 = startHub(target(d), { spawn: f.spawn, isUp, owners: async () => true });
  const p2 = startHub(target(d), { spawn: f.spawn, isUp, owners: async () => true });
  release();
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(f.calls.length, 1);
  assert.deepEqual([r1.ok, r2.ok], [true, true]);
});

test("start_hub_real_spawn_reaches_hello: 실행 정보로 실제 Hub를 띄우면 관리 접속이 된다", async () => {
  const d = tempDir("uplink-hubstart-real-");
  const port = await freePort();
  fs.writeFileSync(path.join(d, "secured.json"), "{}"); // 실제 소유자 검사(PowerShell)를 거친다 — 내가 만든 폴더
  fs.writeFileSync(path.join(d, "hub.json"), JSON.stringify({ launch: good({ env: { UPLINK_DATA_DIR: d, UPLINK_TCP_PORT: String(port), UPLINK_HTTP_PORT: String(await freePort()), UPLINK_IDLE_MINUTES: "0.05" } }) }));
  const probe = () => new Promise<boolean>((res) => { const s = net.connect(port, "127.0.0.1"); s.once("connect", () => { s.destroy(); res(true); }); s.once("error", () => res(false)); });
  const r = await startHub(target(d, port), { isUp: probe });
  assert.deepEqual(r, { ok: true, started: true });
  let pid = 0;
  try {
    const c = new AdminClient({ port, keyPath: path.join(d, "admin.key"), clientKeyPath: path.join(d, "client.key"), dataDir: d, timeoutMs: 3000 });
    let snap: any = null;
    for (let i = 0; i < 100 && !snap; i++) {
      try { snap = await c.snapshot(); } catch { await new Promise((res) => setTimeout(res, 100)); }
    }
    assert.ok(snap, "관리 스냅샷을 받아야 함");
    for (let i = 0; i < 50 && !pid; i++) {
      try { pid = JSON.parse(fs.readFileSync(path.join(d, "hub.json"), "utf8")).pid ?? 0; } catch { /* 쓰는 중 */ }
      if (!pid) await new Promise((res) => setTimeout(res, 50));
    }
    assert.ok(pid > 0);
    assert.equal((await startHub(target(d, port), { isUp: probe })).ok, true); // 떠 있으니 started: false
  } finally {
    if (pid) try { process.kill(pid); } catch { /* 이미 종료 */ }
  }
});

// ───── v3.1 최종 리뷰 Critical: 남이 만든 hub.json·실행 인자 막기 ─────
import { ownersTrusted } from "./hubStart.js";
const securedDir = (launch: unknown) => dirWith(launch, undefined, true);

test("check_launch_rejects_exec_argv_not_allowlisted: 실행 인자는 없음 또는 --import tsx만(-e·--require·--inspect 거부)", () => {
  for (const argv of [["-e", "require('child_process').exec('calc')"], ["--require", "evil.js"], ["--inspect=0.0.0.0:9229"], ["--import", "./evil.mjs"], ["--import", "tsx", "--inspect"]]) {
    assert.deepEqual(checkLaunch(securedDir(good({ execArgv: argv }))), { ok: false, code: "launch_untrusted" }, JSON.stringify(argv));
  }
  assert.equal(checkLaunch(securedDir(good({ execArgv: [] }))).ok, true);
  assert.equal(checkLaunch(securedDir(good())).ok, true);
});

test("check_launch_requires_secured_marker: Hub가 잠근 적 없는 폴더(secured.json 없음)의 hub.json은 믿지 않는다", () => {
  assert.deepEqual(checkLaunch(dirWith(good())), { ok: false, code: "launch_untrusted" });
});

test("start_hub_rejects_foreign_owner: 데이터 폴더·hub.json·표식의 소유자가 나·관리자·SYSTEM이 아니면 실행하지 않는다", async () => {
  const d = securedDir(good());
  const f = fakeSpawn();
  const seen: string[][] = [];
  const r = await startHub(target(d), { spawn: f.spawn, isUp: async () => false, owners: async (p) => { seen.push(p); return false; } });
  assert.deepEqual(r, { ok: false, code: "launch_untrusted" });
  assert.equal(f.calls.length, 0);
  assert.deepEqual(seen[0].map((p) => path.basename(p)).sort(), [path.basename(d), "hub.json", "secured.json"].sort());
});

test("start_hub_sets_cwd_to_entry_dir: Hub는 진입 파일 폴더에서 실행(관리 앱 임시 폴더를 잡지 않게)", async () => {
  const d = securedDir(good());
  const f = fakeSpawn();
  assert.deepEqual(await startHub(target(d), { spawn: f.spawn, isUp: async () => false, owners: async () => true }), { ok: true, started: true });
  assert.equal(f.calls[0].opts.cwd, path.dirname(HUB_ENTRY_TS));
});

test("owners_trusted_real_check: 내가 만든 폴더·파일은 믿고(Windows), 없는 경로는 믿지 않는다", async (t) => {
  if (process.platform !== "win32") { t.skip("Windows 전용"); return; }
  const d = securedDir(good());
  assert.equal(await ownersTrusted([d, path.join(d, "hub.json"), path.join(d, "secured.json")]), true);
  assert.equal(await ownersTrusted([path.join(d, "nope.json")]), false);
});
