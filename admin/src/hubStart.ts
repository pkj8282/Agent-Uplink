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
import { spawn as nodeSpawn } from "node:child_process";
import type { AdminTarget } from "./adminClient.js";
import type { LaunchInfo } from "./types.js";

export type LaunchCheck = { ok: true; plan: LaunchInfo } | { ok: false; code: "no_launch_info" | "launch_untrusted" };
export type SpawnLike = (cmd: string, args: readonly string[], opts: { shell: false; detached: true; stdio: "ignore"; windowsHide: true; env: NodeJS.ProcessEnv }) => { unref(): void; once(ev: "error", fn: (e: Error) => void): unknown };

const NODE_NAMES = new Set(["node.exe", "node"]);
const ENTRY_NAMES = new Set(["index.js", "index.ts"]);

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
  if (!Array.isArray(execArgv) || execArgv.length > 16 || !execArgv.every(clean)) return bad;
  if (!env || typeof env !== "object" || Array.isArray(env)) return bad;
  const e: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (!/^UPLINK_[A-Z0-9_]{1,64}$/.test(k) || typeof v !== "string" || v.length > 4096 || v.includes("\u0000")) return bad;
    e[k] = v;
  }
  return { ok: true, plan: { execPath, execArgv: execArgv as string[], entry, env: e } };
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
export function startHub(target: AdminTarget, deps: { spawn?: SpawnLike; isUp?: () => Promise<boolean> } = {}): Promise<{ ok: true; started: boolean } | { ok: false; code: string }> {
  const dataDir = target.dataDir ?? path.dirname(target.keyPath);
  const running = inflight.get(dataDir);
  if (running) return running;
  const p = (async () => {
    if (await (deps.isUp ?? (() => tcpUp(target.port)))()) return { ok: true as const, started: false };
    const c = checkLaunch(dataDir);
    if (!c.ok) return { ok: false as const, code: c.code };
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("ELECTRON_")) env[k] = v;
    Object.assign(env, c.plan.env);
    const child = (deps.spawn ?? (nodeSpawn as unknown as SpawnLike))(c.plan.execPath, [...c.plan.execArgv, c.plan.entry], { shell: false, detached: true, stdio: "ignore", windowsHide: true, env });
    child.once("error", () => { /* 실행 실패는 다음 새로고침에서 Hub 꺼짐으로 보인다 */ });
    child.unref();
    return { ok: true as const, started: true };
  })().finally(() => inflight.delete(dataDir));
  inflight.set(dataDir, p);
  return p;
}
