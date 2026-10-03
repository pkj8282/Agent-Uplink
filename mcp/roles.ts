// 역할 → 계정 UUID 매핑. env(UPLINK_ACCOUNTS)가 우선이고, 없으면 폴더별 로컬 상태 파일에 저장·재사용한다.
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

export const ROLE_NAME_MAX = 40;

/** '=', ';', C0 제어문자(줄바꿈 포함), DEL — env 형식을 깨거나 표시를 위장할 수 있는 문자. */
function hasForbidden(s: string): boolean {
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (ch === "=" || ch === ";" || c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

export function validateRoleName(raw: string): { ok: true; role: string } | { ok: false; error: string } {
  const role = raw.trim();
  if (role.length === 0) return { ok: false, error: "역할 이름이 비어 있습니다." };
  if ([...role].length > ROLE_NAME_MAX) return { ok: false, error: `역할 이름은 ${ROLE_NAME_MAX}자 이하여야 합니다.` };
  if (hasForbidden(role)) return { ok: false, error: "역할 이름에 '=', ';', 줄바꿈·제어문자를 쓸 수 없습니다." };
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

/** 작업 폴더 키. win32는 대소문자를 무시한다(C:\ 와 c:\ 는 같은 폴더). */
export function folderKey(cwd: string, platform: NodeJS.Platform = process.platform): string {
  let p = path.resolve(cwd);
  if (platform === "win32") p = p.toLowerCase();
  return createHash("sha256").update(p, "utf8").digest("hex").slice(0, 16);
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
  private readonly dir: string;
  private readonly env: EnvRoles;

  constructor(opts: { dataDir: string; cwd: string; env?: string; platform?: NodeJS.Platform }) {
    this.folder = path.resolve(opts.cwd);
    this.dir = path.join(opts.dataDir, "state", "roles", folderKey(opts.cwd, opts.platform));
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
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      try {
        fs.writeFileSync(path.join(this.dir, "folder.txt"), this.folder, { flag: "wx" });
      } catch {
        // 이미 있음
      }
      // 없을 때만 생성 — 두 세션이 동시에 만들면 한쪽만 성공하고 다른 쪽은 그 UUID를 읽는다.
      fs.writeFileSync(file, JSON.stringify({ role, uuid }), { flag: "wx" });
      return { uuid, source: "new", persisted: true };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") {
        const won = this.read(file);
        if (won) return { uuid: won.uuid, source: "local", persisted: true };
      }
      return { uuid, source: "new", persisted: false };
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
