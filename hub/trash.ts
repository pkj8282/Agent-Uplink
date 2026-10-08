// 휴지통: <dataDir>/trash/<id>/{meta.json, <channelId>.jsonl..., account.json}.
// meta.state는 삭제·복원의 저널이다(시작 시 미완료 작업을 멱등 재실행 — trashOps.ts).
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { writeFileAtomic } from "./fsutil.js";
import { TrashItemInfo } from "../shared/protocol.js";
import { isSafeAccountId, isUuid } from "./ids.js";
import { escapeControls } from "../shared/controlChars.js";

export type TrashKind = "channel" | "server" | "account" | "orphan" | "dm";
export type TrashState = "deleting" | "done" | "restoring";

export interface TrashMeta {
  v: 1;
  id: string;
  kind: TrashKind;
  state: TrashState;
  deletedAt: number;
  deletedBy: "admin" | "mcp" | "recovery";
  name: string;
  serverId?: string;
  serverName?: string;
  channels?: { id: string; name: string }[];
  account?: { uuid: string };
  accountRestored?: boolean;
  dms?: { channelId: string; peer: string; label: string }[];
  /** kind=dm: 지운 DM 하나(v2.1.2, 관리 앱). */
  dm?: { channelId: string; members: [string, string]; label: string };
  plan?: { serverName?: string; channelNames?: Record<string, string> };
  files: string[];
}

export type TrashItem = TrashItemInfo;

const ID_RE = /^\d{13}-(channel|server|account|orphan|dm)-[0-9a-f]{8}$/;
const UUID_LOG_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/;
const KINDS = new Set(["channel", "server", "account", "orphan", "dm"]);
const STATES = new Set(["deleting", "done", "restoring"]);

export function isTrashId(s: unknown): s is string {
  return typeof s === "string" && ID_RE.test(s);
}

export function isTrashFileName(s: unknown): s is string {
  return typeof s === "string" && (s === "account.json" || UUID_LOG_RE.test(s));
}

export function isUuidLogName(s: string): boolean {
  return UUID_LOG_RE.test(s);
}

type CreateFields = Omit<TrashMeta, "v" | "id" | "kind" | "state" | "deletedAt" | "files">;

const isStr = (v: unknown): v is string => typeof v === "string";

/**
 * 종류별 필수 필드와 경로로 쓰이는 id 형식을 검사한다. meta는 사용자가 손댈 수 있는 파일이라,
 * 여기서 걸러야 복원이 데이터 폴더 밖에 쓰거나 예외로 Hub를 죽이지 않는다.
 */
function validShape(m: TrashMeta): boolean {
  if (m.plan !== undefined) {
    if (typeof m.plan !== "object" || m.plan === null) return false;
    if (m.plan.serverName !== undefined && !isStr(m.plan.serverName)) return false;
    const cn = m.plan.channelNames;
    if (cn !== undefined && (typeof cn !== "object" || cn === null || !Object.values(cn).every(isStr))) return false;
  }
  switch (m.kind) {
    case "channel":
    case "server":
      return isUuid(m.serverId) && isStr(m.serverName) && Array.isArray(m.channels)
        && m.channels.every((c) => c && isUuid(c.id) && isStr(c.name));
    case "account":
      return !!m.account && isSafeAccountId(m.account.uuid) && Array.isArray(m.dms)
        && m.dms.every((x) => x && isUuid(x.channelId) && isSafeAccountId(x.peer) && isStr(x.label));
    case "dm":
      return !!m.dm && isUuid(m.dm.channelId) && isStr(m.dm.label) && Array.isArray(m.dm.members)
        && m.dm.members.length === 2 && m.dm.members.every(isSafeAccountId) && m.dm.members[0] !== m.dm.members[1];
    case "orphan": {
      const [sub, file, extra] = m.name.split("/");
      return (sub === "servers" || sub === "dm") && isStr(file) && UUID_LOG_RE.test(file) && extra === undefined;
    }
  }
}

/** 휴지통 입구(v2.1.2): 메타의 이름 필드를 이스케이프한다. orphan의 name은 내부 경로(servers/<id>.jsonl)라 그대로 둔다. */
function escapeMeta(m: TrashMeta): TrashMeta {
  if (m.kind !== "orphan") m.name = escapeControls(m.name);
  if (m.serverName !== undefined) m.serverName = escapeControls(m.serverName);
  for (const c of m.channels ?? []) c.name = escapeControls(c.name);
  for (const d of m.dms ?? []) d.label = escapeControls(d.label);
  if (m.dm) m.dm.label = escapeControls(m.dm.label);
  if (m.plan?.serverName !== undefined) m.plan.serverName = escapeControls(m.plan.serverName);
  if (m.plan?.channelNames) for (const k of Object.keys(m.plan.channelNames)) m.plan.channelNames[k] = escapeControls(m.plan.channelNames[k]);
  return m;
}

/** account.json이 복원에 쓸 수 있는 모양인가. */
export function parseAccountRecord(raw: string | null): { uuid: string; name: string; createdAt: number; description?: string } | null {
  if (raw === null) return null;
  try {
    const r = JSON.parse(raw) as { uuid?: unknown; name?: unknown; createdAt?: unknown; description?: unknown };
    if (!isSafeAccountId(r.uuid) || !isStr(r.name) || typeof r.createdAt !== "number") return null;
    if (r.description !== undefined && !isStr(r.description)) return null;
    // 휴지통 입구(v2.1.2): 복원으로 계정에 들어갈 값이라 이스케이프한다.
    return {
      uuid: r.uuid, name: escapeControls(r.name), createdAt: r.createdAt,
      ...(r.description ? { description: escapeControls(r.description) } : {}),
    };
  } catch {
    return null;
  }
}

/** 다른 프로그램(백신·백업 도구)이 잠시 잡고 있는 파일을 위해 짧게 재시도하는 rename. */
function renameWithRetry(src: string, dest: string): void {
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(src, dest);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (i >= 4 || (code !== "EBUSY" && code !== "EPERM" && code !== "EACCES")) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30);
    }
  }
}

export class TrashStore {
  readonly dir: string;

  constructor(opts: { dir: string }) {
    this.dir = path.join(opts.dir, "trash");
    fs.mkdirSync(this.dir, { recursive: true });
  }

  /** 새 항목 폴더 + meta(state:"deleting")를 만든다. */
  create(kind: TrashKind, fields: CreateFields, now: number = Date.now()): TrashMeta {
    let id = "";
    for (;;) {
      id = `${String(now).padStart(13, "0")}-${kind}-${randomBytes(4).toString("hex")}`;
      try {
        fs.mkdirSync(path.join(this.dir, id));
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
    }
    const meta: TrashMeta = { v: 1, id, kind, state: "deleting", deletedAt: now, files: [], ...fields };
    this.writeMeta(meta);
    return meta;
  }

  writeMeta(meta: TrashMeta): void {
    writeFileAtomic(path.join(this.dir, meta.id, "meta.json"), JSON.stringify(meta, null, 2));
  }

  /** id 형식이 맞고, trash 바로 아래의 실제 디렉터리(심볼릭 링크·junction 아님)일 때만 경로를 준다. */
  itemDir(id: string): string | null {
    if (!isTrashId(id)) return null;
    const p = path.join(this.dir, id);
    try {
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink() || !st.isDirectory()) return null;
    } catch {
      return null;
    }
    return p;
  }

  readMeta(id: string): TrashMeta | null {
    const d = this.itemDir(id);
    if (!d) return null;
    try {
      const m = JSON.parse(fs.readFileSync(path.join(d, "meta.json"), "utf8")) as TrashMeta;
      if (m.v !== 1 || m.id !== id || !KINDS.has(m.kind) || !STATES.has(m.state)) return null;
      if (!Array.isArray(m.files) || !m.files.every(isTrashFileName)) return null;
      if (typeof m.name !== "string" || typeof m.deletedAt !== "number") return null;
      return validShape(m) ? escapeMeta(m) : null;
    } catch {
      return null;
    }
  }

  private fileIn(id: string, name: string): string | null {
    const d = this.itemDir(id);
    if (!d || !isTrashFileName(name)) return null;
    return path.join(d, name);
  }

  has(id: string, name: string): boolean {
    const f = this.fileIn(id, name);
    return f !== null && fs.existsSync(f);
  }

  /** src를 항목의 name으로 옮긴다. 멱등: 이미 옮겨졌으면 true, 원본·목적지 모두 없으면 false. */
  moveIn(id: string, src: string, name: string): boolean {
    const dest = this.fileIn(id, name);
    if (!dest) return false;
    if (fs.existsSync(dest)) return true;
    if (!fs.existsSync(src)) return false;
    renameWithRetry(src, dest);
    return true;
  }

  /** 항목의 name을 dest로 되돌린다. 멱등: 이미 되돌려졌으면 true, 둘 다 없으면 false. */
  moveOut(id: string, name: string, dest: string): boolean {
    const src = this.fileIn(id, name);
    if (fs.existsSync(dest)) return true;
    if (!src || !fs.existsSync(src)) return false;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    renameWithRetry(src, dest);
    return true;
  }

  writeFile(id: string, name: string, data: string): void {
    const f = this.fileIn(id, name);
    if (!f) throw new Error(`Invalid trash file: ${id}/${name}`);
    writeFileAtomic(f, data);
  }

  readFile(id: string, name: string): string | null {
    const f = this.fileIn(id, name);
    if (!f) return null;
    try {
      return fs.readFileSync(f, "utf8");
    } catch {
      return null;
    }
  }

  deleteFile(id: string, name: string): void {
    const f = this.fileIn(id, name);
    if (f) fs.rmSync(f, { force: true });
  }

  /** files가 전부 있고, account.json이 있으면 복원에 쓸 수 있는 모양이어야 한다. */
  isIntact(m: TrashMeta): boolean {
    if (!m.files.every((f) => this.has(m.id, f))) return false;
    return !m.files.includes("account.json") || parseAccountRecord(this.readFile(m.id, "account.json")) !== null;
  }

  list(): TrashItem[] {
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return [];
    }
    const out: TrashItem[] = [];
    for (const id of names.filter(isTrashId).sort()) {
      const d = this.itemDir(id);
      if (!d) continue;
      const m = this.readMeta(id);
      if (!m) {
        const kind = id.split("-")[1] as TrashKind;
        out.push({ id, kind, name: "", deletedAt: Number(id.slice(0, 13)), deletedBy: "admin", bytes: 0, fileCount: 0, intact: false, restorable: false });
        continue;
      }
      let bytes = 0;
      for (const f of m.files) {
        try {
          bytes += fs.statSync(path.join(d, f)).size;
        } catch {
          // 없는 파일은 intact=false로 드러난다
        }
      }
      const intact = this.isIntact(m);
      const item: TrashItem = {
        id, kind: m.kind, name: m.name, deletedAt: m.deletedAt, deletedBy: m.deletedBy,
        bytes, fileCount: m.files.length, intact,
        restorable: intact && m.kind !== "orphan" && m.state === "done",
      };
      if (m.serverName !== undefined) item.serverName = m.serverName;
      if (m.kind === "account" && m.accountRestored) item.dmLeftover = m.dms?.length ?? 0;
      out.push(item);
    }
    return out;
  }

  remove(id: string): void {
    const d = this.itemDir(id);
    if (d) fs.rmSync(d, { recursive: true, force: true });
  }

  /** 형식에 맞는 완료(done) 항목과 meta를 읽을 수 없는 항목을 영구 삭제한다. 진행 중 항목·형식 밖 파일은 남긴다. */
  empty(): number {
    let n = 0;
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return 0;
    }
    for (const id of names.filter(isTrashId)) {
      if (!this.itemDir(id)) continue;
      const m = this.readMeta(id);
      if (m && m.state !== "done") continue;
      this.remove(id);
      n++;
    }
    return n;
  }
}
