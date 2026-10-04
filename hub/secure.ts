// Hub 보안 준비: 데이터 폴더를 현재 사용자 전용으로 잠그고(ACL), 다른 사용자가 만든 항목이 없는지 확인한 뒤 키를 만든다.
// 이 준비가 끝나기 전에는 hello에 답하지 않는다(server.ts). 실패하면 경고만 하고 넘어가지 않는다(fail-closed).
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { restrictDataDirAcl, currentUserSid } from "./acl.js";
import { writeSecretFile } from "./fsutil.js";
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
# PowerShell 5.1의 ConvertFrom-Json은 배열을 통째로 한 개로 내보낸다 → 파이프로 펼쳐 문자열 배열로 만든다.
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

async function findForeignPs(root: string, opts: { recurse: boolean; paths: string[] }, allowed: string[]): Promise<ForeignReport> {
  const encoded = Buffer.from(SCAN_SCRIPT, "utf16le").toString("base64");
  const { stdout } = await run(POWERSHELL, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], {
    encoding: "utf8",
    timeout: 120000, // 첫 실행 전체 검사는 파일 수에 비례
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
    env: {
      ...process.env,
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

function foreignMessage(dir: string, rep: ForeignReport): string {
  const first = rep.samples[0];
  const where = first ? ` 예: ${first.path} (소유자 ${first.owner ?? "확인 불가"})` : "";
  return [
    `데이터 폴더(${dir})에 다른 사용자가 만든 항목이 ${rep.count}개 있습니다.${where}`,
    "같은 PC의 다른 Windows 사용자가 먼저 만든 폴더·파일일 수 있어 사용하지 않습니다.",
    "MCP 설정 env의 UPLINK_DATA_DIR를 자기 사용자 폴더(예: %LOCALAPPDATA%/AgentUplink)로 지정하거나, 관리자에게 이 폴더 정리를 요청하세요.",
  ].join(" ");
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

export async function secureDataDir(dir: string, deps: SecureDeps = realSecureDeps): Promise<{ clientKey: string; adminKey: string }> {
  fs.mkdirSync(dir, { recursive: true });
  const clientFile = path.join(dir, CLIENT_KEY_FILE);
  const adminFile = path.join(dir, ADMIN_KEY_FILE);
  const marker = path.join(dir, MARKER_FILE);
  if (deps.platform === "win32") {
    // 잠금 먼저: 검사와 잠금 사이 틈에 새 항목이 생기지 않게 한다(남의 폴더에 시도하는 것은 해가 없다).
    const acl = await deps.restrictAcl(dir);
    if (!acl.ok) throw new Error(`데이터 폴더(${dir}) 권한을 현재 사용자 전용으로 바꾸지 못했습니다: ${acl.error}`);
    const me = await deps.currentUserSid();
    // 표식이 없으면(첫 보안 준비) 폴더 전체를 1회 검사 — 첫 실행 전에 남이 만들어 둔 하위 폴더·파일을 잡는다.
    const firstRun = !fs.existsSync(marker);
    const rep = await deps.findForeign(dir, { recurse: firstRun, paths: [clientFile, adminFile, marker] }, [me, ...ALLOWED_OWNER_SIDS]);
    if (rep.count > 0) throw new Error(foreignMessage(dir, rep));
  } else {
    fs.chmodSync(dir, 0o700);
  }
  const clientKey = loadOrCreateKey(clientFile, isKeyText);
  const adminKey = loadOrCreateKey(adminFile, (t) => t.length > 0); // 기존 admin.key는 형식이 달라도 유지
  if (!fs.existsSync(marker)) writeSecretFile(marker, JSON.stringify({ version: 1, securedAt: Date.now() }));
  return { clientKey, adminKey };
}
