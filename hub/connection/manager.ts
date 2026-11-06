// 통신 관리자(v3.0): Hub와 통신 부품(상태 저장·리스너·참여 클라이언트·Connection Communications)을 잇는다.
// 통신 서버 쪽(A): 공유 채널만 구성원에게 보이고, 구성원이 보낸 메시지는 감독 뒤 저장·전달한다.
// 참여자 쪽(B): 공유 채널을 r:<spaceId>:<channelId> 거울 채널로 두고, 서버가 보낸 이벤트도 다시 감독한다(서버를 믿지 않음).
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { MAX_READ_LIMIT, MAX_STORED_TEXT_LENGTH, MAX_TEXT_LENGTH, type AccountInfo, type Channel, type Message, type MessageOrigin } from "../../shared/protocol.js";
import { newJoinToken } from "../../shared/connCrypto.js";
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
import { DEFAULT_PROFILE } from "../../shared/cryptoProfile.js";

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

export class ConnectionManager implements ConnStatusSource {
  readonly store: ConnectionStore;
  readonly comms: CommsStore;
  private listener: ConnListener | null = null;
  private listening = false;
  private peers = new Set<ConnPeer>();
  private memberAccounts = new Map<string, { uuid: string; name: string; description: string }[]>();
  private spaces = new Map<string, SpaceState>();
  private tap: ((o: object) => void) | null = null;
  /** 구성원별 최근 전송 시각(설계 5.2 "참여자별 메시지 속도 제한", RT-C16). */
  private sendTimes = new Map<string, number[]>();

  /** 구성원 한 명은 10초에 60개까지. */
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
      channels: () => this.comms.servers().flatMap((s) => s.channels.map((c) => ({ id: c.id, logFile: this.comms.logPath(c.id) }))),
      makeBackend: (cfg, token) => new GitHubBackend({ token, repo: cfg.repo, ...(cfg.branch ? { branch: cfg.branch } : {}), ...(deps.storageApiBase ? { apiBase: deps.storageApiBase } : {}) }),
      log: (code, detail) => this.log(code, detail),
    });
  }

  readonly uploader: Uploader;

  /** 저장소 연결(관리 op). 통신 서버 공간이 있어야 한다. */
  storageSet(cfg: StorageConfig, token: string): Promise<{ recoveryKey: string }> {
    if (!this.store.serverConfig()) throw new Error("server_not_enabled");
    return this.uploader.configure(cfg, token).then((r) => { this.uploader.start(); return r; });
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
    if (this.uploader.status().configured) this.uploader.start();
  }

  async stop(): Promise<void> {
    await this.uploader.stop(); // 정상 종료 직전 마지막 업로드(설계 4.2)
    for (const st of this.spaces.values()) st.client.stop();
    this.spaces.clear();
    const l = this.listener;
    this.listener = null;
    this.listening = false;
    this.peers.clear();
    await l?.close();
  }

  hasLiveConnection(): boolean {
    if (this.listening) return true;
    for (const st of this.spaces.values()) if (st.client.connected) return true;
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
    return cfg ? this.comms.shared(cfg.shared) : [];
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
    switch (req.op) {
      case "c_list":
        return reply({ ok: true, servers: this.sharedServers() });
      case "c_read": {
        const ch = this.sharedChannel(req.channelId);
        if (!ch) return fail("channel_forbidden");
        const limit = typeof req.limit === "number" && req.limit > 0 ? Math.min(req.limit, MAX_READ_LIMIT) : 100;
        return reply({ ok: true, messages: this.deps.channels.recent(ch.id, limit).map((m) => this.wire(m)) });
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
        const origin: MessageOrigin = { scope: "remote", spaceName: this.store.serverConfig()?.spaceName ?? "", hubUser: p.userName };
        const msg = this.deps.channels.append(ch.id, `${p.memberId}:${from.uuid}`, fromName, text, origin);
        this.deps.deliver(ch, msg);
        this.broadcast(this.msgEvent(msg));
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
    const r = await joinSpace(d.invite, this.store.identity(), this.userName());
    if (!r.ok) return r;
    this.store.addJoined(r.space);
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

  private async syncSpace(st: SpaceState): Promise<void> {
    const r = await st.client.request({ op: "c_list" });
    if (r.ok && Array.isArray(r.servers)) this.applyShared(st, r.servers, true);
    await this.pushAccounts(st);
    // 끊겨 있던 동안의 메시지를 채운다(이미 가진 seq는 거울이 버림 — 중복 없음).
    for (const s of st.shared) {
      for (const c of s.channels) {
        const rr = await st.client.request({ op: "c_read", channelId: c.channelId, limit: MAX_READ_LIMIT });
        if (rr.ok && Array.isArray(rr.messages)) for (const m of rr.messages) this.ingest(st, c.channelId, m);
      }
    }
  }

  private async pushAccounts(st: SpaceState): Promise<void> {
    const accounts = this.deps.accounts.list()
      .filter((a) => a.area === "connection")
      .map((a) => ({ uuid: a.uuid, name: a.name, description: a.description ?? "" }));
    await st.client.request({ op: "c_accounts", accounts });
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
    for (const st of this.spaces.values()) {
      for (const s of st.shared) {
        if (this.remoteId(st.space.spaceId, s.serverId) === serverId) {
          return s.channels.map((c) => ({ channelId: this.remoteId(st.space.spaceId, c.channelId), name: c.name }));
        }
      }
    }
    return null;
  }

  // ───────── 관리 앱(관리 op) ─────────

  status(): {
    server: { enabled: boolean; port: number; profile: ProfileId; spaceName: string; burnOnJoin: boolean; shared: string[]; listening: boolean } | null;
    members: { memberId: string; userName: string; joinedAt: number; revoked: boolean; online: boolean }[];
    joined: { spaceId: string; spaceName: string; hostUser: string; connected: boolean }[];
    userName: string | null;
    storage: ReturnType<Uploader["status"]>;
    comms: { serverId: string; name: string; channels: { channelId: string; name: string }[] }[];
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
      comms: this.comms.servers().map((s) => ({ serverId: s.id, name: s.name, channels: s.channels.map((c) => ({ channelId: c.id, name: c.name })) })),
      events: this.events.slice(-50),
    };
  }

  // ───────── 시험용 ─────────

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
