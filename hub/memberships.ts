// 서버 참가자 종합 리스트(v3.1.1). 계정 파일도 서버 기록도 아닌 따로 된 저장소 — <dataDir>/memberships.json.
// 저장은 한 방향(서버 → 계정 목록)만 하고, 참가자 관점(계정 → 서버 목록)은 그때그때 계산한다(두 방향을 따로 두면 어긋날 수 있음).
import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "./fsutil.js";

const FILE = "memberships.json";

export class MembershipStore {
  private servers = new Map<string, string[]>();
  /** 파일이 없거나 손상돼 빈 목록으로 시작했는가 — 이때만 채널 기록으로 처음 채운다. */
  readonly fresh: boolean;
  private readonly file: string;

  constructor(opts: { dataDir: string }) {
    this.file = path.join(opts.dataDir, FILE);
    let raw: string | null = null;
    try { raw = fs.readFileSync(this.file, "utf8"); } catch { /* 없음 */ }
    if (raw === null) { this.fresh = true; return; }
    const parsed = parse(raw);
    if (!parsed) {
      // 손상: 지우지 않고 옆으로 옮겨 두고 새로 시작(Hub가 기록으로 다시 채운다)
      try { fs.renameSync(this.file, `${this.file}.bad-${Date.now()}`); } catch { /* 옮기지 못해도 새 파일로 덮는다 */ }
      this.fresh = true;
      return;
    }
    this.servers = parsed;
    this.fresh = false;
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    writeFileAtomic(this.file, JSON.stringify({ v: 1, servers: Object.fromEntries(this.servers) }, null, 2));
  }

  join(serverId: string, uuid: string): boolean {
    const list = this.servers.get(serverId) ?? [];
    if (list.includes(uuid)) return false;
    this.servers.set(serverId, [...list, uuid]);
    this.save();
    return true;
  }

  leave(serverId: string, uuid: string): boolean {
    const list = this.servers.get(serverId);
    if (!list?.includes(uuid)) return false;
    this.servers.set(serverId, list.filter((u) => u !== uuid)); // 마지막 참가자가 나가도 서버 줄은 남는다
    this.save();
    return true;
  }

  isMember(serverId: string, uuid: string): boolean {
    return this.servers.get(serverId)?.includes(uuid) ?? false;
  }

  hasServer(serverId: string): boolean {
    return this.servers.has(serverId);
  }

  membersOf(serverId: string): string[] {
    return [...(this.servers.get(serverId) ?? [])];
  }

  serversOf(uuid: string): string[] {
    return [...this.servers].filter(([, l]) => l.includes(uuid)).map(([s]) => s);
  }

  all(): Record<string, string[]> {
    return Object.fromEntries([...this.servers].map(([s, l]) => [s, [...l]]));
  }

  removeServer(serverId: string): string[] {
    const list = this.servers.get(serverId);
    if (!list) return [];
    this.servers.delete(serverId);
    this.save();
    return [...list];
  }

  removeAccount(uuid: string): string[] {
    const out: string[] = [];
    for (const [s, l] of this.servers) if (l.includes(uuid)) { this.servers.set(s, l.filter((u) => u !== uuid)); out.push(s); }
    if (out.length) this.save();
    return out;
  }

  restoreServer(serverId: string, uuids: string[]): void {
    const set = new Set([...(this.servers.get(serverId) ?? []), ...uuids]);
    this.servers.set(serverId, [...set]);
    this.save();
  }

  restoreAccount(uuid: string, serverIds: string[]): void {
    for (const s of serverIds) {
      const l = this.servers.get(s) ?? [];
      if (!l.includes(uuid)) this.servers.set(s, [...l, uuid]);
    }
    if (serverIds.length) this.save();
  }

  seed(map: Record<string, string[]>): void {
    for (const [s, l] of Object.entries(map)) this.servers.set(s, [...new Set([...(this.servers.get(s) ?? []), ...l])]);
    this.save();
  }

  /** 실제와 맞춘다: 없는 서버 줄·없는 계정 삭제, 새로 생긴 서버는 빈 줄. 기록을 다시 훑어 참가시키지는 않는다. */
  sync(real: { servers: string[]; accounts: string[] }): { removedServers: number; removedMembers: number; addedServers: number } {
    const servers = new Set(real.servers), accounts = new Set(real.accounts);
    let removedServers = 0, removedMembers = 0, addedServers = 0;
    for (const [s, l] of [...this.servers]) {
      if (!servers.has(s)) { this.servers.delete(s); removedServers++; continue; }
      const keep = l.filter((u) => accounts.has(u));
      removedMembers += l.length - keep.length;
      if (keep.length !== l.length) this.servers.set(s, keep);
    }
    for (const s of servers) if (!this.servers.has(s)) { this.servers.set(s, []); addedServers++; }
    if (removedServers || removedMembers || addedServers || this.fresh) this.save();
    return { removedServers, removedMembers, addedServers };
  }
}

function parse(raw: string): Map<string, string[]> | null {
  let j: unknown;
  try { j = JSON.parse(raw); } catch { return null; }
  if (!j || typeof j !== "object" || Array.isArray(j)) return null;
  const { v, servers } = j as { v?: unknown; servers?: unknown };
  if (v !== 1 || !servers || typeof servers !== "object" || Array.isArray(servers)) return null;
  const out = new Map<string, string[]>();
  for (const [s, l] of Object.entries(servers)) {
    if (!Array.isArray(l) || !l.every((u) => typeof u === "string")) return null;
    out.set(s, [...new Set(l as string[])]);
  }
  return out;
}
