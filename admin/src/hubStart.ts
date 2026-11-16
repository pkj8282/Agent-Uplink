/**
 * Hub 수동 시작(v3.1). Hub가 켜질 때 데이터 폴더의 hub.json에 적은 실행 정보(launch)로
 * MCP가 띄우던 것과 같은 방식(node + Hub 진입 파일, detached)으로 다시 띄운다.
 *
 * 위협 모델: admin.key와 같다 — 데이터 폴더는 Hub가 소유자 전용으로 잠근다. 다른 Windows 사용자·권한 낮은
 * 프로세스가 바꿔치기한 값은 아래 검사로 거른다. 같은 사용자로 도는 악성 프로세스는 이미 admin.key를 읽을 수 있어 범위 밖.
 */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { execFile, spawn as nodeSpawn } from "node:child_process";
import type { AdminTarget } from "./adminClient.js";
import type { LaunchInfo } from "./types.js";

export type LaunchCheck = { ok: true; plan: LaunchInfo } | { ok: false; code: "no_launch_info" | "launch_untrusted" };
export type SpawnLike = (cmd: string, args: readonly string[], opts: { shell: false; detached: true; stdio: "ignore"; windowsHide: true; env: NodeJS.ProcessEnv; cwd: string }) => { unref(): void; once(ev: "error", fn: (e: Error) => void): unknown };

const NODE_NAMES = new Set(["node.exe", "node"]);
const ENTRY_NAMES = new Set(["index.js", "index.ts"]);
/** 허용하는 node 실행 인자: 없음(배포본 — MCP가 띄우는 모양) 또는 --import tsx(저장소에서 tsx로 돌릴 때)뿐. */
const ALLOWED_ARGV: readonly (readonly string[])[] = [[], ["--import", "tsx"]];
/** Hub가 데이터 폴더를 잠근 뒤 남기는 표식(hub/secure.ts의 MARKER_FILE). */
const MARKER = "secured.json";
/** 데이터 폴더 항목의 소유자로 인정하는 SID: 나 + Administrators + SYSTEM(hub/secure.ts의 ALLOWED_OWNER_SIDS와 같음). */
const OWNER_SIDS = ["S-1-5-32-544", "S-1-5-18"];

function isFile(p: string): boolean {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}
const clean = (s: unknown): s is string => typeof s === "string" && s.length > 0 && s.length <= 4096 && !s.includes("\u0000");

/** hub.json의 실행 정보를 읽고 믿을 수 있는지 검사한다(실행하지 않음). */
export function checkLaunch(dataDir: string): LaunchCheck {
  let raw: string;
  try { raw = fs.readFileSync(path.join(dataDir, "hub.json"), "utf8"); } catch { return { ok: false, code: "no_launch_info" }; }
  let j: unknown;
  try { j = JSON.parse(raw); } catch { return { ok: false, code: "launch_untrusted" }; }
  if (!j || typeof j !== "object") return { ok: false, code: "launch_untrusted" };
  const l = (j as { launch?: unknown }).launch;
  if (l === undefined) return { ok: false, code: "no_launch_info" }; // 옛 Hub(3.0.x)는 적지 않는다
  const bad = { ok: false, code: "launch_untrusted" } as const;
  if (!l || typeof l !== "object") return bad;
  const { execPath, execArgv, entry, env } = l as Record<string, unknown>;
  if (!clean(execPath) || !path.isAbsolute(execPath) || !NODE_NAMES.has(path.basename(execPath).toLowerCase()) || !isFile(execPath)) return bad;
  if (!clean(entry) || !path.isAbsolute(entry) || !ENTRY_NAMES.has(path.basename(entry).toLowerCase()) || path.basename(path.dirname(entry)).toLowerCase() !== "hub" || !isFile(entry)) return bad;
  if (!Array.isArray(execArgv) || !ALLOWED_ARGV.some((a) => a.length === execArgv.length && a.every((x, i) => x === execArgv[i]))) return bad;
  if (!isFile(path.join(dataDir, MARKER))) return bad; // Hub가 이 폴더를 잠근 적이 없다(남이 먼저 만든 폴더일 수 있음)
  if (!env || typeof env !== "object" || Array.isArray(env)) return bad;
  const e: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (!/^UPLINK_[A-Z0-9_]{1,64}$/.test(k) || typeof v !== "string" || v.length > 4096 || v.includes("\u0000")) return bad;
    e[k] = v;
  }
  return { ok: true, plan: { execPath, execArgv: execArgv as string[], entry, env: e } };
}

/**
 * 경로들의 소유자가 모두 나·Administrators·SYSTEM인가(Windows: Get-Acl, Hub의 보안 준비와 같은 규칙).
 * 다른 Windows 사용자가 Hub보다 먼저 데이터 폴더·hub.json을 만들어 둔 경우를 막는다. 읽을 수 없으면 false.
 */
export function ownersTrusted(paths: string[]): Promise<boolean> {
  if (process.platform !== "win32") {
    try { return Promise.resolve(paths.every((p) => fs.statSync(p).uid === process.getuid?.())); } catch { return Promise.resolve(false); }
  }
  const script = [
    "$ErrorActionPreference='Stop'",
    "$me=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    "$ok=@($me," + OWNER_SIDS.map((x) => `'${x}'`).join(",") + ")",
    "$sid=[System.Security.Principal.SecurityIdentifier]",
    "foreach($p in $args){ $o=(Get-Acl -LiteralPath $p).GetOwner($sid).Value; if(-not ($ok -contains $o)){ 'no'; exit 0 } }",
    "'yes'",
  ].join("; ");
  return new Promise((res) => {
    // PSModulePath를 비워 PS7 모듈이 끼어들지 않게(hub/secure.ts withoutPsModulePath와 같은 이유)
    const env = { ...process.env };
    delete env.PSModulePath;
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `& { ${script} }`, ...paths], { windowsHide: true, timeout: 15_000, env }, (err, out) => {
      res(!err && String(out).trim() === "yes");
    });
  });
}

/** 수동 시작을 할 수 있는가(실행하지 않음): 형식 검사 + 소유자 검사. */
export async function launchStatus(dataDir: string, owners: (paths: string[]) => Promise<boolean> = ownersTrusted): Promise<LaunchCheck> {
  const c = checkLaunch(dataDir);
  if (!c.ok) return c;
  return (await owners([dataDir, path.join(dataDir, "hub.json"), path.join(dataDir, MARKER)])) ? c : { ok: false, code: "launch_untrusted" };
}

/** 그 포트에 무엇이 듣고 있는가(Hub가 이미 떠 있는가). */
export function tcpUp(port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((res) => {
    const s = net.connect(port, "127.0.0.1");
    const done = (v: boolean) => { clearTimeout(t); s.destroy(); res(v); };
    const t = setTimeout(() => done(false), timeoutMs);
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

const inflight = new Map<string, Promise<{ ok: true; started: boolean } | { ok: false; code: string }>>();

/** Hub를 띄운다. 이미 떠 있으면 started: false. 같은 데이터 폴더로 동시에 부르면 한 번만 실행한다. */
export function startHub(target: AdminTarget, deps: { spawn?: SpawnLike; isUp?: () => Promise<boolean>; owners?: (paths: string[]) => Promise<boolean> } = {}): Promise<{ ok: true; started: boolean } | { ok: false; code: string }> {
  const dataDir = target.dataDir ?? path.dirname(target.keyPath);
  const running = inflight.get(dataDir);
  if (running) return running;
  const p = (async () => {
    if (await (deps.isUp ?? (() => tcpUp(target.port)))()) return { ok: true as const, started: false };
    const c = await launchStatus(dataDir, deps.owners);
    if (!c.ok) return { ok: false as const, code: c.code };
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("ELECTRON_")) env[k] = v;
    Object.assign(env, c.plan.env);
    const child = (deps.spawn ?? (nodeSpawn as unknown as SpawnLike))(c.plan.execPath, [...c.plan.execArgv, c.plan.entry], { shell: false, detached: true, stdio: "ignore", windowsHide: true, env, cwd: path.dirname(c.plan.entry) });
    child.once("error", () => { /* 실행 실패는 다음 새로고침에서 Hub 꺼짐으로 보인다 */ });
    child.unref();
    return { ok: true as const, started: true };
  })().finally(() => inflight.delete(dataDir));
  inflight.set(dataDir, p);
  return p;
}
