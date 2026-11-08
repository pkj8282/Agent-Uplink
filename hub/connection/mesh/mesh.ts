// 망 엔진(방식 3, v3.0 5단계): 서버 연결로 이어진 통신 서버들 사이에 목록(catalog)·서명 기록을 퍼뜨린다.
// - 목록: 서버마다 자기 망 공유 채널을 서명해 알림. 버전이 높은 것만 받고 다시 퍼뜨림(고리에서도 멈춤). 처음 본 공간 ID의 키 고정,
//   직접 이은 서버는 연결 때 확인한 키가 우선.
// - 기록: (출처, 채널)마다 이어진 사슬. 출처 키 서명·사슬·목록에 있는 채널·시각·크기를 확인해 틀리면 거부(설계 5.4),
//   같은 연결에서 3번 거부하면 그 연결을 끊는다. 받아들인 기록은 거울 채널 m.<출처>.<채널>에 넣고 받은 곳을 뺀 연결로 민다.
// - 다른 서버를 믿지 않는다: 모든 문자열은 감독(guard)을 다시 거친다.
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { writeFileAtomic } from "../../fsutil.js";
import { validateName } from "../../names.js";
import type { ChannelStore } from "../../channels.js";
import { MAX_STORED_TEXT_LENGTH, MAX_TEXT_LENGTH, type Channel, type Message, type MessageOrigin } from "../../../shared/protocol.js";
import { spkiFingerprint, type SigningKeys } from "../../../shared/connCrypto.js";
import { checkChain, openMesh, recordHash, signMesh, validRecordBody, type RecordBody, type Signed } from "../../../shared/meshRecord.js";
import type { LinkChannel } from "./link.js";

/** 망 ID = 서버 공개키 지문(SPKI SHA-256) 앞 32자 — 키에서 나오므로 남이 같은 ID를 주장할 수 없다. */
export function meshIdOf(serverKeyB64: string): string {
  return spkiFingerprint(serverKeyB64).slice(0, 32);
}

export interface MeshSelf {
  spaceId: string;
  spaceName: string;
  userName: string;
  keys: SigningKeys;
}

/** 거버넌스(T6)가 거는 제한. 없으면 제한 없음. */
export interface MeshPolicy {
  /** 망에서 끊긴 서버(총괄 cut) — 목록·기록·요청을 받지 않고 연결도 끊는다. */
  blocked(spaceId: string): boolean;
  /** 망 공유에서 내린 채널(총괄 unshare) — 그 채널 기록을 받지·전달하지 않는다. */
  channelBlocked(origin: string, ch: string): boolean;
  /** 그 서버(또는 그 서버의 그 Hub 사용자)를 거친 중계 쓰기를 막았나(총괄 noWrite). */
  noWrite?(entry: string, hubUser: string): boolean;
}

/** 중계 쓰기 요청(진입 서버가 서명). ttl은 서명 밖(전달할 때마다 줄임) — 부풀려도 reqId 중복 제거가 막는다. */
export interface RelayBody {
  reqId: string;
  entry: string;
  entryName: string;
  target: string;
  ch: string;
  from: string;
  fromName: string;
  hubUser: string;
  text: string;
  ts: number;
}

export interface AckBody {
  reqId: string;
  entry: string;
  target: string;
  ok: boolean;
  seq?: number;
  code?: string;
}

export interface MeshDeps {
  dir: string;
  self(): MeshSelf;
  /** 내가 망에 공유하는 채널(통신 서버 채널 중 고른 것). */
  ownChannels(): { id: string; name: string }[];
  channels: ChannelStore;
  guard(s: string, field: string, keepLineBreaks?: boolean): string;
  log(code: string, detail?: object): void;
  deliver(ch: Channel, msg: Message): void;
  now?(): number;
  /** 처음 받는 사슬은 최근 몇 개부터 당길지(기본 500, Infinity = 전부). */
  initialWindow?(): number;
  policy?: MeshPolicy;
  /** 서버 키 → 그 키의 망 ID. 주면 목록·직접 연결의 공간 ID가 키에서 나온 값과 같아야 한다(남의 ID를 다른 키로 주장하는 사칭·선점 차단). */
  originOf?(serverKeyB64: string): string | undefined;
  /** 기록을 받아들인 뒤(거버넌스·중계가 쓴다). */
  onRecord?(body: RecordBody): void;
  /** 중계 쓰기를 받아 내 채널에 저장(로컬 전달·구성원 알림까지). 망 기록은 Mesh가 만든다. */
  appendOwn?(ch: string, from: string, fromName: string, text: string, origin: MessageOrigin): Message | null;
  relayTimeoutMs?: number;
  /** 다른 이벤트(명령 등) — 처리했으면 true. */
  onOtherEvent?(e: { event: string; [k: string]: unknown }, from: MeshLink): boolean;
  /** 망 서버·채널 목록이 바뀌었을 때(구성원에게 공유 목록 다시 알리기). */
  onServersChanged?(): void;
  /** 연결이 붙어 목록을 보낸 뒤(거버넌스가 자기 알림을 보낸다). */
  onAttach?(l: MeshLink): void;
}

export interface PeerInfo {
  spaceId: string;
  spaceName: string;
  serverKey: string;
}

export interface MeshLink {
  info: PeerInfo;
  ch: LinkChannel;
  strikes: number;
  recTimes: number[];
  otherTimes: number[];
}

export interface CatalogBody {
  origin: string;
  spaceName: string;
  ver: number;
  channels: { id: string; name: string }[];
}

interface Chain {
  n: number;
  hash: string;
  hashes: Map<number, string>;
  file: string;
}

const SPACE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const CHANNEL_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_SERVERS = 64;
const MAX_CHANNELS = 100;
const PULL_BATCH = 500;
/** 당기기 응답 한 번의 기록 바이트 상한 — 받는 쪽 프레임 상한(1MB)보다 넉넉히 작게. */
const PULL_MAX_BYTES = 640 * 1024;
const STRIKES_TO_DROP = 3;
const REC_PER_SECOND = 200;
/** 한 연결의 기록 외 이벤트(목록·중계·확인·총괄 등) 초당 상한 — 넘으면 버린다. */
const OTHER_PER_SECOND = 100;
const RELAY_TTL = 8;
const RELAY_MAX_AGE_MS = 10 * 60_000;
const SEEN_MAX = 5000;
const RELAY_PER_10S = 60;

export class Mesh {
  readonly links = new Set<MeshLink>();
  private pins: Record<string, string> = {};
  private cats = new Map<string, { signed: Signed<CatalogBody>; body: CatalogBody }>();
  private chains = new Map<string, Chain>();
  private selfCat: { ver: number; key: string; signed: Signed<CatalogBody> | null } = { ver: 0, key: "", signed: null };
  private pulling = new Set<string>();
  private seen = new Map<string, number>();
  private relayTimes = new Map<string, number[]>();
  private pendingRelay = new Map<string, (r: { ok: true; seq: number } | { ok: false; code: string }) => void>();

  constructor(private readonly deps: MeshDeps) {
    this.load();
  }

  private get now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  // ───────── 저장 ─────────

  private file(name: string): string {
    return path.join(this.deps.dir, name);
  }

  private load(): void {
    try {
      const s = JSON.parse(fs.readFileSync(this.file("self.json"), "utf8")) as { ver?: number; key?: string };
      if (typeof s.ver === "number") this.selfCat = { ver: s.ver, key: typeof s.key === "string" ? s.key : "", signed: null };
    } catch {
      // 처음
    }
    try {
      const d = JSON.parse(fs.readFileSync(this.file("dir.json"), "utf8")) as { pins?: Record<string, string>; cats?: Record<string, unknown> };
      if (d.pins && typeof d.pins === "object") this.pins = { ...d.pins };
      for (const [origin, raw] of Object.entries(d.cats ?? {})) {
        const b = openMesh<CatalogBody>("cat", raw, this.pins[origin]);
        if (b && b.origin === origin) this.cats.set(origin, { signed: raw as Signed<CatalogBody>, body: b });
      }
    } catch {
      // 처음
    }
    const recDir = this.file("rec");
    let origins: string[] = [];
    try { origins = fs.readdirSync(recDir); } catch { /* 없음 */ }
    for (const origin of origins) {
      let files: string[] = [];
      try { files = fs.readdirSync(path.join(recDir, origin)); } catch { continue; }
      for (const f of files) if (f.endsWith(".jsonl")) this.loadChain(origin, f.slice(0, -6));
    }
    for (const origin of this.cats.keys()) this.applyMirrors(origin);
  }

  private loadChain(origin: string, ch: string): Chain {
    const file = path.join(this.file("rec"), origin, `${ch}.jsonl`);
    const c: Chain = { n: 0, hash: "", hashes: new Map(), file };
    try {
      for (const line of fs.readFileSync(file, "utf8").split("\n")) {
        if (!line) continue;
        try {
          const r = JSON.parse(line) as Signed<RecordBody>;
          const h = recordHash(r.body);
          c.hashes.set(r.body.n, h);
          if (r.body.n > c.n) { c.n = r.body.n; c.hash = h; }
        } catch {
          // 손상 줄 무시
        }
      }
    } catch {
      // 없음
    }
    this.chains.set(`${origin}/${ch}`, c);
    return c;
  }

  private chain(origin: string, ch: string): Chain | undefined {
    return this.chains.get(`${origin}/${ch}`);
  }

  private saveDir(): void {
    fs.mkdirSync(this.deps.dir, { recursive: true });
    const cats: Record<string, unknown> = {};
    for (const [o, c] of this.cats) cats[o] = c.signed;
    writeFileAtomic(this.file("dir.json"), JSON.stringify({ pins: this.pins, cats }, null, 2));
  }

  private appendRecord(origin: string, ch: string, r: Signed<RecordBody>): void {
    let c = this.chain(origin, ch);
    if (!c) {
      c = { n: 0, hash: "", hashes: new Map(), file: path.join(this.file("rec"), origin, `${ch}.jsonl`) };
      this.chains.set(`${origin}/${ch}`, c);
    }
    fs.mkdirSync(path.dirname(c.file), { recursive: true });
    fs.appendFileSync(c.file, JSON.stringify(r) + "\n");
    const h = recordHash(r.body);
    c.hashes.set(r.body.n, h);
    c.n = r.body.n;
    c.hash = h;
  }

  private readRecords(origin: string, ch: string, after: number, limit: number): Signed<RecordBody>[] {
    const c = this.chain(origin, ch);
    if (!c) return [];
    const out: Signed<RecordBody>[] = [];
    let bytes = 0;
    try {
      for (const line of fs.readFileSync(c.file, "utf8").split("\n")) {
        if (!line) continue;
        try {
          const r = JSON.parse(line) as Signed<RecordBody>;
          if (r.body.n <= after) continue;
          const size = Buffer.byteLength(line);
          // 응답 프레임이 받는 쪽 상한(리스너 1MB)을 넘지 않게 — 기록 하나는 항상 넣는다(기록 하나는 상한보다 작음)
          if (out.length > 0 && bytes + size > PULL_MAX_BYTES) break;
          out.push(r);
          bytes += size;
        } catch { /* 손상 줄 */ }
        if (out.length >= limit) break;
      }
    } catch { /* 없음 */ }
    return out;
  }

  /** 거울을 최근 keep개로 자른다(기록 원본도 같이). 사슬 머리는 남아 다음 기록을 이어 받는다. 지운 메시지 수. */
  trim(mirrorId: string, keep: number): number {
    const m = /^m\.([A-Za-z0-9_-]{1,64})\.([A-Za-z0-9_-]{1,128})$/.exec(mirrorId);
    const c = m ? this.chain(m[1], m[2]) : undefined;
    if (!m || !c || c.n <= keep) return 0;
    const cutoff = c.n - keep;
    try {
      const lines = fs.readFileSync(c.file, "utf8").split("\n").filter((line) => {
        if (!line) return false;
        try { return (JSON.parse(line) as Signed<RecordBody>).body.n > cutoff; } catch { return false; }
      });
      writeFileAtomic(c.file, lines.length ? `${lines.join("\n")}\n` : "");
    } catch { /* 없음 */ }
    for (const n of [...c.hashes.keys()]) if (n <= cutoff) c.hashes.delete(n);
    return this.deps.channels.prune(mirrorId, (msg) => msg.seq > cutoff);
  }

  // ───────── 목록 ─────────

  mirrorId(origin: string, ch: string): string {
    return `m.${origin}.${ch}`;
  }

  /** 망에서 알고 있는 다른 서버들(내 서버·끊은 서버 제외, 공유 중단된 채널 제외). */
  servers(): { spaceId: string; spaceName: string; channels: { id: string; name: string }[] }[] {
    const p = this.deps.policy;
    return [...this.cats.values()].filter((c) => !p?.blocked(c.body.origin))
      .map((c) => ({ spaceId: c.body.origin, spaceName: c.body.spaceName, channels: c.body.channels.filter((ch) => !p?.channelBlocked(c.body.origin, ch.id)) }));
  }

  /** 거울 채널 ID → (출처, 채널). 망 거울이 아니면 null. */
  parseMirror(id: string): { origin: string; ch: string } | null {
    const m = /^m\.([A-Za-z0-9_-]{1,64})\.([A-Za-z0-9_-]{1,128})$/.exec(id);
    if (!m || !this.cats.get(m[1])?.body.channels.some((c) => c.id === m[2])) return null;
    return { origin: m[1], ch: m[2] };
  }

  /** 출처 서버의 고정된 키(모르면 undefined). */
  keyOf(spaceId: string): string | undefined {
    return this.pins[spaceId];
  }

  catalogOf(spaceId: string): CatalogBody | undefined {
    return this.cats.get(spaceId)?.body;
  }

  private ownCatalog(): Signed<CatalogBody> {
    const self = this.deps.self();
    const channels = this.deps.ownChannels().slice(0, MAX_CHANNELS).map((c) => ({ id: c.id, name: c.name }));
    const key = JSON.stringify({ n: self.spaceName, channels });
    if (key !== this.selfCat.key || !this.selfCat.signed) {
      const ver = key !== this.selfCat.key ? this.selfCat.ver + 1 : Math.max(1, this.selfCat.ver);
      const signed = signMesh<CatalogBody>("cat", { origin: self.spaceId, spaceName: self.spaceName, ver, channels }, self.keys);
      this.selfCat = { ver, key, signed };
      fs.mkdirSync(this.deps.dir, { recursive: true });
      writeFileAtomic(this.file("self.json"), JSON.stringify({ ver, key }));
    }
    return this.selfCat.signed!;
  }

  /** 내 망 공유 채널·이름이 바뀌었을 때. */
  ownChanged(): void {
    const before = this.selfCat.ver;
    const cat = this.ownCatalog();
    if (this.selfCat.ver !== before) for (const l of this.links) l.ch.event({ event: "cat", c: cat });
  }

  private ownListed(ch: string): boolean {
    return this.deps.ownChannels().some((c) => c.id === ch);
  }

  private applyMirrors(origin: string): void {
    const c = this.cats.get(origin);
    const keep = new Set<string>();
    if (c && !this.deps.policy?.blocked(origin)) {
      for (const chn of c.body.channels) {
        if (this.deps.policy?.channelBlocked(origin, chn.id)) continue;
        const id = this.mirrorId(origin, chn.id);
        keep.add(id);
        this.deps.channels.register(
          { id, kind: "server", label: `mesh:${c.body.spaceName}/${chn.name}`, members: null, area: "connection" },
          path.join(this.file("mirror"), origin, `${chn.id}.jsonl`),
        );
      }
    }
    const prefix = `m.${origin}.`;
    for (const id of this.deps.channels.ids()) if (id.startsWith(prefix) && !keep.has(id)) this.deps.channels.unregister(id);
  }

  /** 정책이 바뀌었을 때 거울을 다시 맞춘다(T6). */
  refreshMirrors(): void {
    for (const origin of this.cats.keys()) this.applyMirrors(origin);
    this.deps.onServersChanged?.();
  }

  private onCatalog(raw: unknown, from: MeshLink): void {
    const b = openMesh<CatalogBody>("cat", raw);
    const signer = (raw as Signed).signer;
    if (!b || typeof b.origin !== "string" || !SPACE_ID_RE.test(b.origin) || typeof b.ver !== "number" || !Number.isInteger(b.ver) || b.ver < 1
      || !Array.isArray(b.channels)) return this.strike(from, "catalog_bad");
    const self = this.deps.self();
    if (b.origin === self.spaceId) {
      if (signer !== self.keys.publicKeyB64) this.strike(from, "key_conflict");
      return;
    }
    if (this.deps.policy?.blocked(b.origin)) return;
    const pin = this.pins[b.origin];
    if (this.deps.originOf && this.deps.originOf(signer) !== b.origin) return this.strike(from, "key_conflict");
    if (pin && pin !== signer) return this.strike(from, "key_conflict");
    const known = this.cats.get(b.origin);
    if (known && known.body.ver >= b.ver) return; // 같은 것·되돌리기
    if (!known && this.cats.size >= MAX_SERVERS) { this.deps.log("mesh_drop_too_many_servers", { origin: b.origin }); return; }
    const name = validateName(b.spaceName, "server", (s) => this.deps.guard(s, "spaceName"));
    if (!name.ok) return this.strike(from, "catalog_bad");
    const channels: CatalogBody["channels"] = [];
    for (const c of b.channels.slice(0, MAX_CHANNELS)) {
      const x = c as { id?: unknown; name?: unknown };
      const cn = validateName(x?.name, "channel", (s) => this.deps.guard(s, "channelName"));
      if (typeof x?.id === "string" && CHANNEL_ID_RE.test(x.id) && cn.ok) channels.push({ id: x.id, name: cn.name });
    }
    if (!pin) this.pins[b.origin] = signer;
    const body: CatalogBody = { origin: b.origin, spaceName: name.name, ver: b.ver, channels };
    const added = channels.some((c) => !known?.body.channels.some((k) => k.id === c.id));
    this.cats.set(b.origin, { signed: raw as Signed<CatalogBody>, body });
    this.saveDir();
    this.applyMirrors(b.origin);
    this.deps.onServersChanged?.();
    for (const l of this.links) if (l !== from) l.ch.event({ event: "cat", c: raw as object });
    if (added) void this.syncHeads(from);
  }

  // ───────── 연결 ─────────

  attach(info: PeerInfo, ch: LinkChannel): MeshLink {
    if (this.deps.originOf && this.deps.originOf(info.serverKey) !== info.spaceId) {
      this.deps.log("mesh_reject_origin_mismatch", { spaceId: info.spaceId });
      ch.close();
      return { info, ch, strikes: 0, recTimes: [], otherTimes: [] };
    }
    if (this.pins[info.spaceId] && this.pins[info.spaceId] !== info.serverKey) {
      this.deps.log("mesh_key_conflict_direct_wins", { spaceId: info.spaceId });
      this.cats.delete(info.spaceId);
    }
    this.pins[info.spaceId] = info.serverKey;
    const l: MeshLink = { info, ch, strikes: 0, recTimes: [], otherTimes: [] };
    if (this.deps.policy?.blocked(info.spaceId)) {
      this.deps.log("mesh_blocked_link", { spaceId: info.spaceId });
      ch.close();
      return l;
    }
    this.links.add(l);
    ch.onClose(() => this.links.delete(l));
    ch.setHandlers({
      onRequest: (req, reply) => this.onRequest(l, req, reply),
      onEvent: (e) => this.onEvent(l, e),
    });
    ch.event({ event: "cat", c: this.ownCatalog() });
    for (const c of this.cats.values()) if (c.body.origin !== info.spaceId) ch.event({ event: "cat", c: c.signed });
    this.deps.onAttach?.(l);
    void this.syncHeads(l);
    return l;
  }

  stop(): void {
    for (const l of [...this.links]) l.ch.close();
    this.links.clear();
  }

  /** 그 서버로 이어진 연결을 끊는다(총괄 cut). */
  dropLinksTo(spaceId: string): void {
    for (const l of [...this.links]) if (l.info.spaceId === spaceId) l.ch.close();
  }

  private strike(l: MeshLink, code: string): void {
    this.deps.log(`mesh_reject_${code}`, { spaceId: l.info.spaceId });
    l.strikes++;
    if (l.strikes >= STRIKES_TO_DROP && !l.ch.isClosed) {
      this.deps.log("mesh_link_dropped", { spaceId: l.info.spaceId });
      l.ch.close();
    }
  }

  private onRequest(l: MeshLink, req: { op: string; [k: string]: unknown }, reply: (r: object) => void): void {
    if (req.op === "l_heads") return reply({ ok: true, heads: this.heads() });
    if (req.op === "l_pull") {
      const { origin, ch, after, limit } = req as { origin?: unknown; ch?: unknown; after?: unknown; limit?: unknown };
      if (typeof origin !== "string" || typeof ch !== "string" || typeof after !== "number") return reply({ ok: false, code: "bad_request" });
      if (!this.shareable(origin, ch)) return reply({ ok: true, records: [] });
      const n = typeof limit === "number" && limit > 0 ? Math.min(limit, PULL_BATCH) : PULL_BATCH;
      return reply({ ok: true, records: this.readRecords(origin, ch, after, n) });
    }
    reply({ ok: false, code: "op_not_allowed" });
  }

  /** 지금 망에 내보내도 되는 사슬인가(내 공유 채널 또는 목록에 있는 남의 채널, 정책 통과). */
  private shareable(origin: string, ch: string): boolean {
    if (origin === this.deps.self().spaceId) return this.ownListed(ch);
    if (this.deps.policy?.blocked(origin) || this.deps.policy?.channelBlocked(origin, ch)) return false;
    return !!this.cats.get(origin)?.body.channels.some((c) => c.id === ch);
  }

  private heads(): { origin: string; ch: string; n: number }[] {
    const out: { origin: string; ch: string; n: number }[] = [];
    for (const [key, c] of this.chains) {
      const i = key.indexOf("/");
      const origin = key.slice(0, i), ch = key.slice(i + 1);
      if (c.n > 0 && this.shareable(origin, ch)) out.push({ origin, ch, n: c.n });
    }
    return out;
  }

  private async syncHeads(l: MeshLink): Promise<void> {
    const r = await l.ch.request({ op: "l_heads" });
    if (!r?.ok || !Array.isArray(r.heads)) return;
    const self = this.deps.self().spaceId;
    for (const h of r.heads.slice(0, MAX_SERVERS * MAX_CHANNELS)) {
      const x = h as { origin?: unknown; ch?: unknown; n?: unknown };
      if (typeof x?.origin !== "string" || typeof x.ch !== "string" || typeof x.n !== "number" || x.origin === self) continue;
      if (!this.shareable(x.origin, x.ch)) continue;
      const mine = this.chain(x.origin, x.ch);
      if (mine && mine.n >= x.n) continue;
      const win = this.deps.initialWindow?.() ?? PULL_BATCH;
      const after = mine && mine.n > 0 ? mine.n : Math.max(0, x.n - (Number.isFinite(win) ? win : x.n));
      await this.pull(l, x.origin, x.ch, after);
    }
  }

  private async pull(l: MeshLink, origin: string, ch: string, after: number): Promise<void> {
    const key = `${origin}/${ch}`;
    if (this.pulling.has(key)) return;
    this.pulling.add(key);
    try {
      for (let rounds = 0; rounds < 1000 && !l.ch.isClosed; rounds++) {
        const r = await l.ch.request({ op: "l_pull", origin, ch, after, limit: PULL_BATCH });
        if (!r?.ok || !Array.isArray(r.records) || r.records.length === 0) return;
        let last = after;
        for (const rec of r.records.slice(0, PULL_BATCH)) {
          const res = this.handleRecord(rec, l, true);
          if (res !== "ok" && res !== "dup") return;
          last = (rec as Signed<RecordBody>).body.n;
        }
        if (last <= after) return; // 빈 응답이 올 때까지(응답은 개수·바이트로 잘려 옴)
        after = last;
      }
    } finally {
      this.pulling.delete(key);
    }
  }

  private onEvent(l: MeshLink, e: { event: string; [k: string]: unknown }): void {
    if (e.event !== "rec") {
      const now = this.now;
      l.otherTimes = l.otherTimes.filter((t) => now - t < 1000);
      if (l.otherTimes.length >= OTHER_PER_SECOND) { this.deps.log("mesh_drop_other_rate", { spaceId: l.info.spaceId }); return; }
      l.otherTimes.push(now);
    }
    if (e.event === "cat") return this.onCatalog(e.c, l);
    if (e.event === "relay") return this.onRelay(e, l);
    if (e.event === "ack") return this.onAck(e, l);
    if (e.event === "rec") {
      const now = this.now;
      l.recTimes = l.recTimes.filter((t) => now - t < 1000);
      if (l.recTimes.length >= REC_PER_SECOND) { this.deps.log("mesh_drop_rate", { spaceId: l.info.spaceId }); return; }
      l.recTimes.push(now);
      this.handleRecord(e.r, l, false);
      return;
    }
    this.deps.onOtherEvent?.(e, l);
  }

  // ───────── 기록 ─────────

  /** 받은 기록 하나를 검증·저장·전달. 결과 코드를 돌려준다. */
  private handleRecord(raw: unknown, from: MeshLink, pulled: boolean): string {
    const b = openMesh<RecordBody>("rec", raw);
    if (!b || !validRecordBody(b, this.now)) { this.strike(from, "record_bad"); return "bad"; }
    if (b.origin === this.deps.self().spaceId) return "dup"; // 내 기록이 돌아옴
    const key = this.pins[b.origin];
    if (!key) { this.deps.log("mesh_drop_unknown_origin", { origin: b.origin }); return "unknown"; }
    if ((raw as Signed).signer !== key) { this.strike(from, "record_forged"); return "bad"; }
    if (!this.shareable(b.origin, b.ch)) { this.deps.log("mesh_drop_unlisted", { origin: b.origin }); return "unlisted"; }
    const c = this.chain(b.origin, b.ch);
    const res = checkChain(c && c.n > 0 ? { n: c.n, hash: c.hash } : undefined, b, (n) => c?.hashes.get(n));
    if (res === "dup") return "dup";
    if (res === "fork") { this.strike(from, "record_fork"); return "fork"; }
    if (res === "gap") {
      if (!pulled) void this.pull(from, b.origin, b.ch, c!.n);
      return "gap";
    }
    this.appendRecord(b.origin, b.ch, raw as Signed<RecordBody>);
    this.ingest(b);
    this.deps.onRecord?.(b);
    for (const l of this.links) if (l !== from) l.ch.event({ event: "rec", r: raw as object });
    return "ok";
  }

  private ingest(b: RecordBody): void {
    const cat = this.cats.get(b.origin);
    const ch = this.deps.channels.getChannel(this.mirrorId(b.origin, b.ch));
    if (!cat || !ch) return;
    const g = this.deps.guard;
    const msg = this.deps.channels.appendExternal(ch.id, {
      seq: b.n,
      ts: b.ts,
      from: g(`${b.origin}/${b.from}`, "from"),
      fromName: g(b.fromName, "fromName"),
      text: g(b.text, "text", true),
      origin: { scope: "remote", spaceName: cat.body.spaceName, hubUser: g(b.hubUser, "hubUser") },
    });
    if (msg) this.deps.deliver(ch, msg);
  }

  /** 내 망 공유 채널에 새 메시지가 저장된 뒤(Hub가 부른다). 공유 전 대화는 올리지 않는다(Ruling 3). */
  onOwnMessage(chId: string, msg: Message, via: string[] = []): void {
    if (!this.ownListed(chId)) return;
    const self = this.deps.self();
    this.ownCatalog();
    const c = this.chain(self.spaceId, chId);
    const body: RecordBody = {
      origin: self.spaceId, ch: chId, n: (c?.n ?? 0) + 1, prev: c?.hash ?? "", seq: msg.seq, ts: msg.ts,
      from: msg.from, fromName: msg.fromName, hubUser: msg.origin?.hubUser ?? self.userName, via, text: msg.text,
    };
    const signed = signMesh<RecordBody>("rec", body, self.keys);
    this.appendRecord(self.spaceId, chId, signed);
    for (const l of this.links) l.ch.event({ event: "rec", r: signed });
  }

  // ───────── 중계 쓰기 ─────────

  /** 처음 보는 것만 true(중복 제거 기억, 상한 SEEN_MAX). */
  private firstSeen(key: string): boolean {
    if (this.seen.has(key)) return false;
    this.seen.set(key, this.now);
    if (this.seen.size > SEEN_MAX) this.seen.delete(this.seen.keys().next().value as string);
    return true;
  }

  /** 이벤트를 모든 연결로(except 빼고). */
  flood(e: { event: string; [k: string]: unknown }, except?: MeshLink): void {
    for (const l of this.links) if (l !== except) l.ch.event(e);
  }

  /** 망 거울 채널(m.<대상>.<채널>)에 쓴다: 이 서버가 서명해 망으로 보내고, 대상 서버의 응답(seq)을 기다린다. */
  relayWrite(o: { mirrorId: string; from: string; fromName: string; hubUser: string; text: string }): Promise<{ ok: true; seq: number } | { ok: false; code: string }> {
    const p = this.parseMirror(o.mirrorId);
    if (!p || this.deps.policy?.blocked(p.origin) || this.deps.policy?.channelBlocked(p.origin, p.ch)) return Promise.resolve({ ok: false, code: "channel_not_found" });
    const self = this.deps.self();
    if (this.deps.policy?.noWrite?.(self.spaceId, o.hubUser)) return Promise.resolve({ ok: false, code: "relay_write_blocked" });
    const body: RelayBody = { reqId: randomUUID(), entry: self.spaceId, entryName: self.spaceName, target: p.origin, ch: p.ch, from: o.from, fromName: o.fromName, hubUser: o.hubUser, text: o.text, ts: this.now };
    const q = signMesh<RelayBody>("relay", body, self.keys);
    this.firstSeen(`relay:${body.reqId}`);
    return new Promise((resolve) => {
      const t = setTimeout(() => { if (this.pendingRelay.delete(body.reqId)) resolve({ ok: false, code: "relay_timeout" }); }, this.deps.relayTimeoutMs ?? 15_000);
      t.unref?.();
      this.pendingRelay.set(body.reqId, (r) => { clearTimeout(t); resolve(r); });
      this.flood({ event: "relay", q, ttl: RELAY_TTL });
    });
  }

  private onRelay(e: { [k: string]: unknown }, from: MeshLink): void {
    const b = openMesh<RelayBody>("relay", e.q);
    const isS = (x: unknown, max: number) => typeof x === "string" && x.length > 0 && x.length <= max;
    if (!b || !isS(b.reqId, 64) || !isS(b.entry, 64) || !isS(b.entryName, 256) || !isS(b.target, 64) || !isS(b.ch, 128) || !isS(b.from, 300)
      || !isS(b.fromName, 256) || !isS(b.hubUser, 256) || typeof b.text !== "string" || typeof b.ts !== "number") return this.strike(from, "relay_bad");
    const self = this.deps.self();
    if (b.entry === self.spaceId) return; // 내 요청이 돌아옴
    const key = this.pins[b.entry];
    if (!key) { this.deps.log("mesh_drop_relay_unknown_entry", { entry: b.entry }); return; }
    if ((e.q as Signed).signer !== key) return this.strike(from, "relay_forged");
    if (Math.abs(this.now - b.ts) > RELAY_MAX_AGE_MS) { this.deps.log("mesh_drop_relay_stale", { entry: b.entry }); return; }
    if (this.deps.policy?.blocked(b.entry)) return;
    if (!this.firstSeen(`relay:${b.reqId}`)) return;
    if (b.target !== self.spaceId) {
      const ttl = typeof e.ttl === "number" ? Math.min(e.ttl, RELAY_TTL) - 1 : 0;
      if (ttl > 0) this.flood({ event: "relay", q: e.q, ttl }, from);
      return;
    }
    const ack = (r: { ok: true; seq: number } | { ok: false; code: string }) => {
      const body: AckBody = { reqId: b.reqId, entry: b.entry, target: self.spaceId, ...r };
      this.firstSeen(`ack:${b.reqId}`);
      this.flood({ event: "ack", a: signMesh<AckBody>("ack", body, self.keys) });
    };
    if (!this.ownListed(b.ch)) { this.deps.log("mesh_reject_relay_unshared", { entry: b.entry }); return ack({ ok: false, code: "channel_forbidden" }); }
    // 진입 서버마다 10초에 60개(방식 2 구성원과 같은 기준) — 이어진 서버 하나가 채널을 도배하지 못하게
    const now = this.now;
    const times = (this.relayTimes.get(b.entry) ?? []).filter((t) => now - t < 10_000);
    if (times.length >= RELAY_PER_10S) {
      this.relayTimes.set(b.entry, times);
      this.deps.log("mesh_drop_relay_rate", { entry: b.entry });
      return ack({ ok: false, code: "rate_limited" });
    }
    times.push(now);
    this.relayTimes.set(b.entry, times);
    if (this.deps.policy?.noWrite?.(b.entry, b.hubUser)) { this.deps.log("mesh_reject_relay_nowrite", { entry: b.entry }); return ack({ ok: false, code: "relay_write_blocked" }); }
    if (b.text.length === 0 || b.text.length > MAX_TEXT_LENGTH) return ack({ ok: false, code: "text_invalid" });
    const g = this.deps.guard;
    const text = g(b.text, "text", true);
    if (text.length > MAX_STORED_TEXT_LENGTH) return ack({ ok: false, code: "text_hidden_too_long" });
    const entryName = this.cats.get(b.entry)?.body.spaceName ?? g(b.entryName, "spaceName");
    const msg = this.deps.appendOwn?.(b.ch, g(`${b.entry}/${b.from}`, "from"), g(b.fromName, "fromName"), text, { scope: "remote", spaceName: entryName, hubUser: g(b.hubUser, "hubUser") });
    if (!msg) return ack({ ok: false, code: "channel_forbidden" });
    this.onOwnMessage(b.ch, msg, [entryName]);
    ack({ ok: true, seq: msg.seq });
  }

  private onAck(e: { [k: string]: unknown }, from: MeshLink): void {
    const b = openMesh<AckBody>("ack", e.a);
    if (!b || typeof b.reqId !== "string" || typeof b.target !== "string" || typeof b.entry !== "string") return this.strike(from, "ack_bad");
    const key = this.pins[b.target];
    if (!key || (e.a as Signed).signer !== key) return this.strike(from, "ack_forged");
    if (!this.firstSeen(`ack:${b.reqId}`)) return;
    if (b.entry === this.deps.self().spaceId) {
      const p = this.pendingRelay.get(b.reqId);
      if (!p) return;
      this.pendingRelay.delete(b.reqId);
      p(b.ok && typeof b.seq === "number" ? { ok: true, seq: b.seq } : { ok: false, code: typeof b.code === "string" ? b.code.slice(0, 64) : "relay_failed" });
      return;
    }
    this.flood({ event: "ack", a: e.a }, from);
  }
}
