// 망 엔진(방식 3, v3.0 5단계): 서버 연결로 이어진 통신 서버들 사이에 목록(catalog)·서명 기록을 퍼뜨린다.
// - 목록: 서버마다 자기 망 공유 채널을 서명해 알림. 버전이 높은 것만 받고 다시 퍼뜨림(고리에서도 멈춤). 처음 본 공간 ID의 키 고정,
//   직접 이은 서버는 연결 때 확인한 키가 우선.
// - 기록: (출처, 채널)마다 이어진 사슬. 출처 키 서명·사슬·목록에 있는 채널·시각·크기를 확인해 틀리면 거부(설계 5.4),
//   같은 연결에서 3번 거부하면 그 연결을 끊는다. 받아들인 기록은 거울 채널 m.<출처>.<채널>에 넣고 받은 곳을 뺀 연결로 민다.
// - 다른 서버를 믿지 않는다: 모든 문자열은 감독(guard)을 다시 거친다.
import fs from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { writeFileAtomic } from "../../fsutil.js";
import { validateName } from "../../names.js";
import type { ChannelStore } from "../../channels.js";
import { MAX_STORED_TEXT_LENGTH, MAX_TEXT_LENGTH, type Channel, type Message, type MessageOrigin } from "../../../shared/protocol.js";
import type { SigningKeys } from "../../../shared/connCrypto.js";
import { decodeVerifyCode, openVerifyAnswer, sealVerifyAnswer, VerifyStore, type Sealed } from "./verify.js";
import { checkChain, cleanSigned, MAX_SIGNED_BYTES, openMesh, recordHash, signMesh, validRecordBody, type RecordBody, type Signed } from "../../../shared/meshRecord.js";
import type { LinkChannel } from "./link.js";

export { meshIdOf } from "../../../shared/connCrypto.js";

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
  /** 새 후보가 생겼을 때. */
  onCandidate?(origin: string): void;
  /** 백업 최고 번호를 알리는 최소 간격(기본 5분). */
  beaconIntervalMs?: number;
  /** 답이 없는 후보에게 다시 묻는 간격(기본 60초). */
  verifyRetryMs?: number;
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

interface Accepted {
  key: string;
  how: "direct" | "manual" | "code";
  at: number;
}

interface Candidate {
  signed: Signed<CatalogBody>;
  body: CatalogBody;
  signer: string;
  /** 이 후보를 알려 준 연결(망 ID). */
  via: string;
  /** 이 후보를 아는 연결 전부 — 하나가 끊겨도 다른 연결이 알고 있으면 남는다. */
  vias: string[];
  at: number;
  /** 코드 답이 틀렸음 — 자동 인정 안 함, 주인에게 경고. */
  warning: boolean;
}

interface BHeadBody { origin: string; index: number; hash: string; ts: number; /** 어느 저장소의 번호인지(저장소 정보의 해시). */ store: string }

export interface RestoredBackup {
  origin: string;
  hubKey: string;
  index: number;
  store?: string;
  /** 이미 경고한 번호(같은 경고를 되풀이하지 않게). */
  warned?: number;
}

function readRestored(dir: string): RestoredBackup[] {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(dir, "restored.json"), "utf8")) as RestoredBackup[];
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** 복원 기록을 남긴다(망이 아직 없어도 — 이어지면 확인한다). */
export function noteRestored(dir: string, rec: RestoredBackup): void {
  fs.mkdirSync(dir, { recursive: true });
  const list = [...readRestored(dir).filter((r) => r.origin !== rec.origin), rec].slice(-32);
  writeFileAtomic(path.join(dir, "restored.json"), JSON.stringify(list));
}

interface VChalBody { verifier: string; prover: string; challenge: string; ts: number }
interface VRespBody { verifier: string; prover: string; cid: string; challenge: string; sealed: Sealed; ts: number }

export interface MeshLink {
  info: PeerInfo;
  ch: LinkChannel;
  strikes: number;
  recTimes: number[];
  otherTimes: number[];
  verifyTimes: number[];
  attachedAt: number;
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
/** 인정 전 후보: 전체·연결별 상한(메모리에만 — 재시작하면 사라진다). */
const MAX_CANDIDATES = 64;
/** 한 번에 살펴볼 사슬 머리 수. */
const MAX_HEADS = 6400;
const MAX_CANDIDATES_PER_LINK = 16;
const MAX_REJECTED = 256;
/** 인증 코드 답을 기다리는 시간. */
const VERIFY_ANSWER_MS = 15_000;
const MAX_CHANNELS = 100;
const PULL_BATCH = 500;
/** 당기기 응답 한 번의 기록 바이트 상한 — 받는 쪽 프레임 상한(1MB)보다 넉넉히 작게. */
const PULL_MAX_BYTES = 640 * 1024;
const STRIKES_TO_DROP = 3;
const REC_PER_SECOND = 200;
/** 한 연결의 기록 외 이벤트(목록·중계·확인·총괄 등) 초당 상한 — 넘으면 버린다. */
const OTHER_PER_SECOND = 100;
/** 연결 직후에는 목록·보고를 묶어서 받으므로 예산을 넓게. */
const ATTACH_WINDOW_MS = 5_000;
const ATTACH_PER_SECOND = 1000;
/** 인증 질문·답: 별도 예산과 크기 상한(발신자를 몰라도 전달되므로 작게). */
const VERIFY_PER_SECOND = 100;
const VERIFY_MAX_BYTES = 4096;
/** 갈라짐 알림은 서버당 이 시간에 이 개수까지. */
const FORK_ALERT_WINDOW_MS = 10 * 60_000;
const FORK_ALERTS_PER_WINDOW = 5;
const RELAY_TTL = 8;
const RELAY_MAX_AGE_MS = 10 * 60_000;
/** 서버(중계 시작·확인 서명자)별 중복 제거 기억 상한 — 10분 안 정상 최대(3600)보다 크고, 다른 서버 몫을 밀어내지 못한다. */
const SEEN_PER_ENTRY = 5000;
const MAX_FORKS_SEEN = 4096;
/** 백업 최고 번호 보고 간격·기억 상한·미래 시각 허용. */
const BEACON_INTERVAL_MS = 5 * 60_000;
const MAX_HEADS_KEPT = 256;
const BEACON_FUTURE_MS = 5 * 60_000;
const RELAY_PER_10S = 60;

export class Mesh {
  readonly links = new Set<MeshLink>();
  private pins: Record<string, string> = {};
  private cats = new Map<string, { signed: Signed<CatalogBody>; body: CatalogBody }>();
  private chains = new Map<string, Chain>();
  private selfCat: { ver: number; key: string; signed: Signed<CatalogBody> | null } = { ver: 0, key: "", signed: null };
  private pulling = new Set<string>();
  private seen = new Map<string, Map<string, number>>();
  private forksSeen = new Set<string>();
  private forkTimes = new Map<string, number[]>();
  private backupHeads: Record<string, Signed<BHeadBody>> = {};
  private beaconDirty = false;
  private lastBeaconAt = 0;
  private restored: RestoredBackup[] = [];
  private relayTimes = new Map<string, number[]>();
  private accepted: Record<string, Accepted> = {};
  private cands = new Map<string, Candidate>();
  private rejected = new Set<string>();
  private pendingVerify = new Map<string, { origin: string; expires: number }>();
  private readonly verify: VerifyStore;
  private readonly verifyTimer: NodeJS.Timeout;
  private pendingRelay = new Map<string, (r: { ok: true; seq: number } | { ok: false; code: string }) => void>();

  constructor(private readonly deps: MeshDeps) {
    this.verify = new VerifyStore(deps.dir);
    this.load();
    this.verifyTimer = setInterval(() => { for (const o of this.cands.keys()) this.challenge(o); this.flushBeacon(); }, deps.verifyRetryMs ?? 60_000);
    this.verifyTimer.unref?.();
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
      const d = JSON.parse(fs.readFileSync(this.file("dir.json"), "utf8")) as { pins?: Record<string, string>; cats?: Record<string, unknown>; accepted?: Record<string, Accepted> };
      if (d.accepted && typeof d.accepted === "object") this.accepted = { ...d.accepted };
      if (d.pins && typeof d.pins === "object") this.pins = { ...d.pins };
      for (const [origin, raw] of Object.entries(d.cats ?? {})) {
        const b = openMesh<CatalogBody>("cat", raw, this.pins[origin]);
        if (b && b.origin === origin && this.accepted[origin]) this.cats.set(origin, { signed: raw as Signed<CatalogBody>, body: b });
      }
    } catch {
      // 처음
    }
    try {
      const h = JSON.parse(fs.readFileSync(this.file("backup-heads.json"), "utf8")) as Record<string, Signed<BHeadBody>>;
      if (h && typeof h === "object") this.backupHeads = h;
    } catch {
      // 처음
    }
    this.restored = readRestored(this.deps.dir);
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
    writeFileAtomic(this.file("dir.json"), JSON.stringify({ pins: this.pins, cats, accepted: this.accepted }, null, 2));
  }

  private appendRecord(origin: string, ch: string, r: Signed<RecordBody>, rf?: string): void {
    let c = this.chain(origin, ch);
    if (!c) {
      c = { n: 0, hash: "", hashes: new Map(), file: path.join(this.file("rec"), origin, `${ch}.jsonl`) };
      this.chains.set(`${origin}/${ch}`, c);
    }
    fs.mkdirSync(path.dirname(c.file), { recursive: true });
    fs.appendFileSync(c.file, JSON.stringify(rf ? { ...r, rf } : r) + "\n");
    const h = recordHash(r.body);
    c.hashes.set(r.body.n, h);
    c.n = r.body.n;
    c.hash = h;
  }

  /** 이 번호의 내 기록(서명째로)과 내게 준 이웃. */
  private recordAt(origin: string, ch: string, n: number): { signed: Signed<RecordBody>; rf: string } | null {
    const c = this.chain(origin, ch);
    if (!c) return null;
    try {
      for (const line of fs.readFileSync(c.file, "utf8").split("\n")) {
        if (!line) continue;
        try {
          const r = JSON.parse(line) as Signed<RecordBody> & { rf?: string };
          if (r.body.n !== n) continue;
          const signed = cleanSigned<RecordBody>(r);
          if (signed) return { signed, rf: r.rf ?? origin };
        } catch { /* 손상 줄 */ }
      }
    } catch { /* 없음 */ }
    return null;
  }

  private readRecords(origin: string, ch: string, after: number, limit: number): { records: Signed<RecordBody>[]; tags: string[] } {
    const c = this.chain(origin, ch);
    if (!c) return { records: [], tags: [] };
    const out: Signed<RecordBody>[] = [];
    const tags: string[] = [];
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
          const clean = cleanSigned<RecordBody>(r);
          if (!clean) continue;
          out.push(clean);
          tags.push((r as { rf?: string }).rf ?? origin);
          bytes += size;
        } catch { /* 손상 줄 */ }
        if (out.length >= limit) break;
      }
    } catch { /* 없음 */ }
    return { records: out, tags };
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

  /** 서명 밖 필드를 버린 묶음(저장·전달은 이것만). 형식이 틀리면 그대로 돌려줘 openMesh가 거부하게 하고, 너무 크면 null(서명자의 문제라 벌점 없음). */
  sanitize(raw: unknown): unknown | null {
    const c = cleanSigned(raw);
    if (!c) return raw;
    if (Buffer.byteLength(JSON.stringify(c)) > MAX_SIGNED_BYTES) {
      this.deps.log("mesh_drop_oversized", {});
      return null;
    }
    return c;
  }

  // ───────── 서버 인정(후보·인증 코드·수동 승인) ─────────

  /** 목록으로 처음 들은 서버는 후보로만 둔다 — 저장·거울·전달 없음. */
  private noteCandidate(raw: Signed<CatalogBody>, body: CatalogBody, signer: string, from: MeshLink): void {
    const origin = body.origin;
    if (this.rejected.has(origin)) return;
    const had = this.cands.get(origin);
    const via = from.info.spaceId;
    if (had && !had.vias.includes(via)) had.vias.push(via);
    if (had && had.body.ver >= body.ver) return;
    if (!had) {
      const mine = [...this.cands.values()].filter((c) => c.via === via);
      if (mine.length >= MAX_CANDIDATES_PER_LINK) this.cands.delete(mine[0].body.origin);
      else if (this.cands.size >= MAX_CANDIDATES && !this.evictBusiestCandidate(mine.length)) { this.deps.log("mesh_drop_too_many_candidates", { origin }); return; }
    }
    this.cands.set(origin, { signed: raw, body, signer, via: had?.via ?? via, vias: had?.vias ?? [via], at: had?.at ?? this.now, warning: had?.warning ?? false });
    if (had) return;
    this.deps.log("mesh_candidate", { origin, via });
    this.deps.onCandidate?.(origin);
    this.challenge(origin);
  }

  /** 후보가 가득 찼을 때, 새 후보를 알린 연결보다 후보가 많은 연결의 가장 오래된 후보를 내보낸다. */
  private evictBusiestCandidate(mine: number): boolean {
    const counts = new Map<string, number>();
    for (const c of this.cands.values()) counts.set(c.via, (counts.get(c.via) ?? 0) + 1);
    let busiest: string | null = null;
    let most = mine;
    for (const [via, n] of counts) if (n > most) { busiest = via; most = n; }
    if (busiest === null) return false;
    for (const c of this.cands.values()) if (c.via === busiest) { this.cands.delete(c.body.origin); return true; }
    return false;
  }

  candidates(): { origin: string; spaceName: string; via: string; warning: boolean; at: number }[] {
    return [...this.cands.values()].map((c) => ({ origin: c.body.origin, spaceName: c.body.spaceName, via: c.via, warning: c.warning, at: c.at }));
  }

  /** 후보를 정식으로 인정한다(주인이 승인 또는 코드 확인 성공). */
  acceptServer(origin: string, how: "manual" | "code" = "manual"): boolean {
    const c = this.cands.get(origin);
    if (!c) return false;
    this.cands.delete(origin);
    this.accepted[origin] = { key: c.signer, how, at: this.now };
    this.pins[origin] = c.signer;
    this.cats.set(origin, { signed: c.signed, body: c.body });
    this.saveDir();
    this.applyMirrors(origin);
    this.deps.onServersChanged?.();
    this.deps.log("mesh_server_accepted", { origin, how });
    for (const l of this.links) {
      if (l.info.spaceId !== c.via) l.ch.event({ event: "cat", c: c.signed });
      void this.syncHeads(l);
    }
    return true;
  }

  /** 후보를 거절하거나 인정을 취소한다. 직접 이은 서버는 연결을 끊어야 한다. */
  rejectServer(origin: string): boolean {
    if (this.cands.delete(origin)) {
      this.rememberRejected(origin);
      return true;
    }
    const a = this.accepted[origin];
    if (!a || a.how === "direct") return false;
    this.forget(origin, false);
    this.rememberRejected(origin);
    return true;
  }

  private rememberRejected(origin: string): void {
    this.rejected.add(origin);
    if (this.rejected.size > MAX_REJECTED) this.rejected.delete(this.rejected.values().next().value as string);
  }

  /** 직접 연결을 끊었을 때 — 그 서버의 인정도 거둔다. */
  forgetDirect(origin: string): void {
    if (this.accepted[origin]?.how === "direct") this.forget(origin, false);
  }

  private forget(origin: string, backToCandidate: boolean): void {
    const cat = this.cats.get(origin);
    const key = this.accepted[origin]?.key;
    delete this.accepted[origin];
    delete this.pins[origin];
    this.cats.delete(origin);
    if (cat && key && backToCandidate) this.cands.set(origin, { signed: cat.signed, body: cat.body, signer: key, via: "", vias: [], at: this.now, warning: false });
    this.saveDir();
    this.applyMirrors(origin);
    this.deps.onServersChanged?.();
  }

  issueVerifyCode(label: string): string {
    const code = this.verify.issue(this.deps.self().spaceId, label, this.now);
    this.deps.log("mesh_verify_code_created", {});
    return code;
  }

  registerVerifyCode(code: string): { ok: true } | { ok: false; code: string } {
    const c = decodeVerifyCode(code);
    if (!c) return { ok: false, code: "verify_code_invalid" };
    if (c.issuer === this.deps.self().spaceId) return { ok: false, code: "verify_code_own" };
    if (!this.verify.add(c, this.now)) return { ok: false, code: "verify_too_many" };
    this.deps.log("mesh_verify_code_added", { issuer: c.issuer });
    return { ok: true };
  }

  listVerifyCodes(): ReturnType<VerifyStore["list"]> {
    return this.verify.list();
  }

  deleteVerifyCode(kind: "managed" | "held", cid: string): boolean {
    if (kind === "held") return this.verify.removeHeld(cid);
    const m = this.verify.removeManaged(cid);
    if (!m) return false;
    if (m.boundTo && this.accepted[m.boundTo]?.how === "code") this.forget(m.boundTo, true);
    return true;
  }

  /** 후보에게 코드를 답할 수 있는지 묻는다. 내가 낸 코드가 없으면 물을 이유가 없다. */
  private challenge(origin: string): void {
    const c = this.cands.get(origin);
    if (!c || !this.verify.hasManaged) return; // 틀렸어도 다시 묻는다 — 새 코드를 넣으면 맞을 수 있다
    const now = this.now;
    for (const [k, p] of this.pendingVerify) if (p.expires <= now) this.pendingVerify.delete(k);
    if ([...this.pendingVerify.values()].some((p) => p.origin === origin)) return;
    const self = this.deps.self();
    const challenge = randomBytes(32).toString("base64");
    this.pendingVerify.set(challenge, { origin, expires: now + VERIFY_ANSWER_MS });
    this.firstSeen("v", `vchal:${challenge}`);
    const body: VChalBody = { verifier: self.spaceId, prover: origin, challenge, ts: now };
    this.flood({ event: "v_chal", m: signMesh<VChalBody>("vchal", body, self.keys), ttl: RELAY_TTL });
  }

  private forwardVerify(e: { event: string; [k: string]: unknown }, m: unknown, from: MeshLink): void {
    const ttl = typeof e.ttl === "number" ? Math.min(e.ttl, RELAY_TTL) - 1 : 0;
    if (ttl > 0) this.flood({ event: e.event, m, ttl }, from);
  }

  /** 인증 질문·답을 꺼낸다(서명 밖 필드 제거, 크기 상한). */
  private verifyMessage(e: { [k: string]: unknown }): unknown | null {
    const m = this.sanitize(e.m);
    if (m === null) return null;
    return Buffer.byteLength(JSON.stringify(m)) > VERIFY_MAX_BYTES ? null : m;
  }

  private onVerifyChallenge(e: { event: string; [k: string]: unknown }, from: MeshLink): void {
    const m = this.verifyMessage(e);
    if (m === null) return;
    const b = openMesh<VChalBody>("vchal", m);
    const signer = (m as Signed).signer;
    if (!b || typeof b.verifier !== "string" || typeof b.prover !== "string" || typeof b.challenge !== "string" || b.challenge.length > 128 || typeof b.ts !== "number") return;
    if (this.deps.originOf && this.deps.originOf(signer) !== b.verifier) return;
    if (!this.firstSeen("v", `vchal:${b.challenge}`)) return;
    const self = this.deps.self();
    if (b.prover !== self.spaceId) return this.forwardVerify(e, m, from);
    if (Math.abs(this.now - b.ts) > RELAY_MAX_AGE_MS) return;
    const held = this.verify.heldFor(b.verifier);
    if (!held) return; // 코드를 준 서버의 질문에만 답한다
    const sealed = sealVerifyAnswer(held, { verifierId: b.verifier, proverId: self.spaceId, proverKey: self.keys.publicKeyB64, challenge: b.challenge });
    const body: VRespBody = { verifier: b.verifier, prover: self.spaceId, cid: held.cid, challenge: b.challenge, sealed, ts: this.now };
    this.firstSeen("v", `vresp:${b.challenge}:${self.keys.publicKeyB64}`);
    this.flood({ event: "v_resp", m: signMesh<VRespBody>("vresp", body, self.keys), ttl: RELAY_TTL });
  }

  private onVerifyResponse(e: { event: string; [k: string]: unknown }, from: MeshLink): void {
    const m = this.verifyMessage(e);
    if (m === null) return;
    const b = openMesh<VRespBody>("vresp", m);
    const signer = (m as Signed).signer;
    if (!b || typeof b.verifier !== "string" || typeof b.prover !== "string" || typeof b.cid !== "string" || typeof b.challenge !== "string" || b.challenge.length > 128 || !b.sealed || typeof b.sealed !== "object") return;
    if (this.deps.originOf && this.deps.originOf(signer) !== b.prover) return;
    if (!this.firstSeen("v", `vresp:${b.challenge}:${signer}`)) return; // 서명자별 — 다른 서버의 가짜 답이 진짜 답을 태우지 못하게
    if (b.verifier !== this.deps.self().spaceId) return this.forwardVerify(e, m, from);
    const pending = this.pendingVerify.get(b.challenge);
    if (!pending || pending.origin !== b.prover || pending.expires <= this.now) return;
    this.pendingVerify.delete(b.challenge);
    const cand = this.cands.get(b.prover);
    if (!cand || cand.signer !== signer) return;
    const issued = this.verify.findManaged(b.cid);
    const ok = !!issued && (!issued.boundTo || issued.boundTo === b.prover)
      && openVerifyAnswer(issued, { verifierId: b.verifier, proverId: b.prover, proverKey: signer, challenge: b.challenge }, b.sealed);
    if (!ok) {
      if (!cand.warning) this.deps.log("mesh_verify_failed", { origin: b.prover });
      cand.warning = true;
      return;
    }
    this.verify.bind(b.cid, b.prover);
    this.acceptServer(b.prover, "code");
  }

  // ───────── 망 안의 최고 백업 번호 ─────────

  private saveHeads(): void {
    fs.mkdirSync(this.deps.dir, { recursive: true });
    writeFileAtomic(this.file("backup-heads.json"), JSON.stringify(this.backupHeads));
  }

  private rememberHead(h: Signed<BHeadBody>): void {
    this.backupHeads[h.body.origin] = h;
    const ids = Object.keys(this.backupHeads);
    if (ids.length > MAX_HEADS_KEPT) delete this.backupHeads[ids[0]];
    this.saveHeads();
  }

  /** 내 백업의 최고 번호를 망에 알린다(바뀌었을 때만, 간격을 지켜서). */
  setBackupHead(index: number, hash: string, store = ""): void {
    const self = this.deps.self();
    const old = this.backupHeads[self.spaceId];
    if (old && old.body.store === store && old.body.index >= index) return;
    this.rememberHead(signMesh<BHeadBody>("bhead", { origin: self.spaceId, index, hash, ts: this.now, store }, self.keys));
    this.beaconDirty = true;
    this.flushBeacon();
  }

  private flushBeacon(): void {
    if (!this.beaconDirty || this.now - this.lastBeaconAt < (this.deps.beaconIntervalMs ?? BEACON_INTERVAL_MS)) return;
    const h = this.backupHeads[this.deps.self().spaceId];
    if (!h) return;
    this.beaconDirty = false;
    this.lastBeaconAt = this.now;
    this.flood({ event: "bhead", h });
  }

  /** 그 서버의 백업에 대해 기억하는 최고 번호(모르면 null). */
  backupHeadOf(origin: string): number | null {
    return this.backupHeads[origin]?.body.index ?? null;
  }

  /** 시험용: 형식을 일부러 틀린 보고를 내 키로 서명해 보낸다. */
  sendRawBeaconForTest(body: object): void {
    this.flood({ event: "bhead", h: signMesh("bhead", body, this.deps.self().keys) });
  }

  private onBackupHead(e: { [k: string]: unknown }, from: MeshLink): void {
    const h = cleanSigned<BHeadBody>(this.sanitize(e.h));
    if (!h) return;
    const b = openMesh<BHeadBody>("bhead", h);
    if (!b || typeof b.origin !== "string" || !SPACE_ID_RE.test(b.origin) || !Number.isSafeInteger(b.index) || b.index < 0
      || typeof b.hash !== "string" || !/^[0-9a-f]{64}$/.test(b.hash) || typeof b.ts !== "number" || b.ts > this.now + BEACON_FUTURE_MS || typeof b.store !== "string" || b.store.length > 64) return;
    if (!this.accepted[b.origin] || h.signer !== this.pins[b.origin]) return; // 인정한 서버가 직접 서명한 것만 — 이웃이 숫자를 부풀릴 수 없다
    const old = this.backupHeads[b.origin];
    if (old && (old.body.store === b.store ? old.body.index >= b.index : old.body.ts >= b.ts)) return; // 저장소를 바꾸면 번호가 다시 시작한다
    this.rememberHead(h);
    this.flood({ event: "bhead", h }, from);
  }

  /** 복원한 백업을 기록하고, 이어진 이웃에게 더 높은 번호를 기억하는지 묻는다. */
  addRestored(rec: RestoredBackup): void {
    noteRestored(this.deps.dir, rec);
    this.restored = readRestored(this.deps.dir);
    for (const l of this.links) void this.queryRestored(l);
  }

  private async queryRestored(l: MeshLink): Promise<void> {
    for (const rec of this.restored) {
      const r = await l.ch.request({ op: "l_backup_head", origin: rec.origin });
      const h = cleanSigned<BHeadBody>(r?.head);
      const b = h ? openMesh<BHeadBody>("bhead", h, rec.hubKey) : null;
      if (!b || b.origin !== rec.origin || !Number.isSafeInteger(b.index) || b.store !== (rec.store ?? "") || b.index <= rec.index || (rec.warned ?? -1) >= b.index) continue;
      rec.warned = b.index;
      writeFileAtomic(path.join(this.deps.dir, "restored.json"), JSON.stringify(this.restored));
      this.deps.log("storage_restore_behind_mesh", { origin: rec.origin, restoredIndex: rec.index, knownIndex: b.index });
    }
  }

  private onCatalog(raw: unknown, from: MeshLink): void {
    raw = this.sanitize(raw);
    if (raw === null) return;
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
    const name = validateName(b.spaceName, "server", (s) => this.deps.guard(s, "spaceName"));
    if (!name.ok) return this.strike(from, "catalog_bad");
    const channels: CatalogBody["channels"] = [];
    for (const c of b.channels.slice(0, MAX_CHANNELS)) {
      const x = c as { id?: unknown; name?: unknown };
      const cn = validateName(x?.name, "channel", (s) => this.deps.guard(s, "channelName"));
      if (typeof x?.id === "string" && CHANNEL_ID_RE.test(x.id) && cn.ok) channels.push({ id: x.id, name: cn.name });
    }
    const body: CatalogBody = { origin: b.origin, spaceName: name.name, ver: b.ver, channels };
    if (!this.accepted[b.origin]) return this.noteCandidate(raw as Signed<CatalogBody>, body, signer, from);
    if (!pin) this.pins[b.origin] = signer;
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
      return { info, ch, strikes: 0, recTimes: [], otherTimes: [], verifyTimes: [], attachedAt: this.now };
    }
    if (this.pins[info.spaceId] && this.pins[info.spaceId] !== info.serverKey) {
      this.deps.log("mesh_key_conflict_direct_wins", { spaceId: info.spaceId });
      this.cats.delete(info.spaceId);
    }
    this.pins[info.spaceId] = info.serverKey;
    if (this.accepted[info.spaceId]?.key !== info.serverKey || this.accepted[info.spaceId]?.how !== "direct") {
      this.accepted[info.spaceId] = { key: info.serverKey, how: "direct", at: this.now };
      this.saveDir();
    }
    this.cands.delete(info.spaceId);
    this.rejected.delete(info.spaceId);
    const l: MeshLink = { info, ch, strikes: 0, recTimes: [], otherTimes: [], verifyTimes: [], attachedAt: this.now };
    if (this.deps.policy?.blocked(info.spaceId)) {
      this.deps.log("mesh_blocked_link", { spaceId: info.spaceId });
      ch.close();
      return l;
    }
    this.links.add(l);
    ch.onClose(() => {
      this.links.delete(l);
      if ([...this.links].some((x) => x.info.spaceId === info.spaceId)) return;
      for (const [o, c] of this.cands) {
        if (!c.vias.includes(info.spaceId)) continue;
        c.vias = c.vias.filter((v) => v !== info.spaceId);
        if (c.vias.length === 0) this.cands.delete(o);
        else if (c.via === info.spaceId) c.via = c.vias[0];
      }
    });
    ch.setHandlers({
      onRequest: (req, reply) => this.onRequest(l, req, reply),
      onEvent: (e) => this.onEvent(l, e),
    });
    ch.event({ event: "cat", c: this.ownCatalog() });
    for (const c of this.cats.values()) if (c.body.origin !== info.spaceId) ch.event({ event: "cat", c: c.signed });
    for (const h of Object.values(this.backupHeads)) ch.event({ event: "bhead", h });
    this.deps.onAttach?.(l);
    void this.syncHeads(l);
    void this.queryRestored(l);
    return l;
  }

  stop(): void {
    clearInterval(this.verifyTimer);
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
    if (req.op === "l_backup_head") return reply({ ok: true, head: typeof req.origin === "string" ? this.backupHeads[req.origin] ?? null : null });
    if (req.op === "l_pull") {
      const { origin, ch, after, limit } = req as { origin?: unknown; ch?: unknown; after?: unknown; limit?: unknown };
      if (typeof origin !== "string" || typeof ch !== "string" || typeof after !== "number") return reply({ ok: false, code: "bad_request" });
      if (!this.shareable(origin, ch)) return reply({ ok: true, records: [], tags: [] });
      const n = typeof limit === "number" && limit > 0 ? Math.min(limit, PULL_BATCH) : PULL_BATCH;
      return reply({ ok: true, ...this.readRecords(origin, ch, after, n) });
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
    for (const h of r.heads.slice(0, MAX_HEADS)) {
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
        const tags: unknown[] = Array.isArray(r.tags) ? r.tags : [];
        for (const [i, rec] of r.records.slice(0, PULL_BATCH).entries()) {
          const res = this.handleRecord(rec, l, true, tags[i]);
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
    if (e.event === "v_chal" || e.event === "v_resp") {
      const now = this.now;
      l.verifyTimes = l.verifyTimes.filter((t) => now - t < 1000);
      if (l.verifyTimes.length >= VERIFY_PER_SECOND) { this.deps.log("mesh_drop_verify_rate", { spaceId: l.info.spaceId }); return; }
      l.verifyTimes.push(now);
    } else if (e.event !== "rec") {
      const now = this.now;
      l.otherTimes = l.otherTimes.filter((t) => now - t < 1000);
      if (l.otherTimes.length >= (now - l.attachedAt < ATTACH_WINDOW_MS ? ATTACH_PER_SECOND : OTHER_PER_SECOND)) { this.deps.log("mesh_drop_other_rate", { spaceId: l.info.spaceId }); return; }
      l.otherTimes.push(now);
    }
    if (e.event === "cat") return this.onCatalog(e.c, l);
    if (e.event === "fork") return this.onForkReport(e, l);
    if (e.event === "bhead") return this.onBackupHead(e, l);
    if (e.event === "v_chal") return this.onVerifyChallenge(e, l);
    if (e.event === "v_resp") return this.onVerifyResponse(e, l);
    if (e.event === "relay") return this.onRelay(e, l);
    if (e.event === "ack") return this.onAck(e, l);
    if (e.event === "rec") {
      const now = this.now;
      l.recTimes = l.recTimes.filter((t) => now - t < 1000);
      if (l.recTimes.length >= REC_PER_SECOND) { this.deps.log("mesh_drop_rate", { spaceId: l.info.spaceId }); return; }
      l.recTimes.push(now);
      this.handleRecord(e.r, l, false, (e.tag as { from?: unknown } | undefined)?.from);
      return;
    }
    this.deps.onOtherEvent?.(e, l);
  }

  // ───────── 기록 ─────────

  /** 받은 기록 하나를 검증·저장·전달. 결과 코드를 돌려준다. */
  private handleRecord(raw: unknown, from: MeshLink, pulled: boolean, tagIn?: unknown): string {
    raw = this.sanitize(raw);
    if (raw === null) return "bad";
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
    if (res === "fork") {
      // 서명은 진짜라 전달자의 잘못이 아니고, 복원한 정상 서버도 이렇게 보일 수 있다 — 벌점 없이 먼저 받은 것을 유지하고 알린다.
      this.onFork(raw as Signed<RecordBody>, from, tagIn);
      return "fork";
    }
    if (res === "gap") {
      if (!pulled) void this.pull(from, b.origin, b.ch, c!.n);
      return "gap";
    }
    this.appendRecord(b.origin, b.ch, raw as Signed<RecordBody>, from.info.spaceId);
    this.ingest(b);
    this.deps.onRecord?.(b);
    for (const l of this.links) if (l !== from) l.ch.event({ event: "rec", r: raw as object, tag: { from: from.info.spaceId } });
    return "ok";
  }

  private nameOf(id: string): string {
    return this.cats.get(id)?.body.spaceName ?? id.slice(0, 16);
  }

  private firstFork(origin: string, ch: string, n: number): boolean {
    const key = `${origin}/${ch}/${n}`;
    if (this.forksSeen.has(key)) return false;
    const now = this.now;
    const times = (this.forkTimes.get(origin) ?? []).filter((t) => now - t < FORK_ALERT_WINDOW_MS);
    if (times.length >= FORK_ALERTS_PER_WINDOW) { this.forkTimes.set(origin, times); return false; }
    times.push(now);
    this.forkTimes.set(origin, times);
    this.forksSeen.add(key);
    if (this.forksSeen.size > MAX_FORKS_SEEN) this.forksSeen.delete(this.forksSeen.values().next().value as string);
    return true;
  }

  /** 같은 번호의 다른 내용을 내가 직접 발견했다: 알리고, 내게 준 이웃에게 증거와 함께 한 번 전한다. */
  private onFork(other: Signed<RecordBody>, from: MeshLink, tagIn: unknown): void {
    const b = other.body;
    if (!this.firstFork(b.origin, b.ch, b.n)) return;
    const otherVia = typeof tagIn === "string" && SPACE_ID_RE.test(tagIn) ? tagIn : from.info.spaceId;
    const mine = this.recordAt(b.origin, b.ch, b.n) ?? this.recordAt(b.origin, b.ch, b.n - 1);
    const mineVia = mine?.rf ?? "";
    this.deps.log("mesh_fork_detected", { origin: b.origin, originName: this.nameOf(b.origin), ch: b.ch, n: b.n, mineVia: mineVia ? this.nameOf(mineVia) : "", otherVia: this.nameOf(from.info.spaceId) }); // 화면에는 검증된 이웃만(태그는 상대의 주장)
    if (!mine) return;
    for (const l of this.links) {
      if (l.info.spaceId === mine.rf && mine.rf !== this.deps.self().spaceId) { l.ch.event({ event: "fork", a: mine.signed, b: other, tagA: mine.rf, tagB: otherVia }); break; }
    }
  }

  /** 이웃이 보낸 불일치 신호. 같은 사슬의 서로 다른 두 기록이 서명째로 있어야 믿는다(가짜 신호 차단). */
  private onForkReport(e: { [k: string]: unknown }, from: MeshLink): void {
    const a = cleanSigned<RecordBody>(this.sanitize(e.a));
    const b = cleanSigned<RecordBody>(this.sanitize(e.b));
    if (!a || !b) return;
    const ab = openMesh<RecordBody>("rec", a), bb = openMesh<RecordBody>("rec", b);
    if (!ab || !bb || !validRecordBody(ab, this.now) || !validRecordBody(bb, this.now) || ab.origin !== bb.origin || ab.ch !== bb.ch) return;
    const self = this.deps.self();
    const key = ab.origin === self.spaceId ? self.keys.publicKeyB64 : this.pins[ab.origin];
    if (!key || a.signer !== key || b.signer !== key) return;
    const ha = recordHash(ab), hb = recordHash(bb);
    const sameNumber = ab.n === bb.n && ha !== hb;
    const brokenLink = (bb.n === ab.n + 1 && bb.prev !== ha) || (ab.n === bb.n + 1 && ab.prev !== hb);
    if (!sameNumber && !brokenLink) return;
    if (!this.firstFork(ab.origin, ab.ch, Math.min(ab.n, bb.n))) return;
    if (ab.origin === self.spaceId) {
      const c = this.chain(ab.origin, ab.ch);
      const mineA = c?.hashes.get(ab.n), mineB = c?.hashes.get(bb.n);
      const unknown = mineA === undefined && mineB === undefined;
      this.deps.log(unknown ? "mesh_fork_own_unknown" : "mesh_fork_not_signed_by_me", { origin: ab.origin, ch: ab.ch, n: ab.n });
      return;
    }
    this.deps.log("mesh_fork_reported", { origin: ab.origin, originName: this.nameOf(ab.origin), ch: ab.ch, n: ab.n, by: this.nameOf(from.info.spaceId) });
    const up = this.recordAt(ab.origin, ab.ch, ab.n)?.rf;
    if (!up || up === self.spaceId || up === from.info.spaceId) return;
    for (const l of this.links) if (l.info.spaceId === up) { l.ch.event({ event: "fork", a, b, tagA: up, tagB: typeof e.tagB === "string" && SPACE_ID_RE.test(e.tagB) ? e.tagB : from.info.spaceId }); break; }
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
    for (const l of this.links) l.ch.event({ event: "rec", r: signed, tag: { from: self.spaceId } });
  }

  // ───────── 중계 쓰기 ─────────

  /** 처음 보는 것만 true(중복 제거 기억, 상한 SEEN_MAX). */
  private firstSeen(scope: string, key: string): boolean {
    let m = this.seen.get(scope);
    if (!m) this.seen.set(scope, (m = new Map()));
    if (m.has(key)) return false;
    m.set(key, this.now);
    if (m.size > SEEN_PER_ENTRY) m.delete(m.keys().next().value as string);
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
    this.firstSeen(self.spaceId, `relay:${body.reqId}`);
    return new Promise((resolve) => {
      const t = setTimeout(() => { if (this.pendingRelay.delete(body.reqId)) resolve({ ok: false, code: "relay_timeout" }); }, this.deps.relayTimeoutMs ?? 15_000);
      t.unref?.();
      this.pendingRelay.set(body.reqId, (r) => { clearTimeout(t); resolve(r); });
      this.flood({ event: "relay", q, ttl: RELAY_TTL });
    });
  }

  private onRelay(e: { [k: string]: unknown }, from: MeshLink): void {
    const q = this.sanitize(e.q);
    if (q === null) return;
    e = { ...e, q };
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
    if (!this.firstSeen(b.entry, `relay:${b.reqId}`)) return;
    if (b.target !== self.spaceId) {
      const ttl = typeof e.ttl === "number" ? Math.min(e.ttl, RELAY_TTL) - 1 : 0;
      if (ttl > 0) this.flood({ event: "relay", q: e.q, ttl }, from);
      return;
    }
    const ack = (r: { ok: true; seq: number } | { ok: false; code: string }) => {
      const body: AckBody = { reqId: b.reqId, entry: b.entry, target: self.spaceId, ...r };
      this.firstSeen(self.spaceId, `ack:${b.reqId}`);
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
    const a = this.sanitize(e.a);
    if (a === null) return;
    e = { ...e, a };
    const b = openMesh<AckBody>("ack", e.a);
    if (!b || typeof b.reqId !== "string" || typeof b.target !== "string" || typeof b.entry !== "string") return this.strike(from, "ack_bad");
    const key = this.pins[b.target];
    if (!key) { this.deps.log("mesh_drop_ack_unknown_target", { target: b.target }); return; } // 내가 승인하지 않은 서버의 확인 — 전달자 잘못이 아니다
    if ((e.a as Signed).signer !== key) return this.strike(from, "ack_forged");
    if (!this.firstSeen(b.target, `ack:${b.reqId}`)) return;
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
