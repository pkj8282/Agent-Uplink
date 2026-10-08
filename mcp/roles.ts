// 역할 → 계정 UUID 매핑. env(UPLINK_ACCOUNTS)가 우선이고, 없으면 폴더별 로컬 상태 파일에 저장·재사용한다.
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { inspectText } from "../shared/controlChars.js";

export const ROLE_NAME_MAX = 40;

/**
 * '=', ';'(env 형식을 깸)와 표시를 위장할 수 있는 숨은 문자. 감독 검사기(v2.1.2)와 같은 기준이라 정상 이모지(⚙️ 같은 VS16·ZWJ)는
 * 허용한다 — 한 글자씩 판정하면 v2.1.1에서 쓰던 이모지 역할 이름을 잃는다.
 */
function hasForbidden(s: string): boolean {
  return s.includes("=") || s.includes(";") || inspectText(s).changed;
}

/** 실패는 언어 중립 code(문구는 호출자가 현재 언어로 만든다 — mcp/messages.ts의 같은 키). */
export function validateRoleName(
  raw: string,
): { ok: true; role: string } | { ok: false; code: "role_empty" | "role_too_long" | "role_forbidden"; params?: { max: number } } {
  const role = raw.trim();
  if (role.length === 0) return { ok: false, code: "role_empty" };
  if ([...role].length > ROLE_NAME_MAX) return { ok: false, code: "role_too_long", params: { max: ROLE_NAME_MAX } };
  if (hasForbidden(role)) return { ok: false, code: "role_forbidden" };
  return { ok: true, role };
}

export interface EnvRoles {
  roles: Map<string, string>;
  ignored: string[];
}

/** UPLINK_ACCOUNTS="역할=<uuid>;역할=<uuid>" 파싱. 형식 오류·중복 항목은 ignored로. */
export function parseAccountsEnv(raw: string | undefined): EnvRoles {
  const roles = new Map<string, string>();
  const ignored: string[] = [];
  if (!raw) return { roles, ignored };
  for (const part of raw.split(";")) {
    const item = part.trim();
    if (!item) continue;
    const eq = item.indexOf("=");
    const v = eq < 0 ? null : validateRoleName(item.slice(0, eq));
    const uuid = eq < 0 ? "" : item.slice(eq + 1).trim();
    if (!v || !v.ok || uuid.length === 0 || /\s/.test(uuid) || roles.has(v.role)) {
      ignored.push(item);
      continue;
    }
    roles.set(v.role, uuid);
  }
  return { roles, ignored };
}

function hashKey(p: string, platform: NodeJS.Platform): string {
  const k = platform === "win32" ? p.toLowerCase() : p;
  return createHash("sha256").update(k, "utf8").digest("hex").slice(0, 16);
}

/** v2.0.0 방식 키(실경로화 없음) — 기존 역할 폴더 이전용. win32는 대소문자 무시. */
export function legacyFolderKey(cwd: string, platform: NodeJS.Platform = process.platform): string {
  return hashKey(path.resolve(cwd), platform);
}

/** 8.3 짧은 이름·junction·subst를 실제 경로로 푼다(없는 경로면 path.resolve 결과). */
function realOrResolved(cwd: string): string {
  const p = path.resolve(cwd);
  try {
    return fs.realpathSync.native(p);
  } catch {
    return p;
  }
}

/** 작업 폴더 키. 실제 경로 기준(같은 폴더를 다른 표기로 열어도 같은 키), win32는 대소문자 무시. */
export function folderKey(cwd: string, platform: NodeJS.Platform = process.platform): string {
  return hashKey(realOrResolved(cwd), platform);
}

/** 역할 폴더 기준: UPLINK_PROJECT_DIR(공백 제외)가 있으면 그것, 없으면 cwd. */
export function resolveRoleCwd(env: NodeJS.ProcessEnv, cwd: string): string {
  const v = env.UPLINK_PROJECT_DIR?.trim();
  return v ? v : cwd;
}

export interface RoleEntry {
  role: string;
  uuid: string;
  source: "env" | "local";
}

export interface Resolved {
  uuid: string;
  source: "env" | "local" | "new";
  persisted: boolean;
}

export class RoleStore {
  readonly folder: string;
  private dir: string;
  private readonly env: EnvRoles;

  constructor(opts: { dataDir: string; cwd: string; env?: string; platform?: NodeJS.Platform }) {
    this.folder = realOrResolved(opts.cwd);
    const root = path.join(opts.dataDir, "state", "roles");
    this.dir = path.join(root, folderKey(opts.cwd, opts.platform));
    const legacy = path.join(root, legacyFolderKey(opts.cwd, opts.platform));
    // 같은 폴더를 다른 표기(junction·8.3)로 열어 만든 v2.0.0 역할을 새 키로 이전한다.
    if (legacy !== this.dir && !fs.existsSync(this.dir) && fs.existsSync(legacy)) {
      try {
        fs.renameSync(legacy, this.dir);
      } catch {
        if (!fs.existsSync(this.dir)) this.dir = legacy;
      }
    }
    this.env = parseAccountsEnv(opts.env);
  }

  ignoredEnv(): string[] {
    return [...this.env.ignored];
  }

  list(): RoleEntry[] {
    const fromEnv: RoleEntry[] = [...this.env.roles].map(([role, uuid]) => ({ role, uuid, source: "env" }));
    const local: RoleEntry[] = [];
    let files: string[] = [];
    try {
      files = fs.readdirSync(this.dir);
    } catch {
      // 아직 역할 없음
    }
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      const rec = this.read(path.join(this.dir, f));
      if (!rec || this.env.roles.has(rec.role)) continue;
      local.push({ role: rec.role, uuid: rec.uuid, source: "local" });
    }
    local.sort((a, b) => a.role.localeCompare(b.role));
    return [...fromEnv, ...local];
  }

  resolve(role: string): Resolved {
    const envUuid = this.env.roles.get(role);
    if (envUuid) return { uuid: envUuid, source: "env", persisted: true };
    const file = this.fileOf(role);
    const existing = this.read(file);
    if (existing) return { uuid: existing.uuid, source: "local", persisted: true };
    const uuid = randomUUID();
    const body = JSON.stringify({ role, uuid });
    const tmp = `${file}.${uuid}.tmp`;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      try {
        fs.writeFileSync(path.join(this.dir, "folder.txt"), this.folder, { flag: "wx" });
      } catch {
        // 이미 있음
      }
      // 내용을 다 쓴 임시 파일을 링크로 붙인다 — 생성이 원자적이라 반쯤 쓰인 파일이 보이지 않고,
      // 두 세션이 동시에 만들면 한쪽만 성공(EEXIST)하고 다른 쪽은 완성된 그 UUID를 읽는다.
      fs.writeFileSync(tmp, body);
      try {
        fs.linkSync(tmp, file);
        return { uuid, source: "new", persisted: true };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        const won = this.read(file);
        if (won) return { uuid: won.uuid, source: "local", persisted: true };
        // 기존 파일이 손상됐다(복구 불가) → 새 UUID로 원자 교체해 다음 실행부터 같은 계정이 되게 한다.
        fs.renameSync(tmp, file);
        return { uuid, source: "new", persisted: true };
      }
    } catch {
      return { uuid, source: "new", persisted: false };
    } finally {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        // 정리 실패 무시
      }
    }
  }

  /** 파일명은 역할 이름 해시(길이·대소문자 무관 파일시스템에 안전), 내용에 실제 이름을 둔다. */
  private fileOf(role: string): string {
    return path.join(this.dir, `${createHash("sha256").update(role, "utf8").digest("hex").slice(0, 32)}.json`);
  }

  private read(file: string): { role: string; uuid: string } | null {
    try {
      const rec = JSON.parse(fs.readFileSync(file, "utf8")) as { role?: unknown; uuid?: unknown };
      if (typeof rec.role !== "string" || typeof rec.uuid !== "string" || !rec.uuid) return null;
      if (!validateRoleName(rec.role).ok) return null;
      return { role: rec.role, uuid: rec.uuid };
    } catch {
      return null;
    }
  }
}
