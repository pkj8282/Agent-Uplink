// 방식 1 공간 동기화(v3.0 4단계, 설계 4.1·5.3·5.4): 서버 없이 여러 Hub가 같은 GitHub 저장소를 함께 쓴다.
// 저장소 agent-uplink/s1/<spaceId>/:
//   space.json                      관리자 서명 시작 정보(이름 없음)
//   roster/<버전8>.json             관리자 서명 명부(이전 해시 사슬). 이름·채널 목록은 현재 세대 열쇠로 봉함
//   keys/<세대>/<hubId>[.n].json     세대 열쇠를 구성원 X25519 공개키로 감싼 것(관리자 서명)
//   requests/<hubId>-<시각>.json      참여 요청(요청자 서명 + 초대 토큰 HMAC)
//   frag/<hubId>/<날짜>/<번호8>.frag  각 Hub가 쓴 조각(3a 형식, 세대 열쇠로 암호화, 작성 Hub 서명·사슬)
// 관리자만 명부·열쇠를 쓴다. 저장소 협력자가 가짜 파일로 자리를 선점해도: 쓰는 쪽은 다음 빈 번호로, 읽는 쪽은 서명이 틀리거나
// 사슬이 안 이어지는 파일을 건너뛴다. 자기 Hub가 쓴 메시지(출처 없음)만 올린다 — 받아 온 원격 메시지를 되올리지 않는다.
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chunkMessages, decodeFragment, encodeFragment, peekFragment } from "../../../shared/archive.js";
import type { SigningKeys } from "../../../shared/connCrypto.js";
import { generateWrapKeys, seal, unseal, unwrapKey, wrapKey } from "../../../shared/keywrap.js";
import { MAX_STORED_TEXT_LENGTH, type Channel, type Message, type MessageOrigin } from "../../../shared/protocol.js";
import { openEnvelope, signEnvelope } from "../../../shared/signed.js";
import { decodeSpaceInvite, encodeSpaceInvite, makeJoinRequest, readJoinRequest } from "../../../shared/spaceInvite.js";
import type { ChannelStore } from "../../channels.js";
import { writeFileAtomic, writeSecretFile } from "../../fsutil.js";
import { StorageError, type StorageBackend } from "../storage/backend.js";

export interface SpaceChannel { channelId: string; name: string }

export interface SpaceDeps {
  /** connection/spaces1 — 공간마다 하위 폴더. */
  spacesDir: string;
  keys: SigningKeys;
  channels: ChannelStore;
  makeBackend: (repo: string, branch: string | undefined, token: string) => StorageBackend;
  deliver: (ch: Channel, msg: Message) => void;
  /** 원격 문자열 감독(숨은 문자 → 보이는 이스케이프). */
  guard: (s: string, field: string) => string;
  log: (code: string, detail?: object) => void;
  userName: () => string;
  now?: () => number;
}

interface Config { v: 1; spaceId: string; spaceName: string; role: "owner" | "member"; repo: string; branch?: string; ownerKey: string; localServerId?: string; intervalSec: number }
interface InviteRec { inviteId: string; token: string; label: string; expiresAt: number; used: boolean }
interface Secrets { token: string; xPriv: string; xPub: string; epochKeys: Record<string, string>; invites: InviteRec[] }
interface Member { hubId: string; hubKey: string; xKey: string; joinedAt: number }
interface Revoked { hubId: string; hubKey: string; atEpoch: number; lastIndex: number }
interface Roster { v: 1; spaceId: string; version: number; prevHash: string; epoch: number; members: Member[]; revoked: Revoked[]; sealed: { nonce: string; ct: string }; keyChecks: Record<string, string> }
interface Plain { spaceName: string; names: Record<string, string>; channels: SpaceChannel[] }
interface Cursor { day: string; nextIndex: number; lastHash: string }
interface State {
  state: "pending" | "active" | "revoked";
  rosterVersion: number; rosterHash: string; roster: Roster | null; plain: Plain | null; joinEpoch: number | null;
  myIndex: number; myHash: string; lastSeq: Record<string, number>; cursors: Record<string, Cursor>; processed: string[];
  lastSyncAt: number | null; lastError: string | null;
}

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_SQUAT = 20;
/** 세대 열쇠의 지문 — 명부(관리자 서명)에 실려, 구성원이 여러 열쇠 파일 중 맞는 것을 고른다. */
const keyCheckOf = (key: Buffer) => createHash("sha256").update("agent-uplink/v3/epoch-check\n").update(key).digest("hex");
const pad8 = (n: number) => String(n).padStart(8, "0");
export const hubIdOf = (hubKey: string) => createHash("sha256").update(hubKey).digest("hex").slice(0, 16);
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export class SpaceSync {
  private backend: StorageBackend;
  private running: Promise<void> | null = null;

  private constructor(private readonly d: SpaceDeps, private readonly dir: string, private cfg: Config, private sec: Secrets, private st: State, private ownerChannels?: () => SpaceChannel[]) {
    this.backend = d.makeBackend(cfg.repo, cfg.branch, sec.token);
    if (cfg.role === "member") this.applyMirrors();
  }

  // ───────── 만들기·참여·불러오기 ─────────

  private static emptyState(): State {
    return { state: "pending", rosterVersion: 0, rosterHash: "", roster: null, plain: null, joinEpoch: null, myIndex: 0, myHash: "", lastSeq: {}, cursors: {}, processed: [], lastSyncAt: null, lastError: null };
  }

  /** 관리자로 새 공간을 만든다: 시작 정보·첫 명부(세대 1)를 저장소에 올린다. */
  static async createAsOwner(d: SpaceDeps, o: { spaceName: string; repo: string; branch?: string; token: string; intervalSec: number; localServerId?: string; ownerChannels: () => SpaceChannel[] }): Promise<SpaceSync> {
    const spaceId = randomUUID();
    const backend = d.makeBackend(o.repo, o.branch, o.token);
    await backend.check();
    const x = generateWrapKeys();
    const cfg: Config = { v: 1, spaceId, spaceName: o.spaceName, role: "owner", repo: o.repo, ...(o.branch ? { branch: o.branch } : {}), ownerKey: d.keys.publicKeyB64, ...(o.localServerId ? { localServerId: o.localServerId } : {}), intervalSec: o.intervalSec };
    const sec: Secrets = { token: o.token, xPriv: x.privatePem, xPub: x.publicB64, epochKeys: { "1": randomBytes(32).toString("base64") }, invites: [] };
    const st = SpaceSync.emptyState();
    const s = new SpaceSync(d, path.join(d.spacesDir, spaceId), cfg, sec, st, o.ownerChannels);
    await backend.put(`${s.root}/space.json`, Buffer.from(signEnvelope({ v: 1, spaceId, ownerKey: d.keys.publicKeyB64, createdAt: s.now() }, d.keys.privateKeyPem, d.keys.publicKeyB64)));
    const me: Member = { hubId: s.myHubId, hubKey: d.keys.publicKeyB64, xKey: x.publicB64, joinedAt: s.now() };
    st.state = "active";
    st.joinEpoch = 1;
    await s.writeRoster({ epoch: 1, members: [me], revoked: [] }, { spaceName: o.spaceName, names: { [s.myHubId]: d.userName() }, channels: o.ownerChannels() });
    s.save();
    return s;
  }

  /** 초대 코드로 참여 요청을 올린다(관리자가 다음 동기화에서 승인). */
  static async join(d: SpaceDeps, code: string, token: string): Promise<SpaceSync> {
    const dec = decodeSpaceInvite(code, (d.now ?? Date.now)());
    if (!dec.ok) throw new Error(dec.code);
    const inv = dec.invite;
    // 초대의 spaceId는 서명자가 정한다 — 이미 있는 공간의 비밀·설정을 덮어쓰지 않는다(네트워크 호출 전에).
    if (ID_RE.test(inv.spaceId)) {
      const have = readJson<Config | null>(path.join(d.spacesDir, inv.spaceId, "config.json"), null);
      if (have) throw new Error(have.ownerKey === inv.ownerKey ? "space_already_joined" : "space_key_changed");
    }
    const backend = d.makeBackend(inv.repo, inv.branch, token);
    await backend.check();
    const root = `agent-uplink/s1/${inv.spaceId}`;
    const raw = await backend.get(`${root}/space.json`);
    const env = raw ? openEnvelope(raw.toString("utf8"), inv.ownerKey) : { ok: false as const };
    if (!env.ok || env.body.spaceId !== inv.spaceId) throw new Error("space_not_found");
    const x = generateWrapKeys();
    const cfg: Config = { v: 1, spaceId: inv.spaceId, spaceName: d.guard(inv.spaceName.slice(0, 64), "spaceName"), role: "member", repo: inv.repo, ...(inv.branch ? { branch: inv.branch } : {}), ownerKey: inv.ownerKey, intervalSec: 30 };
    const sec: Secrets = { token, xPriv: x.privatePem, xPub: x.publicB64, epochKeys: {}, invites: [] };
    const s = new SpaceSync(d, path.join(d.spacesDir, inv.spaceId), cfg, sec, SpaceSync.emptyState());
    await backend.put(`${root}/requests/${s.myHubId}-${s.now()}.json`, Buffer.from(makeJoinRequest(inv, d.keys, x.publicB64, s.now())));
    s.save();
    return s;
  }

  /** 저장된 공간을 다시 연다(Hub 재시작). */
  static load(d: SpaceDeps, spaceId: string, ownerChannels?: () => SpaceChannel[]): SpaceSync | null {
    if (!ID_RE.test(spaceId)) return null;
    const dir = path.join(d.spacesDir, spaceId);
    const cfg = readJson<Config | null>(path.join(dir, "config.json"), null);
    const sec = readJson<Secrets | null>(path.join(dir, "secrets.json"), null);
    if (!cfg || !sec || cfg.spaceId !== spaceId) return null;
    const st = { ...SpaceSync.emptyState(), ...readJson<Partial<State>>(path.join(dir, "state.json"), {}) };
    return new SpaceSync(d, dir, cfg, sec, st, ownerChannels);
  }

  // ───────── 보조 ─────────

  private get root(): string {
    return `agent-uplink/s1/${this.cfg.spaceId}`;
  }

  private get myHubId(): string {
    return hubIdOf(this.d.keys.publicKeyB64);
  }

  private now(): number {
    return (this.d.now ?? Date.now)();
  }

  private save(): void {
    fs.mkdirSync(this.dir, { recursive: true });
    writeFileAtomic(path.join(this.dir, "config.json"), JSON.stringify(this.cfg, null, 2));
    writeSecretFile(path.join(this.dir, "secrets.json"), JSON.stringify(this.sec));
    writeFileAtomic(path.join(this.dir, "state.json"), JSON.stringify(this.st));
  }

  private key(epoch: number): Buffer | null {
    const k = this.sec.epochKeys[String(epoch)];
    return k ? Buffer.from(k, "base64") : null;
  }

  private mirrorId(channelId: string): string {
    return `s1:${this.cfg.spaceId}:${channelId}`;
  }

  /** 공간 채널 → 이 Hub의 로컬 채널 ID. */
  private localId(channelId: string): string {
    return this.cfg.role === "owner" ? channelId : this.mirrorId(channelId);
  }

  private spaceChannels(): SpaceChannel[] {
    return this.st.plain?.channels ?? [];
  }

  // ───────── 관리자: 명부·열쇠·초대·승인·퇴출 ─────────

  /** 새 명부 버전을 쓴다(자리 선점이면 다음 번호로). */
  private async writeRoster(r: Pick<Roster, "epoch" | "members" | "revoked">, plain: Plain): Promise<void> {
    const key = this.key(r.epoch)!;
    let version = this.st.rosterVersion + 1;
    for (let tries = 0; tries < MAX_SQUAT; tries++, version++) {
      const body: Roster = { v: 1, spaceId: this.cfg.spaceId, version, prevHash: this.st.rosterHash, epoch: r.epoch, members: r.members, revoked: r.revoked, sealed: seal(key, `roster|${this.cfg.spaceId}|${version}`, plain), keyChecks: { ...(this.st.roster?.keyChecks ?? {}), [String(r.epoch)]: keyCheckOf(key) } };
      const raw = signEnvelope(body as unknown as object, this.d.keys.privateKeyPem, this.d.keys.publicKeyB64);
      try {
        await this.backend.put(`${this.root}/roster/${pad8(version)}.json`, Buffer.from(raw));
      } catch (e) {
        if (e instanceof StorageError && e.code === "storage_bad_response") continue; // 이미 있음(선점) → 다음 번호
        throw e;
      }
      this.st.roster = body;
      this.st.rosterVersion = version;
      this.st.rosterHash = sha(raw);
      this.st.plain = plain;
      return;
    }
    throw new StorageError("storage_bad_response");
  }

  /** 세대 열쇠를 구성원에게 감싸 올린다(자리 선점이면 .1, .2 …). */
  private async writeKey(epoch: number, m: Member): Promise<void> {
    const wrapped = wrapKey(this.key(epoch)!, m.xKey, `key|${this.cfg.spaceId}|${epoch}|${m.hubId}`);
    const raw = signEnvelope({ v: 1, spaceId: this.cfg.spaceId, epoch, hubId: m.hubId, wrapped }, this.d.keys.privateKeyPem, this.d.keys.publicKeyB64);
    for (let n = 0; n < MAX_SQUAT; n++) {
      try {
        await this.backend.put(`${this.root}/keys/${epoch}/${m.hubId}${n ? `.${n}` : ""}.json`, Buffer.from(raw));
        return;
      } catch (e) {
        if (!(e instanceof StorageError && e.code === "storage_bad_response")) throw e;
      }
    }
    throw new StorageError("storage_bad_response");
  }

  /** 초대 코드(한 번만 쓸 수 있음). label = 상대에게 붙일 이름(관리자가 정함). */
  invite(label: string, expiresInMs: number): string {
    if (this.cfg.role !== "owner") throw new Error("space1_not_owner");
    const rec: InviteRec = { inviteId: randomBytes(9).toString("base64url"), token: randomBytes(18).toString("base64url"), label, expiresAt: this.now() + expiresInMs, used: false };
    this.sec.invites.push(rec);
    this.save();
    return encodeSpaceInvite({
      v: 1, kind: "space1", spaceId: this.cfg.spaceId, spaceName: this.cfg.spaceName, repo: this.cfg.repo, ...(this.cfg.branch ? { branch: this.cfg.branch } : {}),
      ownerKey: this.cfg.ownerKey, inviteId: rec.inviteId, token: rec.token, expiresAt: rec.expiresAt, memberName: label, hostUser: this.d.userName(),
    }, this.d.keys.privateKeyPem);
  }

  /** 관리자: 쌓인 참여 요청을 확인해 승인한다(초대마다 한 번). */
  private async processRequests(): Promise<boolean> {
    const r = this.st.roster!;
    const plain = this.st.plain!;
    let changed = false;
    const names = await this.backend.list(`${this.root}/requests`);
    for (const name of names) {
      if (this.st.processed.includes(name)) continue;
      this.st.processed.push(name);
      const raw = await this.backend.get(`${this.root}/requests/${name}`);
      if (!raw) continue;
      const now = this.now();
      const req = readJoinRequest(raw.toString("utf8"), this.cfg.spaceId, (id) => {
        const inv = this.sec.invites.find((i) => i.inviteId === id);
        return inv && !inv.used && inv.expiresAt > now ? inv.token : null;
      });
      if (!req.ok) {
        this.d.log("space1_request_rejected", { spaceId: this.cfg.spaceId });
        continue;
      }
      const hubId = hubIdOf(req.req.hubKey);
      if (r.members.some((m) => m.hubId === hubId) || r.revoked.some((x) => x.hubId === hubId)) continue;
      const inv = this.sec.invites.find((i) => i.inviteId === req.req.inviteId)!;
      const m: Member = { hubId, hubKey: req.req.hubKey, xKey: req.req.xKey, joinedAt: now };
      try {
        await this.writeKey(r.epoch, m);
      } catch (e) {
        this.st.processed = this.st.processed.filter((n) => n !== name); // 다음 동기화에서 다시
        throw e;
      }
      inv.used = true;
      r.members = [...r.members, m];
      plain.names = { ...plain.names, [hubId]: inv.label };
      this.d.log("space1_member_joined", { spaceId: this.cfg.spaceId, hubId, userName: inv.label });
      changed = true;
    }
    return changed;
  }

  /** 관리자: 구성원 퇴출 — 세대를 올리고 남은 구성원에게만 새 열쇠. 이미 받아 간 이전 대화는 되돌릴 수 없다. */
  async revoke(hubId: string): Promise<boolean> {
    if (this.cfg.role !== "owner" || !this.st.roster || hubId === this.myHubId) return false;
    const r = this.st.roster;
    const m = r.members.find((x) => x.hubId === hubId);
    if (!m) return false;
    const epoch = r.epoch + 1;
    this.sec.epochKeys[String(epoch)] = randomBytes(32).toString("base64");
    const members = r.members.filter((x) => x.hubId !== hubId);
    const revoked = [...r.revoked, { hubId, hubKey: m.hubKey, atEpoch: epoch, lastIndex: (this.st.cursors[hubId]?.nextIndex ?? 0) - 1 }];
    for (const x of members) if (x.hubId !== this.myHubId) await this.writeKey(epoch, x);
    await this.writeRoster({ epoch, members, revoked }, this.st.plain!);
    this.d.log("space1_member_revoked", { spaceId: this.cfg.spaceId, hubId, userName: this.st.plain?.names[hubId] ?? "" });
    this.save();
    return true;
  }

  // ───────── 구성원: 명부·열쇠 받기 ─────────

  /** 새 명부 버전을 받아들인다: 관리자 서명 + 이전 해시가 이어지는 것만(선점·위조 파일은 건너뜀). */
  private async syncRoster(): Promise<void> {
    const names = (await this.backend.list(`${this.root}/roster`)).filter((n) => /^\d{8}\.json$/.test(n)).sort();
    for (const name of names) {
      const version = Number(name.slice(0, 8));
      if (version <= this.st.rosterVersion) continue;
      const raw = await this.backend.get(`${this.root}/roster/${name}`);
      if (!raw) continue;
      const text = raw.toString("utf8");
      const env = openEnvelope(text, this.cfg.ownerKey);
      const b = env.ok ? (env.body as unknown as Roster) : null;
      if (!b || b.v !== 1 || b.spaceId !== this.cfg.spaceId || b.version !== version || b.prevHash !== this.st.rosterHash || !Array.isArray(b.members) || !Array.isArray(b.revoked) || !b.keyChecks || typeof b.keyChecks !== "object") {
        this.d.log("space1_roster_rejected", { spaceId: this.cfg.spaceId, version });
        continue;
      }
      this.st.roster = b;
      this.st.rosterVersion = version;
      this.st.rosterHash = sha(text);
    }
  }

  /** 구성원: 현재 세대 열쇠를 받아 푼다. */
  private async ensureKey(epoch: number): Promise<boolean> {
    if (this.key(epoch)) return true;
    const names = await this.backend.list(`${this.root}/keys/${epoch}`);
    for (const name of names.filter((n) => n === `${this.myHubId}.json` || n.startsWith(`${this.myHubId}.`))) {
      const raw = await this.backend.get(`${this.root}/keys/${epoch}/${name}`);
      const env = raw ? openEnvelope(raw.toString("utf8"), this.cfg.ownerKey) : { ok: false as const };
      if (!env.ok) continue;
      const b = env.body as { v?: unknown; spaceId?: unknown; epoch?: unknown; hubId?: unknown; wrapped?: unknown };
      if (b.v !== 1 || b.spaceId !== this.cfg.spaceId || b.epoch !== epoch || b.hubId !== this.myHubId) continue;
      const k = unwrapKey(b.wrapped as never, this.sec.xPriv, `key|${this.cfg.spaceId}|${epoch}|${this.myHubId}`);
      if (!k || keyCheckOf(k) !== this.st.roster?.keyChecks[String(epoch)]) continue; // 퇴출을 다시 시도해 남은 옛 파일은 건너뜀
      this.sec.epochKeys[String(epoch)] = k.toString("base64");
      return true;
    }
    return false;
  }

  /** 명부의 봉함(이름·채널)을 현재 세대 열쇠로 연다. 원격 문자열은 감독한다. */
  private openPlain(): Plain | null {
    const r = this.st.roster;
    const key = r ? this.key(r.epoch) : null;
    if (!r || !key) return null;
    const p = unseal(key, `roster|${this.cfg.spaceId}|${r.version}`, r.sealed) as Plain | null;
    if (!p || typeof p.spaceName !== "string" || !Array.isArray(p.channels) || typeof p.names !== "object") return null;
    const names: Record<string, string> = {};
    for (const [k, v] of Object.entries(p.names ?? {})) if (typeof v === "string") names[k] = this.d.guard(v.slice(0, 64), "userName");
    const channels = p.channels
      .filter((c) => c && typeof c.channelId === "string" && ID_RE.test(c.channelId) && typeof c.name === "string")
      .slice(0, 100)
      .map((c) => ({ channelId: c.channelId, name: this.d.guard(c.name.slice(0, 64), "channelName") }));
    return { spaceName: this.d.guard(p.spaceName.slice(0, 64), "spaceName"), names, channels };
  }

  /** 구성원: 명부 채널에 맞춰 거울 채널(로컬 영역)을 등록·해제한다. */
  private applyMirrors(): void {
    const plain = this.st.plain;
    if (!plain || this.cfg.role !== "member") return;
    const keep = new Set<string>();
    for (const c of plain.channels) {
      const id = this.mirrorId(c.channelId);
      keep.add(id);
      this.d.channels.register({ id, kind: "server", label: `${plain.spaceName}/${c.name}`, members: null }, path.join(this.dir, "mirror", `${c.channelId}.jsonl`));
    }
    const prefix = this.mirrorId("");
    for (const id of this.d.channels.ids()) if (id.startsWith(prefix) && !keep.has(id)) this.d.channels.unregister(id);
  }

  // ───────── 쓰기·읽기 ─────────

  /** 이 Hub의 로컬 세션이 쓴 새 메시지(출처 없음)를 조각으로 올린다. */
  private async writeOwn(): Promise<void> {
    const r = this.st.roster!;
    const key = this.key(r.epoch);
    if (!key) return;
    const pending: Message[] = [];
    for (const c of this.spaceChannels()) {
      const local = this.localId(c.channelId);
      const file = this.d.channels.fileOf(local);
      if (!file || !fs.existsSync(file)) continue;
      const after = this.st.lastSeq[local] ?? 0;
      for (const line of fs.readFileSync(file, "utf8").split("\n")) {
        if (!line) continue;
        try {
          const m = JSON.parse(line) as Message;
          if (typeof m.seq === "number" && m.seq > after && !m.origin) pending.push({ ...m, channelId: c.channelId });
        } catch {
          // 손상 줄 건너뜀
        }
      }
    }
    const localOf = new Map(this.spaceChannels().map((c) => [c.channelId, this.localId(c.channelId)]));
    for (const chunk of chunkMessages(pending)) {
      for (let tries = 0; ; tries++) {
        if (tries >= MAX_SQUAT) throw new StorageError("storage_bad_response");
        const index = this.st.myIndex;
        const createdAt = this.now();
        const p = `${this.root}/frag/${this.myHubId}/${new Date(createdAt).toISOString().slice(0, 10)}/${pad8(index)}.frag`;
        const f = encodeFragment({ header: { spaceId: this.cfg.spaceId, hubKey: this.d.keys.publicKeyB64, profile: "tls13-aes256gcm", epoch: r.epoch, index, prevHash: this.st.myHash, createdAt }, body: { messages: chunk }, spaceKey: key, privateKeyPem: this.d.keys.privateKeyPem });
        try {
          await this.backend.put(p, f.bytes);
        } catch (e) {
          if (!(e instanceof StorageError && e.code === "storage_bad_response")) throw e;
          // 이미 있음: 내가 서명한 이 번호의 조각이면(올라갔는데 응답만 잃음) 이어받고 처음부터 다시 모은다. 아니면(선점) 다음 번호로.
          const remote = await this.backend.get(p);
          const own = remote ? decodeFragment(remote, { spaceKey: key, expectHubKey: this.d.keys.publicKeyB64 }) : null;
          if (own?.ok && own.header.index === index && own.header.prevHash === this.st.myHash) {
            for (const m of own.body.messages) {
              const local = localOf.get(m.channelId);
              if (local) this.st.lastSeq[local] = Math.max(this.st.lastSeq[local] ?? 0, m.seq);
            }
            this.st.myIndex = index + 1;
            this.st.myHash = own.hash;
            this.save();
            return this.writeOwn();
          }
          this.st.myIndex++;
          continue;
        }
        for (const m of chunk) {
          const local = localOf.get(m.channelId)!;
          this.st.lastSeq[local] = Math.max(this.st.lastSeq[local] ?? 0, m.seq);
        }
        this.st.myIndex = index + 1;
        this.st.myHash = f.hash;
        this.save();
        break;
      }
    }
  }

  /** 다른 Hub들의 조각을 읽어 로컬 채널에 넣는다. */
  private async readOthers(): Promise<void> {
    const r = this.st.roster!;
    const plain = this.st.plain!;
    const writers: { hubId: string; hubKey: string; revoked?: Revoked }[] = [
      ...r.members.filter((m) => m.hubId !== this.myHubId).map((m) => ({ hubId: m.hubId, hubKey: m.hubKey })),
      ...r.revoked.filter((x) => x.hubId !== this.myHubId).map((x) => ({ hubId: x.hubId, hubKey: x.hubKey, revoked: x })),
    ];
    for (const w of writers) {
      const cur: Cursor = this.st.cursors[w.hubId] ?? { day: "", nextIndex: 0, lastHash: "" };
      const base = `${this.root}/frag/${w.hubId}`;
      const days = (await this.backend.list(base)).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && d >= cur.day).sort();
      outer: for (const day of days) {
        const files = (await this.backend.list(`${base}/${day}`)).filter((n) => /^\d{8}\.frag$/.test(n) && Number(n.slice(0, 8)) >= cur.nextIndex).sort();
        for (const name of files) {
          const bytes = await this.backend.get(`${base}/${day}/${name}`);
          if (!bytes) continue;
          const pk = peekFragment(bytes, w.hubKey);
          if (!pk.ok || pk.header.spaceId !== this.cfg.spaceId || pk.header.index !== Number(name.slice(0, 8)) || pk.header.prevHash !== cur.lastHash) {
            this.d.log("space1_fragment_rejected", { spaceId: this.cfg.spaceId, hubId: w.hubId, file: name, code: pk.ok ? "chain" : pk.code });
            continue; // 건너뜀(선점·변조) — 사슬은 그대로
          }
          if (w.revoked && (pk.header.epoch >= w.revoked.atEpoch || pk.header.index > w.revoked.lastIndex)) {
            this.d.log("space1_fragment_rejected", { spaceId: this.cfg.spaceId, hubId: w.hubId, file: name, code: "revoked" });
            continue;
          }
          const key = this.key(pk.header.epoch);
          if (!key) {
            if (this.st.joinEpoch !== null && pk.header.epoch < this.st.joinEpoch) {
              Object.assign(cur, { day, nextIndex: pk.header.index + 1, lastHash: pk.hash }); // 들어오기 전 세대 — 읽지 않고 사슬만 잇는다
              continue;
            }
            break outer; // 아직 받지 못한 새 세대 열쇠 — 다음 동기화에서
          }
          const dec = decodeFragment(bytes, { spaceKey: key, expectHubKey: w.hubKey });
          if (!dec.ok) {
            this.d.log("space1_fragment_rejected", { spaceId: this.cfg.spaceId, hubId: w.hubId, file: name, code: dec.code });
            continue;
          }
          for (const m of dec.body.messages) this.ingest(w.hubId, plain, m);
          Object.assign(cur, { day, nextIndex: pk.header.index + 1, lastHash: pk.hash });
        }
      }
      this.st.cursors[w.hubId] = cur;
    }
  }

  private ingest(hubId: string, plain: Plain, m: Message): void {
    if (!m || typeof m.channelId !== "string" || typeof m.text !== "string" || m.text.length > MAX_STORED_TEXT_LENGTH) return;
    if (!plain.channels.some((c) => c.channelId === m.channelId)) return;
    const local = this.localId(m.channelId);
    const ch = this.d.channels.getChannel(local);
    if (!ch) return;
    const origin: MessageOrigin = { scope: "remote", spaceName: plain.spaceName, hubUser: plain.names[hubId] ?? "?" };
    const text = this.d.guard(m.text, "text");
    if (text.length > MAX_STORED_TEXT_LENGTH) return;
    const fromName = this.d.guard(typeof m.fromName === "string" ? m.fromName.slice(0, 64) : "?", "fromName");
    const from = `${hubId}:${this.d.guard(typeof m.from === "string" ? m.from.slice(0, 128) : "?", "from")}`;
    const msg = this.d.channels.append(local, from, fromName, text, origin);
    this.d.deliver(ch, msg);
  }

  // ───────── 한 번 동기화 ─────────

  /** 한 번 동기화한다. 이미 도는 중이면 그 결과를 기다린다. 오류는 상태에 남기고 던지지 않는다. */
  tick(): Promise<void> {
    this.running ??= this.tickOnce().finally(() => { this.running = null; });
    return this.running;
  }

  private async tickOnce(): Promise<void> {
    try {
      if (this.cfg.role === "owner") {
        let changed = await this.processRequests();
        const chans = this.ownerChannels?.() ?? this.spaceChannels();
        if (JSON.stringify(chans) !== JSON.stringify(this.st.plain!.channels)) {
          this.st.plain = { ...this.st.plain!, channels: chans };
          changed = true;
        }
        if (changed) {
          const r = this.st.roster!;
          await this.writeRoster({ epoch: r.epoch, members: r.members, revoked: r.revoked }, this.st.plain!);
        }
      } else {
        await this.syncRoster();
        const r = this.st.roster;
        if (!r) { this.finish(); return; }
        if (!r.members.some((m) => m.hubId === this.myHubId)) {
          this.st.state = r.revoked.some((x) => x.hubId === this.myHubId) ? "revoked" : "pending";
          this.finish();
          return;
        }
        if (!(await this.ensureKey(r.epoch))) { this.st.state = "pending"; this.finish(); return; }
        this.st.joinEpoch ??= r.epoch;
        const plain = this.openPlain();
        if (!plain) { this.finish(); return; }
        this.st.plain = plain;
        this.st.state = "active";
        this.applyMirrors();
      }
      await this.writeOwn();
      await this.readOthers();
      this.st.lastError = null;
      this.st.lastSyncAt = this.now();
    } catch (e) {
      this.st.lastError = e instanceof StorageError ? e.code : (e as Error).message;
      this.d.log("space1_sync_failed", { spaceId: this.cfg.spaceId, code: this.st.lastError });
    }
    this.finish();
  }

  private finish(): void {
    this.save();
  }

  // ───────── 상태 ─────────

  get spaceId(): string {
    return this.cfg.spaceId;
  }

  get intervalSec(): number {
    return this.cfg.intervalSec;
  }

  status(): { spaceId: string; spaceName: string; role: "owner" | "member"; state: State["state"]; repo: string; epoch: number; members: { hubId: string; userName: string; revoked: boolean; me: boolean }[]; lastSyncAt: number | null; lastError: string | null } {
    const r = this.st.roster;
    const names = this.st.plain?.names ?? {};
    const members = [
      ...(r?.members ?? []).map((m) => ({ hubId: m.hubId, userName: names[m.hubId] ?? "?", revoked: false, me: m.hubId === this.myHubId })),
      ...(r?.revoked ?? []).map((x) => ({ hubId: x.hubId, userName: names[x.hubId] ?? "?", revoked: true, me: x.hubId === this.myHubId })),
    ];
    return { spaceId: this.cfg.spaceId, spaceName: this.st.plain?.spaceName ?? this.cfg.spaceName, role: this.cfg.role, state: this.st.state, repo: this.cfg.repo, epoch: r?.epoch ?? 0, members, lastSyncAt: this.st.lastSyncAt, lastError: this.st.lastError };
  }

  /** 구성원: 세션이 찾을 수 있게 목록에 보일 공간 서버·거울 채널(관리자 쪽은 원래 로컬 서버라 필요 없음). */
  listing(): { serverId: string; name: string; channelCount: number; remote: { spaceName: string; hubUser: string }; channels: { channelId: string; name: string }[] } | null {
    const plain = this.st.plain;
    if (this.cfg.role !== "member" || this.st.state !== "active" || !plain) return null;
    const host = plain.names[hubIdOf(this.cfg.ownerKey)] ?? "?";
    const channels = plain.channels.map((c) => ({ channelId: this.mirrorId(c.channelId), name: c.name }));
    return { serverId: `s1:${this.cfg.spaceId}`, name: plain.spaceName, channelCount: channels.length, remote: { spaceName: plain.spaceName, hubUser: host }, channels };
  }

  /** 이 PC에서 공간을 빼고(거울 채널 해제) 로컬 상태를 지운다. 저장소의 파일은 그대로 둔다. */
  leave(): void {
    const prefix = this.mirrorId("");
    for (const id of this.d.channels.ids()) if (id.startsWith(prefix)) this.d.channels.unregister(id);
    fs.rmSync(this.dir, { recursive: true, force: true });
  }
}
