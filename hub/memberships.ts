// 서버 참가자 종합 리스트(v3.1.1). 계정 파일도 서버 기록도 아닌 따로 된 저장소 — <dataDir>/memberships.json.
// 서버 관점(현재 참가자 | 참가 전적)과 참가자 관점(계정 → 서버)을 한 파일에 함께 두고 한 번에 통째로 쓴다(원자적) —
// 평소엔 두 관점이 어긋나지 않고, 손으로 고쳤거나 손상됐을 때만 동기화가 합집합으로 맞춘다(사용자 설계).
// 참가 전적은 기록일 뿐 실행 중 판정(받은편지함·read·send)이나 동기화 참가 판정에는 쓰지 않는다.
import fs from "node:fs";
import path from "node:path";
import { backupCorrupt, writeFileAtomic } from "./fsutil.js";

const FILE = "memberships.json";

interface Row { members: string[]; history: string[] }

const uniq = (l: string[]) => [...new Set(l)];
const add = (l: string[], v: string) => (l.includes(v) ? l : [...l, v]);
const drop = (l: string[], v: string) => l.filter((x) => x !== v);

export class MembershipStore {
  private servers = new Map<string, Row>();
  private accounts = new Map<string, string[]>();
  /** 파일이 없거나 손상돼 빈 목록으로 시작했는가 — 이때만 채널 기록으로 처음 채운다. */
  readonly fresh: boolean;
  /** 이번 실행 동안 저장을 멈췄는가(읽기 오류·손상 원본을 옮기지 못함) — 원본을 덮어쓰지 않는다. 다른 색인과 같은 관례. */
  saveBlocked = false;
  private readonly file: string;

  constructor(opts: { dataDir: string; backup?: (file: string) => string | null }) {
    this.file = path.join(opts.dataDir, FILE);
    let raw: string;
    try {
      raw = fs.readFileSync(this.file, "utf8");
    } catch (e) {
      // 정말 없을 때만 새로 시작. 그 밖의 읽기 오류(EBUSY·EPERM 등)는 정상 파일일 수 있으니 채우지도 덮어쓰지도 않는다
      // — 빈 목록이라 이번 실행엔 아무도 서버 채널을 받지 않는다(새지 않는 쪽).
      this.fresh = (e as NodeJS.ErrnoException).code === "ENOENT";
      if (!this.fresh) this.saveBlocked = true;
      return;
    }
    const parsed = parse(raw);
    if (!parsed) {
      // 손상: 원본을 보존(옆으로 옮기거나 복사)하고 새로 시작(Hub가 기록으로 다시 채운다). 보존하지 못하면 덮어쓰지 않는다.
      if (!(opts.backup ?? backupCorrupt)(this.file)) this.saveBlocked = true;
      this.fresh = true;
      return;
    }
    this.servers = parsed.servers;
    this.accounts = parsed.accounts;
    this.fresh = false;
  }

  private save(): void {
    if (this.saveBlocked) return;
    const accounts = Object.fromEntries([...this.accounts].filter(([, l]) => l.length > 0));
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      writeFileAtomic(this.file, JSON.stringify({ v: 2, servers: Object.fromEntries(this.servers), accounts }, null, 2));
    } catch {
      // 쓰기 실패해도 메모리 상태는 유지(다른 색인과 같은 관례) — Hub 기동·요청을 멈추지 않는다
    }
  }

  private row(serverId: string): Row {
    let r = this.servers.get(serverId);
    if (!r) { r = { members: [], history: [] }; this.servers.set(serverId, r); }
    return r;
  }

  /** 두 관점 모두에 넣고 전적에도 남긴다(저장은 호출한 쪽이). */
  private put(serverId: string, uuid: string): void {
    const r = this.row(serverId);
    r.members = add(r.members, uuid);
    r.history = add(r.history, uuid);
    this.accounts.set(uuid, add(this.accounts.get(uuid) ?? [], serverId));
  }

  join(serverId: string, uuid: string): boolean {
    if (this.isMember(serverId, uuid)) return false;
    this.put(serverId, uuid);
    this.save();
    return true;
  }

  /** 현재 참가자·참가자 관점에서 뺀다. 참가 전적에는 남는다. 마지막 참가자가 나가도 서버 줄은 남는다. */
  leave(serverId: string, uuid: string): boolean {
    const r = this.servers.get(serverId);
    if (!r?.members.includes(uuid)) return false;
    r.members = drop(r.members, uuid);
    this.accounts.set(uuid, drop(this.accounts.get(uuid) ?? [], serverId));
    this.save();
    return true;
  }

  /** 실행 중 판정은 서버 관점 현재 참가자로(두 관점은 한 번에 쓰므로 평소 같다). */
  isMember(serverId: string, uuid: string): boolean {
    return this.servers.get(serverId)?.members.includes(uuid) ?? false;
  }

  hasServer(serverId: string): boolean {
    return this.servers.has(serverId);
  }

  membersOf(serverId: string): string[] {
    return [...(this.servers.get(serverId)?.members ?? [])];
  }

  historyOf(serverId: string): string[] {
    return [...(this.servers.get(serverId)?.history ?? [])];
  }

  /** 참가자 관점. */
  serversOf(uuid: string): string[] {
    return [...(this.accounts.get(uuid) ?? [])];
  }

  /** 서버 관점 현재 참가자. */
  all(): Record<string, string[]> {
    return Object.fromEntries([...this.servers].map(([s, r]) => [s, [...r.members]]));
  }

  /** 서버 관점 참가 전적. */
  history(): Record<string, string[]> {
    return Object.fromEntries([...this.servers].map(([s, r]) => [s, [...r.history]]));
  }

  removeServer(serverId: string): { members: string[]; history: string[] } {
    const r = this.servers.get(serverId);
    if (!r) return { members: [], history: [] };
    this.servers.delete(serverId);
    for (const [u, l] of this.accounts) if (l.includes(serverId)) this.accounts.set(u, drop(l, serverId));
    this.save();
    return { members: [...r.members], history: [...r.history] };
  }

  removeAccount(uuid: string): { servers: string[]; history: string[] } {
    const servers: string[] = [], history: string[] = [];
    for (const [s, r] of this.servers) {
      if (r.members.includes(uuid)) { r.members = drop(r.members, uuid); servers.push(s); }
      if (r.history.includes(uuid)) { r.history = drop(r.history, uuid); history.push(s); }
    }
    const had = this.accounts.delete(uuid);
    if (servers.length || history.length || had) this.save();
    return { servers, history };
  }

  restoreServer(serverId: string, members: string[], history: string[]): void {
    const r = this.row(serverId);
    r.history = uniq([...r.history, ...history]);
    for (const u of members) this.put(serverId, u);
    this.save();
  }

  restoreAccount(uuid: string, servers: string[], history: string[]): void {
    for (const s of history) { const r = this.servers.get(s); if (r) r.history = add(r.history, uuid); }
    for (const s of servers) this.put(s, uuid);
    this.save();
  }

  /** 처음 채우기: 그 계정들을 참가자로(전적에도). 빈 목록이면 서버 줄만. */
  seed(map: Record<string, string[]>): void {
    for (const [s, l] of Object.entries(map)) { this.row(s); for (const u of l) this.put(s, u); }
    this.save();
  }

  /**
   * 실제와 맞춘다(관리 앱 동기화 버튼). ① 없는 서버 줄·없는 계정을 현재·전적에서 지운다. ② 서버 관점과 참가자 관점이 다르면
   * 참가로 판정해 양쪽에 넣는다(사용자 설계) — 참가 전적만으로는 참가시키지 않는다(나간 계정이 되살아나지 않게).
   * ③ 새로 생긴 서버는 빈 줄로.
   */
  sync(real: { servers: string[]; accounts: string[] }): { removedServers: number; removedMembers: number; addedServers: number; repaired: number } {
    const servers = new Set(real.servers), accounts = new Set(real.accounts);
    let removedServers = 0, removedMembers = 0, addedServers = 0, repaired = 0;
    // ① 유령 삭제(먼저 — 곧 지워질 짝을 '맞춤'으로 세지 않게)
    for (const [s, r] of [...this.servers]) {
      if (!servers.has(s)) { this.servers.delete(s); removedServers++; continue; }
      const keep = r.members.filter((u) => accounts.has(u));
      removedMembers += r.members.length - keep.length;
      r.members = keep;
      r.history = r.history.filter((u) => accounts.has(u));
    }
    for (const [u, l] of [...this.accounts]) {
      if (!accounts.has(u)) { this.accounts.delete(u); continue; }
      this.accounts.set(u, l.filter((s) => servers.has(s)));
    }
    // ② 합집합: 서버 쪽에만 있거나 계정 쪽에만 있는 짝
    const pairs = new Set<string>();
    for (const [s, r] of this.servers) for (const u of r.members) pairs.add(JSON.stringify([s, u]));
    for (const [u, l] of this.accounts) for (const s of l) pairs.add(JSON.stringify([s, u]));
    for (const p of pairs) {
      const [s, u] = JSON.parse(p) as [string, string];
      const inServer = this.servers.get(s)?.members.includes(u) ?? false;
      const inAccount = this.accounts.get(u)?.includes(s) ?? false;
      if (!(inServer && inAccount)) { this.put(s, u); repaired++; }
    }
    // ③ 새 서버
    for (const s of servers) if (!this.servers.has(s)) { this.row(s); addedServers++; }
    this.save();
    return { removedServers, removedMembers, addedServers, repaired };
  }
}

function strList(l: unknown): l is string[] {
  return Array.isArray(l) && l.every((u) => typeof u === "string");
}

function parse(raw: string): { servers: Map<string, Row>; accounts: Map<string, string[]> } | null {
  let j: unknown;
  try { j = JSON.parse(raw); } catch { return null; }
  if (!j || typeof j !== "object" || Array.isArray(j)) return null;
  const { v, servers, accounts } = j as { v?: unknown; servers?: unknown; accounts?: unknown };
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) return null;
  const outS = new Map<string, Row>(), outA = new Map<string, string[]>();
  if (v === 1) {
    // 옛 v1(서버 → 목록): 전적 = 현재 참가자, 참가자 관점은 계산해서 채운다
    for (const [s, l] of Object.entries(servers)) {
      if (!strList(l)) return null;
      outS.set(s, { members: uniq(l), history: uniq(l) });
      for (const u of uniq(l)) outA.set(u, add(outA.get(u) ?? [], s));
    }
    return { servers: outS, accounts: outA };
  }
  if (v !== 2 || !accounts || typeof accounts !== "object" || Array.isArray(accounts)) return null;
  for (const [s, r] of Object.entries(servers)) {
    if (!r || typeof r !== "object" || !strList((r as Row).members) || !strList((r as Row).history)) return null;
    outS.set(s, { members: uniq((r as Row).members), history: uniq((r as Row).history) });
  }
  for (const [u, l] of Object.entries(accounts)) {
    if (!strList(l)) return null;
    outA.set(u, uniq(l));
  }
  return { servers: outS, accounts: outA };
}
