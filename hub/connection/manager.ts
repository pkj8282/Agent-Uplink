// 통신 관리자(v3.0): Hub와 통신 부품(상태 저장·리스너·참여 클라이언트·Connection Communications)을 잇는다.
// 통신 서버 쪽(A): 공유 채널만 구성원에게 보이고, 구성원이 보낸 메시지는 감독 뒤 저장·전달한다.
// 참여자 쪽(B): 공유 채널을 r:<spaceId>:<channelId> 거울 채널로 두고, 서버가 보낸 이벤트도 다시 감독한다(서버를 믿지 않음).
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { MAX_READ_LIMIT, MAX_STORED_TEXT_LENGTH, MAX_TEXT_LENGTH, NAME_MAX, type AccountInfo, type Channel, type Message, type MessageOrigin } from "../../shared/protocol.js";
import { newJoinToken, spkiFingerprint } from "../../shared/connCrypto.js";
import { decodeInvite, encodeInvite } from "../../shared/invite.js";
import type { ProfileId } from "../../shared/cryptoProfile.js";
import type { ConnEvent, ConnRequest, ConnRequestBody, RemoteAccount, SharedServer } from "../../shared/connProtocol.js";
import { writeFileAtomic } from "../fsutil.js";
import { isSafeAccountId } from "../ids.js";
import { validateName } from "../names.js";
import type { AccountStore, Account } from "../accounts.js";
import type { ChannelStore } from "../channels.js";
import type { Guard } from "../securityLog.js";
import type { ConnStatusSource } from "../server.js";
import { ConnectionStore, type JoinedSpace, type ServerConfig } from "./store.js";
import { ConnListener, type ConnPeer } from "./listener.js";
import { ConnClient, joinSpace } from "./client.js";
import { CommsStore } from "./comms.js";
import { Uploader, type StorageConfig } from "./storage/uploader.js";
import { GitHubBackend } from "./storage/github.js";
import { SupabaseBackend } from "./storage/supabase.js";
import { Lifecycle } from "./lifecycle.js";
import { SpaceSync, type SpaceChannel, type SpaceDeps } from "./space1/sync.js";
import type { StorageBackend } from "./storage/backend.js";
import { parseRecoveryKey, restoreBackup, scanBackups, type BackupCandidate } from "./storage/restore.js";
import { DEFAULT_PROFILE } from "../../shared/cryptoProfile.js";
import { Mesh, meshIdOf, type MeshSelf } from "./mesh/mesh.js";
import { Governance, RELAY_WINDOW, type CaseChoice, type GovCommand } from "./mesh/governance.js";
import { LinkDialer, joinLink, type LinkSelf } from "./mesh/link.js";
import type { LinkRecord } from "./store.js";

export interface ManagerDeps {
  dataDir: string;
  accounts: AccountStore;
  channels: ChannelStore;
  guard: Guard;
  /** 로컬 인박스로 전달(Hub.fanout). skipUuid = 보낸 로컬 계정(자기 메아리 제외). */
  deliver(ch: Channel, msg: Message, skipUuid?: string): void;
  backoffMs?: number[];
  /** 시험 전용: 저장소 API 주소. */
  storageApiBase?: string;
  /** 시험 전용: Supabase http 가짜 서버 허용. */
  supabaseInsecureForTest?: boolean;
  /** 시험 전용: 방식 1 공간 저장소(가짜). */
  space1BackendForTest?: (repo: string) => StorageBackend;
  /** 방식 1 관리자: 로컬 서버(채널 묶음) 정보. */
  localServer?: (serverId: string) => { name: string; channels: SpaceChannel[] } | null;
}

interface SpaceState {
  space: JoinedSpace;
  client: ConnClient;
  shared: SharedServer[];
  accounts: RemoteAccount[];
}

const REMOTE_PREFIX = "r:";
const MAX_REMOTE_ACCOUNTS = 200;
const MAX_REMOTE_SERVERS = 100;
/** c_read 응답의 메시지 바이트 상한 — 참여자 쪽 프레임 상한(4MB)보다 넉넉히 작게. */
const C_READ_MAX_BYTES = 2 * 1024 * 1024;
/** 구성원 한 명의 읽기·목록·계정 알림 요청 상한(10초). 다시 채우기는 공유 채널마다 한 번씩이라 넉넉히. */
const READ_PER_10S = 120;
/** 다시 채우다 rate_limited를 받았을 때 기다렸다 재시도하는 횟수. */
const SYNC_RETRIES = 5;

export class ConnectionManager implements ConnStatusSource {
  readonly store: ConnectionStore;
  readonly comms: CommsStore;
  private listener: ConnListener | null = null;
  private listening = false;
  private peers = new Set<ConnPeer>();
  private memberAccounts = new Map<string, { uuid: string; name: string; description: string }[]>();
  private spaces = new Map<string, SpaceState>();
  private tap: ((o: object) => void) | null = null;
  /** 방식 3(v3.0 5단계) 망 엔진·거버넌스·내가 거는 서버 연결. */
  private mesh: Mesh | null = null;
  private gov: Governance | null = null;
  private dialers = new Map<string, LinkDialer>();
  private meshTimers: NodeJS.Timeout[] = [];
  /** 구성원별 최근 전송 시각(설계 5.2 "참여자별 메시지 속도 제한", RT-C16). */
  private sendTimes = new Map<string, number[]>();
  private readTimes = new Map<string, number[]>();
  private readLimit = { max: READ_PER_10S, windowMs: 10_000 };
  private rateRetryMs = 10_000;

  /** 구성원 한 명은 10초에 60개까지. */
  private allowRead(memberId: string): boolean {
    const now = Date.now();
    const { max, windowMs } = this.readLimit;
    const list = (this.readTimes.get(memberId) ?? []).filter((t) => now - t < windowMs);
    const ok = list.length < max;
    if (ok) list.push(now);
    this.readTimes.set(memberId, list);
    return ok;
  }

  private allowSend(memberId: string): boolean {
    const now = Date.now();
    const list = (this.sendTimes.get(memberId) ?? []).filter((t) => now - t < 10_000);
    const ok = list.length < 60;
    if (ok) list.push(now);
    this.sendTimes.set(memberId, list);
    return ok;
  }
  /** 최근 통신 기록(보안·연결 사건) — 관리 앱 통신 탭에 최근 50개. */
  readonly events: { ts: number; code: string; detail: object }[] = [];

  constructor(private readonly deps: ManagerDeps) {
    this.store = new ConnectionStore({ dataDir: deps.dataDir });
    this.comms = new CommsStore({ dataDir: deps.dataDir, guard: deps.guard });
    // 백업 업로더(3단계): 이 Hub의 Connection Communications 채널만 올린다(원격 거울 r: 채널은 그 공간의 서버가 올림).
    this.uploader = new Uploader({
      dir: path.join(this.store.dir, "storage"),
      spaceId: () => this.store.serverConfig()?.spaceId ?? null,
      profile: () => this.store.serverConfig()?.profile ?? DEFAULT_PROFILE,
      keys: () => this.store.identity(),
      // 방식 3: 망 경우에 따라 내 채널을 올릴지·거울도 올릴지(메인·지정 서버)
      channels: () => {
        const plan = this.gov?.uploadPlan() ?? { own: true, mirrors: [] };
        const own = plan.own ? this.comms.servers().flatMap((s) => s.channels.map((c) => ({ id: c.id, name: `${s.name}/${c.name}`, logFile: this.comms.logPath(c.id) }))) : [];
        const mirrors = plan.mirrors.flatMap((id) => { const f = this.deps.channels.fileOf(id); return f ? [{ id, name: this.deps.channels.getChannel(id)?.label ?? id, logFile: f }] : []; });
        return [...own, ...mirrors];
      },
      makeBackend: (cfg, token) => this.makeStorageBackend(cfg, token),
      log: (code, detail) => this.log(code, detail),
      prune: (id, keep) => deps.channels.prune(id, keep),
    });
  }

  readonly uploader: Uploader;

  private makeStorageBackend(cfg: StorageConfig, token: string): StorageBackend {
    if (cfg.kind === "supabase") {
      return new SupabaseBackend({ url: cfg.url ?? "", key: token, bucket: cfg.bucket ?? "agent-uplink", ...(this.deps.supabaseInsecureForTest ? { allowInsecureForTest: true } : {}) });
    }
    return new GitHubBackend({ token, repo: cfg.repo ?? "", ...(cfg.branch ? { branch: cfg.branch } : {}), ...(this.deps.storageApiBase ? { apiBase: this.deps.storageApiBase } : {}) });
  }

  // ───────── 다른 PC 백업 복원(v3.0 7단계) ─────────

  private restoreKey(recoveryKey: string): Buffer {
    const k = parseRecoveryKey(recoveryKey);
    if (!k) throw new Error("recovery_key_invalid");
    return k;
  }

  /** 복구 키로 풀리는 백업 찾기. 저장소에 쓰지 않고 토큰·키를 저장하지 않는다. */
  async restoreScan(cfg: StorageConfig, token: string, recoveryKey: string): Promise<BackupCandidate[]> {
    const key = this.restoreKey(recoveryKey);
    const backend = this.makeStorageBackend(cfg, token);
    await backend.check();
    return scanBackups(backend, key);
  }

  /** 백업 하나를 새 통신 서버로 되살린다. 되살린 메시지는 인박스로 보내지 않는다(지난 대화). */
  async restore(cfg: StorageConfig, token: string, recoveryKey: string, target: { spaceId: string; hubId: string }, serverName: string):
    Promise<{ serverId: string; channelCount: number; messageCount: number; breaks: number[]; bad: { path: string; code: string }[] }> {
    const key = this.restoreKey(recoveryKey);
    const name = validateName(serverName, "server", (s) => this.g(s, "restore", "serverName"));
    if (!name.ok) throw new Error("name_invalid");
    const r = await restoreBackup(this.makeStorageBackend(cfg, token), key, target);
    if (r.channels.length === 0) throw new Error("restore_empty");
    const serverId = this.comms.createServer(name.name).id;
    let messages = 0;
    r.channels.forEach((ch, i) => {
      const raw = Array.from(ch.name ?? "").slice(0, NAME_MAX).join("");
      const v = validateName(raw, "channel", (s) => this.g(s, "restore", "channelName"));
      const chId = this.createCommsChannel(serverId, v.ok ? v.name : `#${i + 1}`);
      for (const m of ch.messages) {
        if (m.text.length > MAX_STORED_TEXT_LENGTH) continue;
        const o = m.origin;
        const msg = this.deps.channels.appendExternal(chId, {
          seq: m.seq,
          ts: typeof m.ts === "number" ? m.ts : 0,
          from: this.g(String(m.from ?? "?").slice(0, 300), "restore", "from"),
          fromName: this.nameOf(m.fromName, "restore") ?? "?",
          text: this.g(m.text, "restore", "text", true),
          ...(o && typeof o === "object" ? { origin: { scope: "remote" as const, spaceName: this.g(String(o.spaceName ?? ""), "restore", "spaceName"), hubUser: this.g(String(o.hubUser ?? ""), "restore", "hubUser") } } : {}),
        });
        if (msg) messages++;
      }
    });
    this.log("storage_restored", { channels: r.channels.length, messages, breaks: r.breaks.length, bad: r.bad.length });
    return { serverId, channelCount: r.channels.length, messageCount: messages, breaks: r.breaks, bad: r.bad };
  }
  private lifecycle: Lifecycle | null = null;
  /** 방식 1 공간들(v3.0 4단계)과 동기화 타이머. */
  private spaces1 = new Map<string, { sync: SpaceSync; timer: NodeJS.Timeout | null }>();

  private space1Deps(): SpaceDeps {
    return {
      spacesDir: path.join(this.store.dir, "spaces1"),
      keys: this.store.identity(),
      channels: this.deps.channels,
      makeBackend: (repo, branch, token) => this.deps.space1BackendForTest?.(repo) ?? new GitHubBackend({ token, repo, ...(branch ? { branch } : {}), ...(this.deps.storageApiBase ? { apiBase: this.deps.storageApiBase } : {}) }),
      deliver: (ch, msg) => this.deps.deliver(ch, msg),
      guard: (s, field) => this.g(s, "space1", field, field === "text"),
      log: (code, detail) => this.log(code, detail),
      userName: () => this.userName(),
    };
  }

  private ownerChannelsOf(serverId: string | undefined): () => SpaceChannel[] {
    return () => (serverId ? this.deps.localServer?.(serverId)?.channels ?? [] : []);
  }

  private runSpace1(sync: SpaceSync): void {
    this.spaces1.get(sync.spaceId)?.timer && clearInterval(this.spaces1.get(sync.spaceId)!.timer!);
    const timer = setInterval(() => { void sync.tick(); }, Math.max(10, sync.intervalSec) * 1000);
    timer.unref();
    this.spaces1.set(sync.spaceId, { sync, timer });
  }

  private loadSpaces1(): void {
    const dir = path.join(this.store.dir, "spaces1");
    let ids: string[] = [];
    try { ids = fs.readdirSync(dir); } catch { return; }
    for (const id of ids) {
      const cfg = (() => { try { return JSON.parse(fs.readFileSync(path.join(dir, id, "config.json"), "utf8")) as { localServerId?: string }; } catch { return null; } })();
      const s = cfg ? SpaceSync.load(this.space1Deps(), id, this.ownerChannelsOf(cfg.localServerId)) : null;
      if (s) { this.runSpace1(s); void s.tick(); }
    }
  }

  private space1(spaceId: string): SpaceSync {
    const s = this.spaces1.get(spaceId)?.sync;
    if (!s) throw new Error("space1_not_found");
    return s;
  }

  /** 방식 1 공간 만들기(관리자). 고른 로컬 서버의 채널이 공간 채널이 된다. */
  async space1Create(o: { spaceName: string; localServerId: string; repo: string; branch?: string; token: string; intervalSec: number }): Promise<string> {
    const name = validateName(o.spaceName, "server", (s) => this.g(s, "s1_create", "spaceName"));
    if (!name.ok) throw new Error("name_invalid");
    if (!this.deps.localServer?.(o.localServerId)) throw new Error("server_not_found");
    const s = await SpaceSync.createAsOwner(this.space1Deps(), { spaceName: name.name, repo: o.repo, ...(o.branch ? { branch: o.branch } : {}), token: o.token, intervalSec: o.intervalSec, localServerId: o.localServerId, ownerChannels: this.ownerChannelsOf(o.localServerId) });
    this.ensureStarted();
    this.runSpace1(s);
    return s.spaceId;
  }

  space1Invite(spaceId: string, label: string, expiresInMs: number): string {
    const n = this.nameOf(label, "s1_invite");
    if (!n) throw new Error("name_invalid");
    return this.space1(spaceId).invite(n, expiresInMs);
  }

  async space1Join(code: string, token: string): Promise<string> {
    const s = await SpaceSync.join(this.space1Deps(), code, token);
    this.ensureStarted();
    this.runSpace1(s);
    void s.tick();
    return s.spaceId;
  }

  space1Revoke(spaceId: string, hubId: string): Promise<boolean> {
    return this.space1(spaceId).revoke(hubId);
  }

  /** list_servers에 붙는 방식 1 공간(구성원 쪽, 로컬·연결 계정 모두). */
  space1ServersFor(): { serverId: string; name: string; channelCount: number; remote: { spaceName: string; hubUser: string } }[] {
    return [...this.spaces1.values()].map((x) => x.sync.listing()).filter((l) => l !== null).map(({ channels: _c, ...rest }) => rest);
  }

  space1ChannelsFor(serverId: string): { channelId: string; name: string }[] | null {
    for (const x of this.spaces1.values()) {
      const l = x.sync.listing();
      if (l && l.serverId === serverId) return l.channels;
    }
    return null;
  }

  space1Status(): ReturnType<SpaceSync["status"]>[] {
    return [...this.spaces1.values()].map((x) => x.sync.status());
  }

  async space1SyncNow(spaceId: string): Promise<ReturnType<SpaceSync["status"]>> {
    const s = this.space1(spaceId);
    await s.tick();
    return s.status();
  }

  space1Leave(spaceId: string): void {
    const x = this.spaces1.get(spaceId);
    if (!x) throw new Error("space1_not_found");
    if (x.timer) clearInterval(x.timer);
    x.sync.leave();
    this.spaces1.delete(spaceId);
  }

  /** 이번 실행의 시작 사건을 한 번 기록한다(통신을 처음 켠 실행 포함). 이미 기록했으면 아무것도 안 함. */
  private ensureStarted(): void {
    if (this.lifecycle) return;
    this.lifecycle = new Lifecycle(path.join(this.store.dir, "lifecycle.jsonl"));
    this.lifecycle.recordStart(Date.now());
  }

  /** 저장소 연결(관리 op). 통신 서버 공간이 있어야 한다. */
  storageSet(cfg: StorageConfig, token: string): Promise<{ recoveryKey: string }> {
    if (!this.store.serverConfig()) throw new Error("server_not_enabled");
    return this.uploader.configure(cfg, token).then((r) => { this.ensureStarted(); this.uploader.start(); return r; });
  }

  private log(code: string, detail: object = {}): void {
    this.events.push({ ts: Date.now(), code, detail });
    if (this.events.length > 200) this.events.shift();
  }

  /** 원격 문자열 감독(숨은 문자 → 보이는 이스케이프). */
  private g(s: string, where: string, field: string, keepLineBreaks = false): string {
    return this.deps.guard(s, { source: "request", where, field, ...(keepLineBreaks ? { keepLineBreaks: true } : {}) });
  }

  private nameOf(raw: unknown, where: string): string | null {
    const v = validateName(raw, "account", (s) => this.g(s, where, "name"));
    return v.ok ? v.name : null;
  }

  // ───────── 시작·정지·상태 ─────────

  async start(): Promise<void> {
    if (!this.store.exists()) return; // 통신을 켠 적 없는 Hub — 아무것도 하지 않는다
    this.registerComms();
    const cfg = this.store.serverConfig();
    if (cfg?.enabled) {
      try {
        await this.startListener(cfg);
      } catch (e) {
        this.log("listen_failed", { message: (e as Error).message });
      }
    }
    for (const j of this.store.joined()) this.startSpace(j);
    this.loadSpaces1();
    // 방식 3: 망을 쓴 적 있는 Hub만(폴더 또는 서버 연결이 있을 때)
    if (this.store.serverConfig() && (fs.existsSync(this.meshDir()) || this.store.links().some((l) => !l.removed))) {
      this.ensureMesh();
      for (const l of this.store.links()) if (l.dir === "out" && !l.removed) this.startDialer(l);
    }
    // 가동 사건 기록(사용자 설계): 지난 실행이 정상 종료 보고 없이 끝났으면 비정상 종료 — 밀린 백업을 바로 올린다.
    const clean = new Lifecycle(path.join(this.store.dir, "lifecycle.jsonl")).lastRunClean();
    this.ensureStarted();
    if (clean === false) {
      this.log("unclean_shutdown_detected");
      if (this.uploader.status().configured) void this.uploader.uploadNow().catch(() => undefined);
    }
    if (this.uploader.status().configured) this.uploader.start();
  }

  async stop(): Promise<void> {
    await this.uploader.stop(); // 정상 종료 직전 마지막 업로드(설계 4.2)
    // 방식 1 공간: 타이머를 멈추고 마지막으로 한 번 동기화(최대 5초)
    const last: Promise<void>[] = [];
    for (const x of this.spaces1.values()) { if (x.timer) clearInterval(x.timer); last.push(x.sync.tick()); }
    await Promise.race([Promise.all(last), new Promise((r) => setTimeout(r, 5000).unref())]);
    this.spaces1.clear();
    // 정상 종료 보고는 마지막 업로드를 끝낸 뒤에(Hub가 직접 쓴다).
    if (this.lifecycle) {
      this.lifecycle.recordCleanStop(Date.now(), this.uploader.chainHead());
      this.lifecycle = null;
    }
    for (const st of this.spaces.values()) st.client.stop();
    this.spaces.clear();
    for (const t of this.meshTimers) clearInterval(t);
    this.meshTimers = [];
    for (const d of this.dialers.values()) d.stop();
    this.dialers.clear();
    this.mesh?.stop();
    const l = this.listener;
    this.listener = null;
    this.listening = false;
    this.peers.clear();
    await l?.close();
  }

  hasLiveConnection(): boolean {
    if (this.listening) return true;
    for (const st of this.spaces.values()) if (st.client.connected) return true;
    for (const d of this.dialers.values()) if (d.connected) return true;
    return false;
  }

  userName(): string {
    return this.store.userName() ?? "user";
  }

  setUserName(name: string): string {
    const n = this.nameOf(name, "conn_set_user");
    if (!n) throw new Error("name_invalid");
    this.store.setUserName(n);
    this.accountsChanged();
    return n;
  }

  // ───────── 통신 서버(A) ─────────

  async enableServer(o: { port: number; bindHost?: string; profile: ProfileId; spaceName: string; burnOnJoin: boolean }): Promise<number> {
    const prev = this.store.serverConfig();
    const spaceName = validateName(o.spaceName, "server", (s) => this.g(s, "conn_enable", "spaceName"));
    if (!spaceName.ok) throw new Error("name_invalid");
    const cfg: ServerConfig & { bindHost?: string } = {
      enabled: true, port: o.port, profile: o.profile, spaceId: prev?.spaceId ?? randomUUID(), spaceName: spaceName.name,
      burnOnJoin: o.burnOnJoin, shared: prev?.shared ?? [], ...(o.bindHost ? { bindHost: o.bindHost } : {}),
    };
    this.store.setServerConfig(cfg);
    this.ensureStarted();
    this.registerComms();
    if (this.listener) await this.listener.close();
    const port = await this.startListener(cfg);
    if (o.port === 0) this.store.setServerConfig({ ...cfg, port }); // 재시작 때 같은 포트로(초대 코드가 가리키는 곳)
    return port;
  }

  async disableServer(): Promise<void> {
    const cfg = this.store.serverConfig();
    if (cfg) this.store.setServerConfig({ ...cfg, enabled: false });
    const l = this.listener;
    this.listener = null;
    this.listening = false;
    this.peers.clear();
    await l?.close();
  }

  private async startListener(cfg: ServerConfig & { bindHost?: string }): Promise<number> {
    const l = new ConnListener({
      store: this.store,
      cleanName: (s) => this.g(s, "conn_join", "userName"),
      tap: (o) => this.tap?.(o),
      onPeer: (p) => this.onPeer(p),
      onPeerGone: (p) => this.peers.delete(p),
      handle: (p, req, reply) => this.handle(p, req, reply),
      log: (code, detail) => this.log(code, detail),
      onLink: (rec, ch) => {
        const mesh = this.ensureMesh();
        if (mesh) mesh.attach({ spaceId: meshIdOf(rec.serverKey), spaceName: rec.spaceName, serverKey: rec.serverKey }, ch);
        else ch.close();
      },
    });
    const port = await l.listen(cfg.port, cfg.bindHost ?? "0.0.0.0");
    this.listener = l;
    this.listening = true;
    return port;
  }

  createCommsServer(name: string): string {
    const v = validateName(name, "server", (s) => this.g(s, "conn_create_server", "name"));
    if (!v.ok) throw new Error("name_invalid");
    return this.comms.createServer(v.name).id;
  }

  createCommsChannel(serverId: string, name: string): string {
    const srv = this.comms.getServer(serverId);
    if (!srv) throw new Error("server_not_found");
    const v = validateName(name, "channel", (s) => this.g(s, "conn_create_channel", "name"));
    if (!v.ok) throw new Error("name_invalid");
    const ch = this.comms.addChannel(serverId, v.name);
    this.deps.channels.register({ id: ch.id, kind: "server", label: `${srv.name}/${ch.name}`, members: null, area: "connection" }, this.comms.logPath(ch.id));
    this.broadcastShared();
    return ch.id;
  }

  /** Connection Communications 채널을 Hub 채널 목록에 올린다(연결 계정 전용). */
  private registerComms(): void {
    for (const s of this.comms.servers()) {
      for (const c of s.channels) {
        this.deps.channels.register({ id: c.id, kind: "server", label: `${s.name}/${c.name}`, members: null, area: "connection" }, this.comms.logPath(c.id));
      }
    }
  }

  setShared(serverIds: string[]): void {
    const cfg = this.store.serverConfig();
    if (!cfg) throw new Error("server_not_configured");
    const exists = new Set(this.comms.servers().map((s) => s.id));
    this.store.setServerConfig({ ...cfg, shared: serverIds.filter((id) => exists.has(id)) });
    this.broadcastShared();
  }

  private sharedServers(): SharedServer[] {
    const cfg = this.store.serverConfig();
    const out = cfg ? this.comms.shared(cfg.shared) : [];
    // 방식 3: 망 서버의 공유 채널도 구성원에게(구성원은 이 서버를 거쳐 읽고 씀)
    for (const s of this.meshServers()) out.push({ serverId: `m.${s.spaceId}`, name: `mesh:${s.spaceName}`, channels: s.channels });
    return out;
  }

  /** 거울이 실제로 있는 망 서버와 채널(채널 ID = 거울 ID). */
  private meshServers(): { spaceId: string; spaceName: string; channels: { channelId: string; name: string }[] }[] {
    const mesh = this.mesh;
    if (!mesh) return [];
    return mesh.servers().map((s) => ({
      spaceId: s.spaceId,
      spaceName: s.spaceName,
      channels: s.channels.map((c) => ({ channelId: mesh.mirrorId(s.spaceId, c.id), name: c.name })).filter((c) => !!this.deps.channels.getChannel(c.channelId)),
    })).filter((s) => s.channels.length > 0);
  }

  private sharedChannel(channelId: unknown): Channel | null {
    if (typeof channelId !== "string") return null;
    for (const s of this.sharedServers()) {
      if (s.channels.some((c) => c.channelId === channelId)) return this.deps.channels.getChannel(channelId) ?? null;
    }
    return null;
  }

  createInvite(label: string, host: string, expiresInMs: number): { code: string; ipWarning: boolean } {
    const cfg = this.store.serverConfig();
    if (!cfg?.enabled) throw new Error("server_not_enabled");
    const memberName = this.nameOf(label, "conn_invite");
    if (!memberName) throw new Error("name_invalid");
    const keys = this.store.identity();
    const token = newJoinToken();
    const expiresAt = Date.now() + expiresInMs;
    this.store.addInvite(token, memberName, expiresAt);
    const code = encodeInvite({
      v: 1, kind: "join", spaceId: cfg.spaceId, spaceName: cfg.spaceName, profile: cfg.profile,
      endpoint: { type: "direct", host, port: cfg.port }, serverKey: keys.publicKeyB64, token, expiresAt, hostUser: this.userName(), memberName,
    }, keys.privateKeyPem);
    // 직접 연결은 참여자에게 이 PC의 주소(공인 IP면 대략적 지역·통신사)가 보인다(설계 5.6).
    return { code, ipWarning: true };
  }

  /** 구성원 퇴출(설계 5.3): 공개키 무효 → 인증·재참여 거부, 즉시 끊기, 계정 목록에서 제거. 이미 퇴출됐으면 아무것도 하지 않고 true. */
  revoke(memberId: string): boolean {
    const before = this.store.member(memberId);
    if (before?.revoked) return true;
    const ok = this.store.revoke(memberId);
    if (ok) this.log("member_revoked", { memberId, userName: before!.userName });
    this.listener?.disconnect(memberId);
    this.memberAccounts.delete(memberId);
    if (ok) this.broadcastAccounts();
    return ok;
  }

  private onPeer(p: ConnPeer): void {
    this.peers.add(p);
    p.send({ event: "shared", servers: this.sharedServers() });
    p.send({ event: "accounts", accounts: this.accountsWire() });
  }

  private broadcast(e: ConnEvent): void {
    for (const p of this.peers) p.send(e);
  }

  private broadcastShared(): void {
    if (this.peers.size > 0) this.broadcast({ event: "shared", servers: this.sharedServers() });
  }

  private broadcastAccounts(): void {
    if (this.peers.size > 0) this.broadcast({ event: "accounts", accounts: this.accountsWire() });
  }

  /** 서버 쪽에서 본 전체 연결 계정(서버 자신 + 각 구성원). uuid에 출처 이름공간을 붙인다. */
  private accountsWire(): RemoteAccount[] {
    const out: RemoteAccount[] = [];
    for (const a of this.deps.accounts.list()) {
      if (a.area === "connection") out.push({ uuid: `host:${a.uuid}`, name: a.name, description: a.description ?? "", hubUser: this.userName(), memberId: "host" });
    }
    for (const [memberId, list] of this.memberAccounts) {
      const m = this.store.member(memberId);
      if (!m || m.revoked) continue;
      for (const a of list) out.push({ uuid: `${memberId}:${a.uuid}`, name: a.name, description: a.description, hubUser: m.userName, memberId });
    }
    return out;
  }

  private handle(p: ConnPeer, req: ConnRequest, reply: (r: object) => void): void {
    const fail = (code: string) => reply({ ok: false, code });
    if ((req.op === "c_list" || req.op === "c_read" || req.op === "c_accounts") && !this.allowRead(p.memberId)) {
      this.log("rate_limited", { memberId: p.memberId, op: req.op });
      return fail("rate_limited");
    }
    switch (req.op) {
      case "c_list":
        return reply({ ok: true, servers: this.sharedServers() });
      case "c_read": {
        const ch = this.sharedChannel(req.channelId);
        if (!ch) return fail("channel_forbidden");
        const limit = typeof req.limit === "number" && req.limit > 0 ? Math.min(req.limit, MAX_READ_LIMIT) : 100;
        // 응답 프레임이 참여자 쪽 상한(4MB)을 넘으면 참여자가 연결을 끊고 다시 붙어 같은 요청을 되풀이한다
        // → 가장 최근 메시지부터 바이트 상한까지만(가장 최근 하나는 항상).
        const all = this.deps.channels.recent(ch.id, limit).map((m) => this.wire(m));
        const out: typeof all = [];
        let bytes = 0;
        for (let i = all.length - 1; i >= 0; i--) {
          const size = Buffer.byteLength(JSON.stringify(all[i]));
          if (out.length > 0 && bytes + size > C_READ_MAX_BYTES) break;
          out.push(all[i]);
          bytes += size;
        }
        return reply({ ok: true, messages: out.reverse() });
      }
      case "c_send": {
        if (!this.allowSend(p.memberId)) {
          this.log("rate_limited", { memberId: p.memberId });
          return fail("rate_limited");
        }
        const ch = this.sharedChannel(req.channelId);
        if (!ch) return fail("channel_forbidden");
        if (typeof req.text !== "string" || req.text.length === 0) return fail("text_invalid");
        if (req.text.length > MAX_TEXT_LENGTH) return fail("text_too_long");
        const from = req.from as { uuid?: unknown; name?: unknown } | undefined;
        if (!from || typeof from.uuid !== "string" || !isSafeAccountId(from.uuid)) return fail("from_invalid");
        const fromName = this.nameOf(from.name, "conn_send");
        if (!fromName) return fail("from_invalid");
        const text = this.deps.guard(req.text, { source: "request", where: "conn_send", field: "text", account: p.memberId, keepLineBreaks: true });
        if (text.length > MAX_STORED_TEXT_LENGTH) return fail("text_hidden_too_long");
        if (this.mesh?.parseMirror(ch.id)) {
          // 방식 3 중계 쓰기: 이 서버가 서명해 대상 서버로(저장·전달은 대상 서버의 기록이 퍼지며 이뤄짐)
          void this.mesh.relayWrite({ mirrorId: ch.id, from: `${p.memberId}:${from.uuid}`, fromName, hubUser: p.userName, text })
            .then((r) => reply(r.ok ? { ok: true, seq: r.seq } : { ok: false, code: r.code }));
          return;
        }
        const origin: MessageOrigin = { scope: "remote", spaceName: this.store.serverConfig()?.spaceName ?? "", hubUser: p.userName };
        const msg = this.deps.channels.append(ch.id, `${p.memberId}:${from.uuid}`, fromName, text, origin);
        this.deps.deliver(ch, msg);
        this.broadcast(this.msgEvent(msg));
        this.mesh?.onOwnMessage(ch.id, msg);
        return reply({ ok: true, seq: msg.seq });
      }
      case "c_accounts": {
        if (!Array.isArray(req.accounts) || req.accounts.length > MAX_REMOTE_ACCOUNTS) return fail("accounts_invalid");
        const list: { uuid: string; name: string; description: string }[] = [];
        for (const a of req.accounts as unknown[]) {
          const x = a as { uuid?: unknown; name?: unknown; description?: unknown };
          const name = this.nameOf(x?.name, "conn_accounts");
          if (typeof x?.uuid !== "string" || !isSafeAccountId(x.uuid) || !name) continue;
          const description = typeof x.description === "string" ? this.g(x.description.slice(0, 500), "conn_accounts", "description") : "";
          list.push({ uuid: x.uuid, name, description });
        }
        this.memberAccounts.set(p.memberId, list);
        this.broadcastAccounts();
        return reply({ ok: true });
      }
      default:
        return fail("op_not_allowed");
    }
  }

  /** 저장된 메시지 → 전송 형태. 서버 자신의 계정이 쓴 메시지에는 서버 사용자 이름으로 출처를 붙인다. */
  private wire(m: Message): Omit<Extract<ConnEvent, { event: "msg" }>, "event"> {
    const origin: MessageOrigin = m.origin ?? { scope: "remote", spaceName: this.store.serverConfig()?.spaceName ?? "", hubUser: this.userName() };
    const from = m.origin ? m.from : `host:${m.from}`;
    return { channelId: m.channelId, seq: m.seq, ts: m.ts, from, fromName: m.fromName, text: m.text, origin };
  }

  private msgEvent(m: Message): ConnEvent {
    return { event: "msg", ...this.wire(m) };
  }

  /** Hub가 통신 채널에 로컬(서버 자신의) 메시지를 저장한 뒤 부른다 — 공유 채널이면 구성원에게. */
  onLocalMessage(ch: Channel, msg: Message): void {
    if (ch.area !== "connection" || ch.id.startsWith(REMOTE_PREFIX)) return;
    this.mesh?.onOwnMessage(ch.id, msg);
    if (!this.sharedChannel(ch.id)) return;
    this.broadcast(this.msgEvent(msg));
  }

  /** 연결 계정 목록이 바뀌었을 때(새 계정·이름·설명) — 구성원과 참여 공간에 다시 알린다. */
  accountsChanged(): void {
    this.broadcastAccounts();
    for (const st of this.spaces.values()) if (st.client.connected) void this.pushAccounts(st);
  }

  // ───────── 참여자(B) ─────────

  async join(code: string): Promise<{ ok: true; spaceId: string } | { ok: false; code: string }> {
    const d = decodeInvite(code, Date.now());
    if (!d.ok) return d;
    // 초대의 공간 ID는 서명자가 정한다 — 같은 ID에 다른 키면 고정 키를 덮어쓰지 않고 거부(네트워크 호출 전에).
    const had = this.store.joined().find((s) => s.spaceId === d.invite.spaceId);
    if (had && had.serverKey !== d.invite.serverKey) return { ok: false, code: "space_key_changed" };
    const r = await joinSpace(d.invite, this.store.identity(), this.userName());
    if (!r.ok) return had ? { ok: true, spaceId: had.spaceId } : r; // 이미 있는 공간: 같은 초대를 다시 넣은 것 — 기존 연결을 그대로 둔다
    this.store.addJoined(r.space);
    this.ensureStarted();
    this.startSpace(r.space);
    return { ok: true, spaceId: r.space.spaceId };
  }

  private sharedFile(spaceId: string): string {
    return path.join(this.store.dir, "remote", spaceId, "shared.json");
  }

  private startSpace(space: JoinedSpace): void {
    this.spaces.get(space.spaceId)?.client.stop();
    const st: SpaceState = { space, client: null as unknown as ConnClient, shared: [], accounts: [] };
    try {
      const saved = JSON.parse(fs.readFileSync(this.sharedFile(space.spaceId), "utf8")) as SharedServer[];
      this.applyShared(st, saved, false);
    } catch {
      // 아직 받은 공유 목록 없음
    }
    st.client = new ConnClient({
      space,
      keys: this.store.identity(),
      onEvent: (e) => this.onSpaceEvent(st, e),
      onState: (s) => { if (s === "connected") void this.syncSpace(st); },
      onError: (code) => this.log("space_connect_failed", { spaceId: space.spaceId, code }),
      ...(this.deps.backoffMs ? { backoffMs: this.deps.backoffMs } : {}),
    });
    this.spaces.set(space.spaceId, st);
    st.client.start();
  }

  /** 요청을 보내고, 서버가 속도 제한이면 잠시 기다렸다 다시 — 다시 채우기에 빈 곳이 생기지 않게. */
  private async requestRetrying(st: SpaceState, req: ConnRequestBody): Promise<any> {
    let r = await st.client.request(req);
    for (let i = 0; i < SYNC_RETRIES && !r.ok && r.code === "rate_limited"; i++) {
      await new Promise((res) => setTimeout(res, this.rateRetryMs));
      r = await st.client.request(req);
    }
    return r;
  }

  private async syncSpace(st: SpaceState): Promise<void> {
    const r = await this.requestRetrying(st, { op: "c_list" });
    if (r.ok && Array.isArray(r.servers)) this.applyShared(st, r.servers, true);
    await this.pushAccounts(st);
    // 끊겨 있던 동안의 메시지를 채운다(이미 가진 seq는 거울이 버림 — 중복 없음).
    for (const s of st.shared) {
      for (const c of s.channels) {
        const rr = await this.requestRetrying(st, { op: "c_read", channelId: c.channelId, limit: MAX_READ_LIMIT });
        if (rr.ok && Array.isArray(rr.messages)) for (const m of rr.messages) this.ingest(st, c.channelId, m);
      }
    }
  }

  private async pushAccounts(st: SpaceState): Promise<void> {
    const accounts = this.deps.accounts.list()
      .filter((a) => a.area === "connection")
      .map((a) => ({ uuid: a.uuid, name: a.name, description: a.description ?? "" }));
    await this.requestRetrying(st, { op: "c_accounts", accounts });
  }

  private remoteId(spaceId: string, id: string): string {
    return `${REMOTE_PREFIX}${spaceId}:${id}`;
  }

  /** 서버가 보낸 공유 목록을 감독해 거울 채널로 반영(빠진 채널은 내린다). */
  private applyShared(st: SpaceState, raw: unknown[], persist: boolean): void {
    const servers: SharedServer[] = [];
    for (const s of raw.slice(0, MAX_REMOTE_SERVERS)) {
      const x = s as { serverId?: unknown; name?: unknown; channels?: unknown };
      if (typeof x?.serverId !== "string" || !isSafeAccountId(x.serverId) || !Array.isArray(x.channels)) continue;
      const name = validateName(x.name, "server", (v) => this.g(v, "conn_shared", "server_name"));
      if (!name.ok) continue;
      const channels: SharedServer["channels"] = [];
      for (const c of x.channels.slice(0, 100)) {
        const y = c as { channelId?: unknown; name?: unknown };
        const cn = validateName(y?.name, "channel", (v) => this.g(v, "conn_shared", "channel_name"));
        if (typeof y?.channelId === "string" && isSafeAccountId(y.channelId) && cn.ok) channels.push({ channelId: y.channelId, name: cn.name });
      }
      servers.push({ serverId: x.serverId, name: name.name, channels });
    }
    const sid = st.space.spaceId;
    const keep = new Set<string>();
    for (const s of servers) {
      for (const c of s.channels) {
        const id = this.remoteId(sid, c.channelId);
        keep.add(id);
        this.deps.channels.register(
          { id, kind: "server", label: `${st.space.spaceName}/${s.name}/${c.name}`, members: null, area: "connection" },
          path.join(this.store.dir, "remote", sid, `${c.channelId}.jsonl`),
        );
      }
    }
    for (const id of this.deps.channels.ids()) {
      if (id.startsWith(this.remoteId(sid, "")) && !keep.has(id)) this.deps.channels.unregister(id);
    }
    st.shared = servers;
    if (persist) {
      fs.mkdirSync(path.dirname(this.sharedFile(sid)), { recursive: true });
      writeFileAtomic(this.sharedFile(sid), JSON.stringify(servers, null, 2));
    }
  }

  private onSpaceEvent(st: SpaceState, e: ConnEvent): void {
    if (!e || typeof e !== "object") return;
    if (e.event === "msg") this.ingest(st, e.channelId, e);
    else if (e.event === "shared" && Array.isArray(e.servers)) this.applyShared(st, e.servers, true);
    else if (e.event === "accounts" && Array.isArray(e.accounts)) st.accounts = this.cleanAccounts(e.accounts);
  }

  private cleanAccounts(raw: unknown[]): RemoteAccount[] {
    const out: RemoteAccount[] = [];
    for (const a of raw.slice(0, MAX_REMOTE_ACCOUNTS * 4)) {
      const x = a as Partial<RemoteAccount>;
      const name = this.nameOf(x?.name, "conn_accounts");
      const hubUser = this.nameOf(x?.hubUser, "conn_accounts");
      if (typeof x?.uuid !== "string" || x.uuid.length > 300 || typeof x.memberId !== "string" || !name || !hubUser) continue;
      const description = typeof x.description === "string" ? this.g(x.description.slice(0, 500), "conn_accounts", "description") : "";
      out.push({ uuid: this.g(x.uuid, "conn_accounts", "uuid"), name, description, hubUser, memberId: x.memberId });
    }
    return out;
  }

  /** 서버가 보낸 메시지를 거울에 넣는다 — 서버를 믿지 않고 길이·숨은 문자를 다시 검사. */
  private ingest(st: SpaceState, hostChannelId: unknown, m: unknown): void {
    if (typeof hostChannelId !== "string") return;
    const ch = this.deps.channels.getChannel(this.remoteId(st.space.spaceId, hostChannelId));
    if (!ch) return;
    const x = m as { seq?: unknown; ts?: unknown; from?: unknown; fromName?: unknown; text?: unknown; origin?: { hubUser?: unknown } };
    if (typeof x?.seq !== "number" || typeof x.text !== "string" || typeof x.from !== "string" || x.from.length > 300) return;
    if (x.text.length > MAX_STORED_TEXT_LENGTH) {
      this.log("remote_text_too_long", { spaceId: st.space.spaceId });
      return;
    }
    const text = this.g(x.text, "conn_event", "text", true);
    if (text.length > MAX_STORED_TEXT_LENGTH) return;
    const fromName = this.nameOf(x.fromName, "conn_event") ?? "?";
    const hubUser = this.nameOf(x.origin?.hubUser, "conn_event") ?? "?";
    const msg = this.deps.channels.appendExternal(ch.id, {
      seq: x.seq,
      ts: typeof x.ts === "number" ? x.ts : Date.now(),
      from: this.g(x.from, "conn_event", "from"),
      fromName,
      text,
      origin: { scope: "remote", spaceName: st.space.spaceName, hubUser },
    });
    if (!msg) return;
    const mine = `${st.space.memberId}:`;
    this.deps.deliver(ch, msg, x.from.startsWith(mine) ? x.from.slice(mine.length) : undefined);
  }

  /** 연결 계정이 원격 채널(r:…)에 보낸다 — 저장은 서버의 메아리 이벤트가 맡는다. */
  async sendRemote(channelId: string, from: Account, text: string): Promise<{ ok: true; seq: number } | { ok: false; code: string }> {
    const rest = channelId.slice(REMOTE_PREFIX.length);
    const i = rest.indexOf(":");
    const st = i > 0 ? this.spaces.get(rest.slice(0, i)) : undefined;
    if (!st) return { ok: false, code: "channel_not_found" };
    if (!st.client.connected) return { ok: false, code: "connection_lost" };
    const r = await st.client.request({ op: "c_send", channelId: rest.slice(i + 1), from: { uuid: from.uuid, name: from.name }, text });
    return r.ok ? { ok: true, seq: r.seq } : { ok: false, code: typeof r.code === "string" ? r.code : "send_failed" };
  }

  // ───────── Hub 목록 보조 ─────────

  /** 연결 계정에게 보이는 다른 Hub의 연결 계정. */
  remoteAccounts(): AccountInfo[] {
    const out: AccountInfo[] = [];
    const cfg = this.store.serverConfig();
    if (this.listening && cfg) {
      for (const [memberId, list] of this.memberAccounts) {
        const m = this.store.member(memberId);
        if (!m || m.revoked) continue;
        const online = [...this.peers].some((p) => p.memberId === memberId);
        for (const a of list) out.push({ uuid: `${memberId}:${a.uuid}`, name: a.name, description: a.description, online, remote: { spaceName: cfg.spaceName, hubUser: m.userName } });
      }
    }
    for (const st of this.spaces.values()) {
      for (const a of st.accounts) {
        if (a.memberId === st.space.memberId) continue; // 내 Hub의 계정
        out.push({ uuid: this.remoteId(st.space.spaceId, a.uuid), name: a.name, description: a.description, online: st.client.connected, remote: { spaceName: st.space.spaceName, hubUser: a.hubUser } });
      }
    }
    return out;
  }

  /** 연결 계정의 list_servers에 붙는 항목: 내 Connection Communications + 참여 공간의 공유 서버. */
  serversFor(): { serverId: string; name: string; channelCount: number; area?: "connection"; remote?: { spaceName: string; hubUser: string } }[] {
    const out: { serverId: string; name: string; channelCount: number; area?: "connection"; remote?: { spaceName: string; hubUser: string } }[] = [];
    for (const s of this.comms.servers()) out.push({ serverId: s.id, name: s.name, channelCount: s.channels.length, area: "connection" });
    for (const s of this.meshServers()) out.push({ serverId: `m.${s.spaceId}`, name: `mesh:${s.spaceName}`, channelCount: s.channels.length, remote: { spaceName: s.spaceName, hubUser: s.spaceName } });
    for (const st of this.spaces.values()) {
      for (const s of st.shared) {
        out.push({ serverId: this.remoteId(st.space.spaceId, s.serverId), name: s.name, channelCount: s.channels.length, remote: { spaceName: st.space.spaceName, hubUser: st.space.hostUser } });
      }
    }
    return out;
  }

  /** 통신·원격 서버의 채널 목록. 해당 서버가 아니면 null. */
  channelsFor(serverId: string): { channelId: string; name: string }[] | null {
    const own = this.comms.getServer(serverId);
    if (own) return own.channels.map((c) => ({ channelId: c.id, name: c.name }));
    const ms = this.meshServers().find((s) => `m.${s.spaceId}` === serverId);
    if (ms) return ms.channels;
    for (const st of this.spaces.values()) {
      for (const s of st.shared) {
        if (this.remoteId(st.space.spaceId, s.serverId) === serverId) {
          return s.channels.map((c) => ({ channelId: this.remoteId(st.space.spaceId, c.channelId), name: c.name }));
        }
      }
    }
    return null;
  }

  /** 휴지통이 통신 서버·채널을 지우고 되살릴 때 쓰는 부품(v3.0). changed = 삭제·복원 뒤 공유 목록 정리·참여자에게 알림. */
  trashDeps(): { store(create: boolean): import("../servers.js").ServerStore | null; logPath(id: string): string; changed(): void } {
    return {
      store: (create) => this.comms.serverStore(create),
      logPath: (id) => this.comms.logPath(id),
      changed: () => {
        const cfg = this.store.serverConfig();
        if (cfg) this.setShared(cfg.shared); // 없어진 서버는 공유 목록에서 빠진다(복원해도 공유는 꺼짐)
        else this.broadcastShared();
      },
    };
  }

  // ───────── 관리 앱(관리 op) ─────────

  status(): {
    server: { enabled: boolean; port: number; profile: ProfileId; spaceName: string; burnOnJoin: boolean; shared: string[]; listening: boolean } | null;
    members: { memberId: string; userName: string; joinedAt: number; revoked: boolean; online: boolean }[];
    joined: { spaceId: string; spaceName: string; hostUser: string; connected: boolean }[];
    userName: string | null;
    storage: ReturnType<Uploader["status"]>;
    spaces1: ReturnType<SpaceSync["status"]>[];
    comms: { serverId: string; name: string; channels: { channelId: string; name: string }[] }[];
    mesh: ReturnType<ConnectionManager["meshStatus"]>;
    events: { ts: number; code: string; detail: object }[];
  } {
    const cfg = this.store.serverConfig();
    const online = new Set([...this.peers].map((p) => p.memberId));
    return {
      server: cfg ? { enabled: cfg.enabled, port: cfg.port, profile: cfg.profile, spaceName: cfg.spaceName, burnOnJoin: cfg.burnOnJoin, shared: cfg.shared, listening: this.listening } : null,
      members: this.store.members().map((m) => ({ memberId: m.memberId, userName: m.userName, joinedAt: m.joinedAt, revoked: m.revoked, online: online.has(m.memberId) })),
      joined: this.store.joined().map((j) => ({ spaceId: j.spaceId, spaceName: j.spaceName, hostUser: j.hostUser, connected: !!this.spaces.get(j.spaceId)?.client.connected })),
      userName: this.store.userName(),
      storage: this.uploader.status(),
      spaces1: this.space1Status(),
      comms: this.comms.servers().map((s) => ({ serverId: s.id, name: s.name, channels: s.channels.map((c) => ({ channelId: c.id, name: c.name })) })),
      mesh: this.meshStatus(),
      events: this.events.slice(-50),
    };
  }

  // ───────── 방식 3: 서버끼리 망(v3.0 5단계) ─────────

  private meshDir(): string {
    return path.join(this.store.dir, "mesh");
  }

  private meshSelf(): MeshSelf {
    const c = this.store.serverConfig()!;
    // 망 안의 ID는 설정의 공간 ID가 아니라 서버 키 지문(사칭·선점 차단 — 검증 2026-11-08)
    const keys = this.store.identity();
    return { spaceId: meshIdOf(keys.publicKeyB64), spaceName: c.spaceName, userName: this.userName(), keys };
  }

  /** 망 엔진(통신 서버 설정이 있을 때만). 만들 때 파일을 쓰지 않는다 — 실제로 쓸 일이 생길 때 쓴다. */
  private ensureMesh(): Mesh | null {
    if (this.mesh) return this.mesh;
    if (!this.store.serverConfig()) return null;
    const self = () => this.meshSelf();
    const gov = new Governance({ dir: this.meshDir(), self, mesh: () => this.mesh!, unshareOwn: (ch) => this.meshExclude(ch), log: (c, d) => this.log(c, d ?? {}) });
    this.gov = gov;
    this.mesh = new Mesh({
      dir: this.meshDir(),
      self,
      ownChannels: () => this.meshOwnChannels(),
      channels: this.deps.channels,
      guard: (s, field, keep) => this.g(s, "mesh", field, keep),
      log: (c, d) => this.log(c, d ?? {}),
      deliver: (ch, msg) => {
        // 내 Hub에서 중계로 쓴 메시지가 돌아오면 보낸 계정에게는 메아리를 주지 않는다(from = 출처/진입서버/계정)
        const parts = msg.from.split("/");
        const skip = parts.length >= 3 && parts[1] === this.store.serverConfig()?.spaceId ? parts.slice(2).join("/") : undefined;
        this.deps.deliver(ch, msg, skip);
        if (this.sharedChannel(ch.id)) this.broadcast(this.msgEvent(msg));
      },
      policy: gov,
      onOtherEvent: (e, l) => gov.onEvent(e, l),
      onAttach: (l) => gov.onAttach(l),
      initialWindow: () => gov.initialWindow(),
      appendOwn: (chId, from, fromName, text, origin) => {
        const ch = this.comms.findChannel(chId) ? this.deps.channels.getChannel(chId) : undefined;
        if (!ch) return null;
        const msg = this.deps.channels.append(chId, from, fromName, text, origin);
        this.deps.deliver(ch, msg);
        if (this.sharedChannel(chId)) this.broadcast(this.msgEvent(msg));
        return msg;
      },
      onServersChanged: () => this.broadcastShared(),
      originOf: (k) => meshIdOf(k),
    });
    const t1 = setInterval(() => { if (this.mesh && this.mesh.links.size > 0) gov.tick(); }, 30_000);
    const t2 = setInterval(() => this.trimMirrors(), 10 * 60_000);
    t1.unref(); t2.unref();
    this.meshTimers.push(t1, t2);
    this.trimMirrors();
    return this.mesh;
  }

  /** 거울을 최근 500개로(메인·예비·지정 서버는 안 자름, Ruling 7). */
  private trimMirrors(): void {
    if (!this.mesh || !this.gov) return;
    for (const id of this.gov.trimPlan()) this.mesh.trim(id, RELAY_WINDOW);
  }

  private meshOwnChannels(): { id: string; name: string }[] {
    const cfg = this.store.serverConfig();
    if (!cfg) return [];
    const excluded = new Set(cfg.meshExcluded ?? []);
    const want = new Set(cfg.meshShared ?? []);
    return this.comms.servers().filter((s) => want.has(s.id)).flatMap((s) => s.channels.filter((c) => !excluded.has(c.id)).map((c) => ({ id: c.id, name: c.name })));
  }

  private meshExclude(ch: string): void {
    const cfg = this.store.serverConfig();
    if (!cfg) return;
    this.store.setServerConfig({ ...cfg, meshExcluded: [...new Set([...(cfg.meshExcluded ?? []), ch])] });
    this.log("mesh_channel_unshared_by_coordinator", { channelId: ch });
    this.mesh?.ownChanged();
  }

  /** 망에 공유할 통신 서버를 고른다(방식 2 공유와 따로). */
  meshSetShared(serverIds: string[]): void {
    const cfg = this.store.serverConfig();
    if (!cfg) throw new Error("server_not_configured");
    const exists = new Set(this.comms.servers().map((s) => s.id));
    this.store.setServerConfig({ ...cfg, meshShared: serverIds.filter((id) => exists.has(id)) });
    this.ensureMesh()?.ownChanged();
  }

  /** 서버 연결 인증서(1회용)를 만든다 — 이 Hub 주인의 승인. */
  meshInvite(label: string, host: string, expiresInMs: number): { code: string; ipWarning: boolean } {
    const cfg = this.store.serverConfig();
    if (!cfg?.enabled) throw new Error("server_not_enabled");
    const name = validateName(label, "server", (s) => this.g(s, "mesh_invite", "label"));
    if (!name.ok) throw new Error("name_invalid");
    const keys = this.store.identity();
    const token = newJoinToken();
    const expiresAt = Date.now() + expiresInMs;
    this.store.addLinkInvite(token, name.name, expiresAt);
    this.ensureMesh();
    const code = encodeInvite({
      v: 1, kind: "link", spaceId: cfg.spaceId, spaceName: cfg.spaceName, profile: cfg.profile,
      endpoint: { type: "direct", host, port: cfg.port }, serverKey: keys.publicKeyB64, token, expiresAt, hostUser: this.userName(), memberName: name.name,
    }, keys.privateKeyPem);
    return { code, ipWarning: true };
  }

  /** 받은 서버 연결 인증서로 잇는다 — 이 Hub 주인의 승인. */
  async meshJoin(code: string): Promise<{ ok: true; spaceId: string } | { ok: false; code: string }> {
    const d = decodeInvite(code, Date.now());
    if (!d.ok) return d;
    if (d.invite.kind !== "link") return { ok: false, code: "not_link_invite" };
    const cfg = this.store.serverConfig();
    if (!cfg) return { ok: false, code: "server_not_enabled" };
    if (d.invite.spaceId === cfg.spaceId) return { ok: false, code: "link_self" };
    const had = this.store.link(d.invite.spaceId);
    if (had && had.serverKey !== d.invite.serverKey) return { ok: false, code: "space_key_changed" };
    const self = this.meshSelf();
    const r = await joinLink(d.invite, { keys: self.keys, spaceId: self.spaceId, spaceName: self.spaceName });
    if (!r.ok) return r;
    const name = validateName(r.link.spaceName, "server", (s) => this.g(s, "mesh_join", "spaceName"));
    const link: LinkRecord = { ...r.link, spaceName: name.ok ? name.name : "?" };
    this.store.addLink(link);
    this.ensureStarted();
    this.ensureMesh();
    this.startDialer(link);
    this.log("link_added", { spaceId: link.spaceId, spaceName: link.spaceName });
    return { ok: true, spaceId: meshIdOf(link.serverKey) };
  }

  private startDialer(link: LinkRecord): void {
    this.dialers.get(link.spaceId)?.stop();
    const self = this.meshSelf();
    const linkSelf: LinkSelf = { keys: self.keys, spaceId: self.spaceId, spaceName: self.spaceName };
    const d = new LinkDialer({
      link,
      self: linkSelf,
      onUp: (ch) => {
        const mesh = this.ensureMesh();
        if (mesh) mesh.attach({ spaceId: meshIdOf(link.serverKey), spaceName: link.spaceName, serverKey: link.serverKey }, ch);
        else ch.close();
      },
      onDown: () => this.log("link_down", { spaceId: link.spaceId }),
      onError: (code) => this.log("link_connect_failed", { spaceId: link.spaceId, code }),
      ...(this.deps.backoffMs ? { backoffMs: this.deps.backoffMs } : {}),
    });
    this.dialers.set(link.spaceId, d);
    d.start();
  }

  /** 서버 연결 끊기(그 서버의 키로는 다시 인증 못 함). */
  /** id = 망 ID(화면이 주는 값) 또는 연결 기록의 공간 ID. */
  meshRemove(id: string): boolean {
    const link = this.store.links().find((l) => !l.removed && (l.spaceId === id || meshIdOf(l.serverKey) === id));
    if (!link) return false;
    const ok = this.store.removeLink(link.spaceId);
    this.dialers.get(link.spaceId)?.stop();
    this.dialers.delete(link.spaceId);
    this.listener?.disconnectLink(link.spaceId);
    this.mesh?.dropLinksTo(meshIdOf(link.serverKey));
    if (ok) this.log("link_removed", { spaceId: link.spaceId });
    return ok;
  }

  private needGov(): Governance {
    this.ensureMesh();
    if (!this.gov) throw new Error("server_not_configured");
    return this.gov;
  }

  meshSetCase(c: CaseChoice): void {
    this.needGov().setChoice(c);
  }

  meshCoordinator(on: boolean): void {
    this.needGov().declareCoordinator(on);
  }

  meshAccept(spaceId: string | null): void {
    this.needGov().accept(spaceId);
  }

  meshCommand(cmd: GovCommand): void {
    this.needGov().issue(cmd);
  }

  /** 연결 계정이 망 거울(m.…)에 쓴다 — 대상 서버로 중계. */
  async sendMesh(channelId: string, from: Account, text: string): Promise<{ ok: true; seq: number } | { ok: false; code: string }> {
    if (!this.mesh?.parseMirror(channelId)) return { ok: false, code: "channel_not_found" };
    return this.mesh.relayWrite({ mirrorId: channelId, from: from.uuid, fromName: from.name, hubUser: this.userName(), text });
  }

  meshStatus(): {
    self: string;
    shared: string[];
    excluded: string[];
    links: { spaceId: string; spaceName: string; dir: "in" | "out"; fingerprint: string; connected: boolean }[];
    servers: { spaceId: string; spaceName: string; channelCount: number; direct: boolean }[];
    channels: { spaceId: string; channels: { id: string; name: string }[] }[];
    gov: ReturnType<Governance["status"]> | null;
  } | null {
    const cfg = this.store.serverConfig();
    if (!cfg) return null;
    const live = new Set([...(this.mesh?.links ?? [])].map((l) => l.info.spaceId));
    const links = this.store.links().filter((l) => !l.removed);
    return {
      self: meshIdOf(this.store.identity().publicKeyB64),
      shared: cfg.meshShared ?? [],
      excluded: cfg.meshExcluded ?? [],
      links: links.map((l) => ({ spaceId: meshIdOf(l.serverKey), spaceName: l.spaceName, dir: l.dir, fingerprint: spkiFingerprint(l.serverKey).slice(0, 16), connected: live.has(meshIdOf(l.serverKey)) })),
      servers: (this.mesh?.servers() ?? []).map((s) => ({ spaceId: s.spaceId, spaceName: s.spaceName, channelCount: s.channels.length, direct: links.some((l) => meshIdOf(l.serverKey) === s.spaceId) })),
      channels: [{ spaceId: meshIdOf(this.store.identity().publicKeyB64), channels: this.meshOwnChannels() }, ...(this.mesh?.servers() ?? []).map((s) => ({ spaceId: s.spaceId, channels: s.channels }))],
      gov: this.gov?.status() ?? null,
    };
  }

  // ───────── 시험용 ─────────

  joinedForTest(): unknown { return this.store.joined(); }
  setReadLimitForTest(max: number, windowMs: number): void { this.readLimit = { max, windowMs }; }
  setRateRetryMsForTest(ms: number): void { this.rateRetryMs = ms; }
  syncSpaceForTest(spaceId: string): Promise<void> { return this.syncSpace(this.spaces.get(spaceId)!); }

  setTapForTest(fn: ((o: object) => void) | null): void {
    this.tap = fn;
  }

  broadcastForTest(e: ConnEvent): void {
    this.broadcast(e);
  }

  requestSpaceForTest(spaceId: string, req: ConnRequestBody): Promise<any> {
    const st = this.spaces.get(spaceId);
    return st ? st.client.request(req) : Promise.resolve({ ok: false, code: "no_space" });
  }
}
