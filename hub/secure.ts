// Hub 보안 준비: 데이터 폴더를 현재 사용자 전용으로 잠그고(ACL), 다른 사용자가 만든 항목이 없는지 확인한 뒤 키를 만든다.
// 이 준비가 끝나기 전에는 hello에 답하지 않는다(server.ts). 실패하면 경고만 하고 넘어가지 않는다(fail-closed).
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { restrictDataDirAcl, currentUserSid } from "./acl.js";
import { writeSecretFile } from "./fsutil.js";
import { hubMsg } from "./messages.js";
import type { Lang } from "../shared/i18n.js";
import { currentLang } from "../shared/langConfig.js";
import { isKeyText } from "../shared/auth.js";
import { CLIENT_KEY_FILE } from "../shared/clientKey.js";

const run = promisify(execFile);

export const MARKER_FILE = "secured.json";
export const ADMIN_KEY_FILE = "admin.key";
/** 현재 사용자 외에 소유자로 허용: Administrators, SYSTEM. */
export const ALLOWED_OWNER_SIDS = ["S-1-5-32-544", "S-1-5-18"];

export interface ForeignReport {
  count: number;
  samples: { path: string; owner: string | null }[];
}

export interface SecureDeps {
  platform: NodeJS.Platform;
  currentUserSid(): Promise<string>;
  /** root(와 opts.paths 중 존재하는 것, recurse면 root 아래 전체)에서 소유자가 allowed에 없는 항목. 소유자를 못 읽으면 owner=null로 센다. */
  findForeign(root: string, opts: { recurse: boolean; paths: string[] }, allowed: string[]): Promise<ForeignReport>;
  restrictAcl(dir: string): Promise<{ ok: boolean; error?: string }>;
}

// PowerShell 5.1. 경로·허용 SID는 env로 받는다(명령줄 인젝션 방지). 출력은 UTF-8 JSON 한 줄.
// 링크·junction(ReparsePoint)은 자기 자신만 검사하고 안으로 들어가지 않는다.
const SCAN_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$root = $env:UPLINK_SCAN_ROOT
# PowerShell 5.1 ConvertFrom-Json emits an array as a single item -> unroll it through the pipe into a string array.
$allowed = @((ConvertFrom-Json $env:UPLINK_SCAN_ALLOWED) | ForEach-Object { [string]$_ })
$paths = @((ConvertFrom-Json $env:UPLINK_SCAN_PATHS) | ForEach-Object { [string]$_ })
$recurse = $env:UPLINK_SCAN_RECURSE -eq '1'
$sidType = [System.Security.Principal.SecurityIdentifier]
$script:count = 0
$samples = New-Object System.Collections.ArrayList
function Note($p, $o) {
  $script:count++
  if ($samples.Count -lt 20) { [void]$samples.Add(@{ path = $p; owner = $o }) }
}
function Check($p) {
  $o = $null
  try { $o = (Get-Acl -LiteralPath $p).GetOwner($sidType).Value } catch { $o = $null }
  if ($o -eq $null -or -not ($allowed -contains $o)) { Note $p $o }
}
Check $root
if ($recurse) {
  $stack = New-Object System.Collections.Stack
  $stack.Push($root)
  while ($stack.Count -gt 0) {
    $d = $stack.Pop()
    $items = $null
    try { $items = @(Get-ChildItem -LiteralPath $d -Force) } catch { Note $d $null; continue }
    foreach ($it in $items) {
      Check $it.FullName
      if ($it.PSIsContainer -and -not ($it.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) { $stack.Push($it.FullName) }
    }
  }
} else {
  foreach ($p in $paths) { if (Test-Path -LiteralPath $p) { Check $p } }
}
ConvertTo-Json -Compress -Depth 4 @{ count = $script:count; samples = @($samples) }
`;

const POWERSHELL = path.join(process.env.SystemRoot ?? "C:/Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

/**
 * PowerShell 7(pwsh) 아래에서 실행되면 PSModulePath에 PS7 모듈 경로가 들어 있어, Windows PowerShell 5.1이
 * PS7용 Microsoft.PowerShell.Security를 먼저 찾고 로드에 실패한다(Get-Acl 실패 → 모든 소유자 '확인 불가' → 시작 거부).
 * 5.1이 자기 기본 모듈 경로를 쓰도록 이 변수를 넘기지 않는다(env 키는 대소문자 무관하게 비교).
 */
export function withoutPsModulePath(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (k.toLowerCase() !== "psmodulepath") out[k] = v;
  return out;
}

async function findForeignPs(root: string, opts: { recurse: boolean; paths: string[] }, allowed: string[]): Promise<ForeignReport> {
  const encoded = Buffer.from(SCAN_SCRIPT, "utf16le").toString("base64");
  const { stdout } = await run(POWERSHELL, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], {
    encoding: "utf8",
    timeout: 120000, // 첫 실행 전체 검사는 파일 수에 비례
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
    env: {
      ...withoutPsModulePath(process.env),
      UPLINK_SCAN_ROOT: root,
      UPLINK_SCAN_PATHS: JSON.stringify(opts.paths),
      UPLINK_SCAN_ALLOWED: JSON.stringify(allowed),
      UPLINK_SCAN_RECURSE: opts.recurse ? "1" : "0",
    },
  });
  const parsed = JSON.parse(stdout.trim()) as { count?: unknown; samples?: unknown };
  // PowerShell 5.1은 원소가 하나인 배열을 객체로 펼칠 수 있다.
  const list = Array.isArray(parsed.samples) ? parsed.samples : parsed.samples ? [parsed.samples] : [];
  return {
    count: typeof parsed.count === "number" ? parsed.count : list.length,
    samples: list.map((s: any) => ({ path: String(s.path), owner: typeof s.owner === "string" ? s.owner : null })),
  };
}

export const realSecureDeps: SecureDeps = {
  platform: process.platform,
  currentUserSid,
  findForeign: findForeignPs,
  restrictAcl: restrictDataDirAcl,
};

function foreignMessage(dir: string, rep: ForeignReport, lang: Lang): string {
  const first = rep.samples[0];
  return hubMsg(lang, "secure_foreign", { dir, count: rep.count, example: first ? { path: first.path, owner: first.owner } : undefined });
}

function loadOrCreateKey(file: string, valid: (t: string) => boolean): string {
  try {
    const t = fs.readFileSync(file, "utf8").trim();
    if (valid(t)) return t;
  } catch {
    // 없음 → 새로 만든다
  }
  const key = randomBytes(32).toString("hex");
  writeSecretFile(file, key);
  return key;
}

/**
 * lang: 실패 안내 언어. 생략하면 폴더의 config.json에서 읽는다 — 잠금 전 남의 폴더일 수 있지만
 * 값은 ko/en 선택에만 쓰이고(parseLanguage) 안내에 그대로 들어가지 않는다.
 */
export async function secureDataDir(
  dir: string,
  deps: SecureDeps = realSecureDeps,
  lang: Lang = currentLang(dir),
): Promise<{ clientKey: string; adminKey: string }> {
  fs.mkdirSync(dir, { recursive: true });
  const clientFile = path.join(dir, CLIENT_KEY_FILE);
  const adminFile = path.join(dir, ADMIN_KEY_FILE);
  const marker = path.join(dir, MARKER_FILE);
  if (deps.platform === "win32") {
    // 잠금 먼저: 검사와 잠금 사이 틈에 새 항목이 생기지 않게 한다(남의 폴더에 시도하는 것은 해가 없다).
    const acl = await deps.restrictAcl(dir);
    const me = await deps.currentUserSid();
    // 표식이 없으면(첫 보안 준비) 폴더 전체를 1회 검사 — 첫 실행 전에 남이 만들어 둔 하위 폴더·파일을 잡는다.
    // 잠금이 실패했어도 검사한다: 남이 만든 폴더면 잠금부터 실패하므로, 그 사실을 알려야 사용자가 원인을 안다.
    const firstRun = !fs.existsSync(marker);
    const rep = await deps.findForeign(dir, { recurse: firstRun || !acl.ok, paths: [clientFile, adminFile, marker] }, [me, ...ALLOWED_OWNER_SIDS]);
    if (rep.count > 0) throw new Error(foreignMessage(dir, rep, lang));
    if (!acl.ok) {
      throw new Error(hubMsg(lang, "secure_acl_failed", { dir, detail: acl.error ?? "" }));
    }
  } else {
    fs.chmodSync(dir, 0o700);
  }
  const clientKey = loadOrCreateKey(clientFile, isKeyText);
  const adminKey = loadOrCreateKey(adminFile, (t) => t.length > 0); // 기존 admin.key는 형식이 달라도 유지
  if (!fs.existsSync(marker)) writeSecretFile(marker, JSON.stringify({ version: 1, securedAt: Date.now() }));
  return { clientKey, adminKey };
}
