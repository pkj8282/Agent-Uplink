// 통신 상태 저장(v3.0): 데이터 폴더의 connection/ 아래 신원 키·서버 설정·초대·구성원·참여 공간·사용자 이름.
// 통신을 켜지 않은 Hub에는 흔적을 남기지 않는다 — 읽기만 할 때는 폴더를 만들지 않고, 처음 쓸 때 만든다.
import fs from "node:fs";
import path from "node:path";
import { createHash, timingSafeEqual } from "node:crypto";
import { backupCorrupt, writeFileAtomic, writeSecretFile } from "../fsutil.js";
import { generateSigningKeys, type SigningKeys } from "../../shared/connCrypto.js";
import type { ProfileId } from "../../shared/cryptoProfile.js";
import type { Endpoint } from "../../shared/invite.js";

export interface ServerConfig {
  enabled: boolean;
  port: number;
  profile: ProfileId;
  spaceId: string;
  spaceName: string;
  burnOnJoin: boolean;
  /** 공유하는 Connection Communications 서버 ID들. */
  shared: string[];
  /** 방식 3: 망에 공유하는 통신 서버 ID들(기본 없음 — Ruling 4). */
  meshShared?: string[];
  /** 방식 3: 망 공유에서 뺀 채널(총괄 unshare가 내 채널을 가리킨 것). */
  meshExcluded?: string[];
}

export interface MemberRecord {
  memberId: string;
  hubKey: string;
  userName: string;
  joinedAt: number;
  revoked: boolean;
}

export interface JoinedSpace {
  spaceId: string;
  spaceName: string;
  endpoint: Endpoint;
  serverKey: string;
  profile: ProfileId;
  memberId: string;
  hostUser: string;
}

/** 서버 연결(방식 3)로 이어진 다른 통신 서버. dir = out(내가 거는 쪽, endpoint 있음) / in(상대가 거는 쪽). */
export interface LinkRecord {
  spaceId: string;
  spaceName: string;
  serverKey: string;
  dir: "in" | "out";
  endpoint?: Endpoint;
  profile?: ProfileId;
  addedAt: number;
  removed: boolean;
}

export type InviteUse = "ok" | "invalid" | "expired" | "used" | "bound_other";

interface InviteRecord {
  tokenHash: string; // 원문 토큰은 저장하지 않는다
  label: string;
  expiresAt: number;
  used: boolean;
  boundHubKey?: string;
}

const tokenHash = (token: string) => createHash("sha256").update(token.replace(/[-\s]/g, "").toUpperCase()).digest("hex");

export class ConnectionStore {
  readonly dir: string;
  private cache = new Map<string, unknown>();
  /** 손상 원본을 보존하지 못한 파일 — 이번 실행 동안 덮어쓰지 않는다. */
  private blocked = new Set<string>();

  constructor(opts: { dataDir: string }) {
    this.dir = path.join(opts.dataDir, "connection");
  }

  exists(): boolean {
    return fs.existsSync(this.dir);
  }

  private read<T>(name: string, fallback: T): T {
    if (this.cache.has(name)) return this.cache.get(name) as T;
    const file = path.join(this.dir, name);
    let value = fallback;
    if (fs.existsSync(file)) {
      try {
        value = JSON.parse(fs.readFileSync(file, "utf8")) as T;
      } catch {
        if (backupCorrupt(file) === null) this.blocked.add(name);
        value = fallback;
      }
    }
    this.cache.set(name, value);
    return value;
  }

  private write(name: string, value: unknown, secret = false): void {
    this.cache.set(name, value);
    if (this.blocked.has(name)) return;
    fs.mkdirSync(this.dir, { recursive: true });
    const file = path.join(this.dir, name);
    const data = JSON.stringify(value, null, 2);
    if (secret) writeSecretFile(file, data);
    else writeFileAtomic(file, data);
  }

  identity(): SigningKeys {
    const cur = this.read<SigningKeys | null>("identity.json", null);
    if (cur && typeof cur.publicKeyB64 === "string" && typeof cur.privateKeyPem === "string") return cur;
    const keys = generateSigningKeys();
    this.write("identity.json", keys, true);
    return keys;
  }

  serverConfig(): ServerConfig | null {
    return this.read<ServerConfig | null>("server.json", null);
  }

  setServerConfig(c: ServerConfig): void {
    this.write("server.json", c);
  }

  userName(): string | null {
    const u = this.read<{ name?: unknown } | null>("user.json", null);
    return u && typeof u.name === "string" ? u.name : null;
  }

  setUserName(n: string): void {
    this.write("user.json", { name: n });
  }

  private invites(): InviteRecord[] {
    const v = this.read<InviteRecord[]>("invites.json", []);
    return Array.isArray(v) ? v : [];
  }

  addInvite(token: string, label: string, expiresAt: number): void {
    this.write("invites.json", [...this.invites(), { tokenHash: tokenHash(token), label, expiresAt, used: false }]);
  }

  useInvite(token: string, hubKey: string, nowMs: number, burn: boolean): InviteUse {
    const want = Buffer.from(tokenHash(String(token)), "hex");
    const list = this.invites();
    let found: InviteRecord | undefined;
    for (const rec of list) {
      // 모든 기록을 같은 방식으로 비교(일찍 끝내지 않음).
      const have = Buffer.from(rec.tokenHash, "hex");
      if (have.length === want.length && timingSafeEqual(have, want) && !found) found = rec;
    }
    if (!found) return "invalid";
    if (found.expiresAt <= nowMs) return "expired";
    if (found.used) return "used";
    if (found.boundHubKey !== undefined && found.boundHubKey !== hubKey) return "bound_other";
    if (burn) found.used = true;
    else found.boundHubKey = hubKey;
    this.write("invites.json", list);
    return "ok";
  }

  /** 초대 때 서버가 정한 참여자 이름(사용 여부와 무관). 없으면 null. */
  inviteLabel(token: string): string | null {
    const want = tokenHash(String(token));
    return this.invites().find((r) => r.tokenHash === want)?.label ?? null;
  }

  members(): MemberRecord[] {
    const v = this.read<MemberRecord[]>("members.json", []);
    return Array.isArray(v) ? v : [];
  }

  member(id: string): MemberRecord | undefined {
    return this.members().find((m) => m.memberId === id);
  }

  addMember(m: MemberRecord): void {
    this.write("members.json", [...this.members().filter((x) => x.memberId !== m.memberId), m]);
  }

  revoke(id: string): boolean {
    const list = this.members();
    const m = list.find((x) => x.memberId === id);
    if (!m) return false;
    m.revoked = true;
    this.write("members.json", list);
    return true;
  }

  // ───────── 서버 연결(방식 3) ─────────

  private linkInvites(): InviteRecord[] {
    const v = this.read<InviteRecord[]>("link-invites.json", []);
    return Array.isArray(v) ? v : [];
  }

  /** 서버 연결 인증서 토큰(항상 1회용 — Ruling 1). */
  addLinkInvite(token: string, label: string, expiresAt: number): void {
    this.write("link-invites.json", [...this.linkInvites(), { tokenHash: tokenHash(token), label, expiresAt, used: false }]);
  }

  useLinkInvite(token: string, nowMs: number): "ok" | "invalid" | "expired" | "used" {
    const want = Buffer.from(tokenHash(String(token)), "hex");
    const list = this.linkInvites();
    let found: InviteRecord | undefined;
    for (const rec of list) {
      const have = Buffer.from(rec.tokenHash, "hex");
      if (have.length === want.length && timingSafeEqual(have, want) && !found) found = rec;
    }
    if (!found) return "invalid";
    if (found.expiresAt <= nowMs) return "expired";
    if (found.used) return "used";
    found.used = true;
    this.write("link-invites.json", list);
    return "ok";
  }

  links(): LinkRecord[] {
    const v = this.read<LinkRecord[]>("links.json", []);
    return Array.isArray(v) ? v : [];
  }

  link(spaceId: string): LinkRecord | undefined {
    return this.links().find((l) => l.spaceId === spaceId);
  }

  addLink(l: LinkRecord): void {
    this.write("links.json", [...this.links().filter((x) => x.spaceId !== l.spaceId), l]);
  }

  /** 서버 연결 끊기(기록은 남기고 removed — 같은 키로 다시 인증 못 함). */
  removeLink(spaceId: string): boolean {
    const list = this.links();
    const l = list.find((x) => x.spaceId === spaceId);
    if (!l) return false;
    l.removed = true;
    this.write("links.json", list);
    return true;
  }

  joined(): JoinedSpace[] {
    const v = this.read<JoinedSpace[]>("joined.json", []);
    return Array.isArray(v) ? v : [];
  }

  addJoined(j: JoinedSpace): void {
    this.write("joined.json", [...this.joined().filter((x) => x.spaceId !== j.spaceId), j]);
  }

  removeJoined(spaceId: string): void {
    this.write("joined.json", this.joined().filter((x) => x.spaceId !== spaceId));
  }
}
