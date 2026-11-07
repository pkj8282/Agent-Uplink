// 백업 업로더(v3.0 3단계): Connection Communications 채널 로그에서 아직 안 올린 메시지를 모아
// 암호화·서명 조각(shared/archive.ts)으로 저장소에 올린다. 성공한 뒤에만 상태를 바꾼다(실패하면 다음에 같은 것을 다시).
// 파일(connection/storage/): config.json(종류·저장소·주기), secrets.json(토큰·공간 열쇠 — 비밀 파일), state.json(채널별 마지막 seq·사슬).
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { decodeFragment, encodeFragment, checkChain, MAX_FRAGMENT_PLAINTEXT } from "../../../shared/archive.js";
import { toBase32, type SigningKeys } from "../../../shared/connCrypto.js";
import type { ProfileId } from "../../../shared/cryptoProfile.js";
import type { Message } from "../../../shared/protocol.js";
import { writeFileAtomic, writeSecretFile } from "../../fsutil.js";
import { StorageError, type StorageBackend } from "./backend.js";

export interface StorageConfig {
  kind: "github" | "supabase";
  /** GitHub 저장소(owner/name). */
  repo?: string;
  /** Supabase 프로젝트 주소·버킷. */
  url?: string;
  bucket?: string;
  branch?: string;
  /** 업로드 주기(분, 1~60). */
  intervalMin: number;
  /** 로컬 정리(기본 꺼짐): 검증된 백업 중 days일 지난 통신 메시지를 이 PC에서 지움. */
  prune?: { enabled: boolean; days: number };
}

/** token = 저장소 자격 증명(불투명 문자열): GitHub PAT 또는 Supabase secret key. */
interface Secrets { token?: string; spaceKey?: string }
interface State { lastSeq: Record<string, number>; nextIndex: number; lastHash: string; lastUploadAt: number | null; lastError: string | null; lastPruneAt?: number | null; /** 이 진행 기록이 가리키는 저장소(종류·주소). */ target?: string }

export interface UploaderDeps {
  dir: string;
  spaceId: () => string | null;
  profile: () => ProfileId;
  keys: () => SigningKeys;
  channels: () => { id: string; logFile: string }[];
  makeBackend: (cfg: StorageConfig, token: string) => StorageBackend;
  log: (code: string, detail?: object) => void;
  /** 로컬 정리: 채널 로그에서 keep이 false인 메시지를 지우고 개수를 돌려준다. */
  prune?: (channelId: string, keep: (m: Message) => boolean) => number;
  now?: () => number;
}

export interface VerifyResult { fragments: number; messages: number; breaks: number[]; missing: number[]; bad: { path: string; code: string }[] }

const STOP_WAIT_MS = 5000;
const EPOCH = 1; // 열쇠 세대: 4단계(방식 1)에서 올린다

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/** 복구 키: 공간 열쇠 base32를 4자씩 묶음. */
export function recoveryKeyOf(spaceKey: Buffer): string {
  return toBase32(spaceKey).match(/.{1,4}/g)!.join("-");
}

export class Uploader {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<{ fragments: number; messages: number }> | null = null;
  private retryUntil = 0;

  constructor(private readonly d: UploaderDeps) {}

  private now(): number {
    return (this.d.now ?? Date.now)();
  }

  private file(name: string): string {
    return path.join(this.d.dir, name);
  }

  private config(): StorageConfig | null {
    return readJson<StorageConfig | null>(this.file("config.json"), null);
  }

  private secrets(): Secrets {
    return readJson<Secrets>(this.file("secrets.json"), {});
  }

  private state(): State {
    const s = readJson<Partial<State>>(this.file("state.json"), {});
    return { lastSeq: s.lastSeq ?? {}, nextIndex: s.nextIndex ?? 0, lastHash: s.lastHash ?? "", lastUploadAt: s.lastUploadAt ?? null, lastError: s.lastError ?? null, lastPruneAt: s.lastPruneAt ?? null, ...(s.target !== undefined ? { target: s.target } : {}) };
  }

  private saveState(s: State): void {
    fs.mkdirSync(this.d.dir, { recursive: true });
    writeFileAtomic(this.file("state.json"), JSON.stringify(s, null, 2));
  }

  private saveSecrets(s: Secrets): void {
    fs.mkdirSync(this.d.dir, { recursive: true });
    writeSecretFile(this.file("secrets.json"), JSON.stringify(s));
  }

  private hubId(): string {
    return createHash("sha256").update(this.d.keys().publicKeyB64).digest("hex").slice(0, 16);
  }

  private root(spaceId: string): string {
    return `agent-uplink/${spaceId}/${this.hubId()}`;
  }

  private backend(): StorageBackend {
    const cfg = this.config();
    const token = this.secrets().token;
    if (!cfg || !token) throw new Error("storage_not_configured");
    return this.d.makeBackend(cfg, token);
  }

  /** 연결: 확인(check)이 성공한 뒤에만 저장한다. 공간 열쇠가 없으면 만든다. 복구 키는 이 응답에서만 돌려준다. */
  /** 저장소 식별(진행 기록을 저장소마다 나누는 열쇠). */
  private static targetOf(cfg: StorageConfig): string {
    return cfg.kind === "supabase" ? `supabase:${cfg.url ?? ""}/${cfg.bucket ?? ""}` : `github:${cfg.repo ?? ""}#${cfg.branch ?? ""}`;
  }

  async configure(cfg: StorageConfig, token: string): Promise<{ recoveryKey: string }> {
    await this.d.makeBackend(cfg, token).check();
    const sec = this.secrets();
    const spaceKey = sec.spaceKey ? Buffer.from(sec.spaceKey, "base64") : randomBytes(32);
    this.saveSecrets({ token, spaceKey: spaceKey.toString("base64") });
    // 진행 기록은 저장소마다: 다른 저장소로 바꾸면 새 저장소에 대화 전체를 0번부터 올린다(같은 저장소면 이어 감).
    const target = Uploader.targetOf(cfg);
    const st = this.state();
    const oldCfg = this.config();
    const old = st.target ?? (oldCfg ? Uploader.targetOf(oldCfg) : undefined); // 저장소 정보 없는 예전 기록은 지금 설정으로 판단
    if (old !== undefined && old !== target) {
      this.saveState({ lastSeq: {}, nextIndex: 0, lastHash: "", lastUploadAt: null, lastError: null, lastPruneAt: st.lastPruneAt ?? null, target });
    } else if (st.target !== target) {
      this.saveState({ ...st, target });
    }
    const prev = this.config()?.prune;
    writeFileAtomic(this.file("config.json"), JSON.stringify({ kind: cfg.kind, ...(cfg.repo ? { repo: cfg.repo } : {}), ...(cfg.url ? { url: cfg.url } : {}), ...(cfg.bucket ? { bucket: cfg.bucket } : {}), ...(cfg.branch ? { branch: cfg.branch } : {}), intervalMin: cfg.intervalMin, ...(prev ? { prune: prev } : {}) }, null, 2));
    if (this.timer) this.start(); // 주기 반영
    return { recoveryKey: recoveryKeyOf(spaceKey) };
  }

  /** 해제: 설정·토큰만 지운다. 공간 열쇠·상태는 남겨 다시 연결하면 사슬이 이어진다. */
  clear(): void {
    this.stopTimer();
    fs.rmSync(this.file("config.json"), { force: true });
    const sec = this.secrets();
    if (sec.spaceKey) this.saveSecrets({ spaceKey: sec.spaceKey });
  }

  /** 사슬 끝(정상 종료 보고에 쓴다). */
  chainHead(): { nextIndex: number; lastHash: string } {
    const st = this.state();
    return { nextIndex: st.nextIndex, lastHash: st.lastHash };
  }

  /** 로컬 정리 설정(관리 op). days 7~365. 저장소가 연결돼 있어야 한다. */
  setPrune(p: { enabled: boolean; days: number }): void {
    const cfg = this.config();
    if (!cfg) throw new Error("storage_not_configured");
    if (!Number.isInteger(p.days) || p.days < 7 || p.days > 365) throw new Error("storage_config_invalid");
    writeFileAtomic(this.file("config.json"), JSON.stringify({ ...cfg, prune: { enabled: p.enabled === true, days: p.days } }, null, 2));
  }

  /**
   * 로컬 정리(하루 한 번): 켜져 있고 24시간이 지났으면 저장소를 검증하고, 깨끗할 때만
   * "올렸고(seq ≤ 마지막 올린 seq) days일 지난" 통신 메시지를 지운다. 휴지통을 거치지 않는다.
   */
  async pruneIfDue(): Promise<{ removed: number }> {
    const p = this.config()?.prune;
    const st0 = this.state();
    const now = this.now();
    if (!p?.enabled || !this.d.prune || !this.status().configured) return { removed: 0 };
    if (st0.lastPruneAt && now - st0.lastPruneAt < 86_400_000) return { removed: 0 };
    const v = await this.verify();
    if (v.breaks.length || v.missing.length || v.bad.length) {
      this.d.log("prune_skipped", { breaks: v.breaks.length, missing: v.missing.length, bad: v.bad.length });
      return { removed: 0 };
    }
    const st = this.state();
    const cutoff = now - p.days * 86_400_000;
    let removed = 0;
    for (const c of this.d.channels()) {
      const upTo = st.lastSeq[c.id] ?? 0;
      removed += this.d.prune(c.id, (m) => !(m.ts < cutoff && m.seq <= upTo));
    }
    st.lastPruneAt = now;
    this.saveState(st);
    this.d.log("prune_done", { removed });
    return { removed };
  }

  status(): { configured: boolean; kind?: "github" | "supabase"; repo?: string; url?: string; bucket?: string; intervalMin?: number; lastUploadAt: number | null; lastError: string | null; nextIndex: number; prune?: { enabled: boolean; days: number; lastPruneAt: number | null } } {
    const cfg = this.config();
    const st = this.state();
    const configured = !!cfg && !!this.secrets().token;
    return {
      configured,
      ...(configured && cfg ? { kind: cfg.kind, ...(cfg.repo ? { repo: cfg.repo } : {}), ...(cfg.url ? { url: cfg.url } : {}), ...(cfg.bucket ? { bucket: cfg.bucket } : {}), intervalMin: cfg.intervalMin, prune: { enabled: cfg.prune?.enabled === true, days: cfg.prune?.days ?? 30, lastPruneAt: st.lastPruneAt ?? null } } : {}),
      lastUploadAt: st.lastUploadAt,
      lastError: st.lastError,
      nextIndex: st.nextIndex,
    };
  }

  /** 지금 올리기. 이미 올리는 중이면 그 결과를 기다린다. */
  uploadNow(): Promise<{ fragments: number; messages: number }> {
    this.running ??= this.upload().finally(() => { this.running = null; });
    return this.running;
  }

  private pending(st: State): Message[] {
    const out: Message[] = [];
    for (const c of this.d.channels()) {
      if (!fs.existsSync(c.logFile)) continue;
      const after = st.lastSeq[c.id] ?? 0;
      for (const line of fs.readFileSync(c.logFile, "utf8").split("\n")) {
        if (!line) continue;
        try {
          const m = JSON.parse(line) as Message;
          if (typeof m.seq === "number" && m.seq > after) out.push({ ...m, channelId: c.id });
        } catch {
          // 손상 줄은 건너뜀
        }
      }
    }
    return out;
  }

  private static chunk(msgs: Message[]): Message[][] {
    const out: Message[][] = [];
    let cur: Message[] = [];
    let size = 0;
    for (const m of msgs) {
      const n = Buffer.byteLength(JSON.stringify(m)) + 1;
      if (cur.length > 0 && size + n > MAX_FRAGMENT_PLAINTEXT) {
        out.push(cur);
        cur = [];
        size = 0;
      }
      cur.push(m);
      size += n;
    }
    if (cur.length > 0) out.push(cur);
    return out;
  }

  private static advance(st: State, msgs: Message[], hash: string): void {
    for (const m of msgs) st.lastSeq[m.channelId] = Math.max(st.lastSeq[m.channelId] ?? 0, m.seq);
    st.nextIndex++;
    st.lastHash = hash;
  }

  private async upload(): Promise<{ fragments: number; messages: number }> {
    const spaceId = this.d.spaceId();
    if (!spaceId) throw new Error("server_not_enabled");
    const backend = this.backend();
    if (this.now() < this.retryUntil) throw new StorageError("storage_rate_limited", this.retryUntil - this.now());
    const keys = this.d.keys();
    const spaceKey = Buffer.from(this.secrets().spaceKey!, "base64");
    const st = this.state();
    let fragments = 0;
    let messages = 0;
    try {
      for (let guard = 0; guard < 10_000; guard++) {
        const chunk = Uploader.chunk(this.pending(st))[0];
        if (!chunk) break;
        const createdAt = this.now();
        const index = st.nextIndex;
        const day = new Date(createdAt).toISOString().slice(0, 10);
        const p = `${this.root(spaceId)}/${day}/${String(index).padStart(8, "0")}.frag`;
        const f = encodeFragment({
          header: { spaceId, hubKey: keys.publicKeyB64, profile: this.d.profile(), epoch: EPOCH, index, prevHash: st.lastHash, createdAt },
          body: { messages: chunk },
          spaceKey,
          privateKeyPem: keys.privateKeyPem,
        });
        try {
          await backend.put(p, f.bytes);
          Uploader.advance(st, chunk, f.hash);
          fragments++;
          messages += chunk.length;
        } catch (e) {
          // 올라갔는데 응답만 잃은 경우: 저장소의 그 조각이 내 서명·사슬과 맞으면 이어받는다.
          const adopted = await this.adopt(backend, p, spaceKey, keys.publicKeyB64, st).catch(() => 0);
          if (!adopted) throw e;
          fragments++;
          messages += adopted;
        }
        this.saveState(st);
      }
      st.lastError = null;
      if (fragments > 0) st.lastUploadAt = this.now(); // 실제로 올렸을 때만(빈 주기는 시각을 바꾸지 않음)
      this.saveState(st);
      if (fragments > 0) this.d.log("storage_uploaded", { fragments, messages });
      return { fragments, messages };
    } catch (e) {
      const code = e instanceof StorageError ? e.code : (e as Error).message;
      if (e instanceof StorageError && e.retryAfterMs) this.retryUntil = this.now() + e.retryAfterMs;
      st.lastError = code;
      this.saveState(st);
      this.d.log("storage_upload_failed", { code });
      throw e;
    }
  }

  /** 이어받은 조각의 메시지 수(맞지 않으면 0). */
  private async adopt(backend: StorageBackend, p: string, spaceKey: Buffer, hubKey: string, st: State): Promise<number> {
    const remote = await backend.get(p);
    if (!remote) return 0;
    const d = decodeFragment(remote, { spaceKey, expectHubKey: hubKey });
    if (!d.ok || d.header.index !== st.nextIndex || d.header.prevHash !== st.lastHash || d.body.messages.length === 0) return 0;
    Uploader.advance(st, d.body.messages, d.hash);
    return d.body.messages.length;
  }

  /** 저장소의 이 Hub 조각을 모두 받아 풀고 사슬을 검사한다. missing = 0..마지막 올린 번호 중 읽지 못한 번호. */
  async verify(): Promise<VerifyResult> {
    const spaceId = this.d.spaceId();
    if (!spaceId) throw new Error("server_not_enabled");
    const backend = this.backend();
    const spaceKey = Buffer.from(this.secrets().spaceKey!, "base64");
    const hubKey = this.d.keys().publicKeyB64;
    const root = this.root(spaceId);
    const good: { index: number; prevHash: string; hash: string }[] = [];
    const bad: { path: string; code: string }[] = [];
    let messages = 0;
    for (const day of await backend.list(root)) {
      for (const name of await backend.list(`${root}/${day}`)) {
        const p = `${root}/${day}/${name}`;
        const bytes = await backend.get(p);
        if (!bytes) continue;
        const d = decodeFragment(bytes, { spaceKey, expectHubKey: hubKey });
        if (!d.ok) { bad.push({ path: p, code: d.code }); continue; }
        good.push({ index: d.header.index, prevHash: d.header.prevHash, hash: d.hash });
        messages += d.body.messages.length;
      }
    }
    const have = new Set(good.map((g) => g.index));
    const missing: number[] = [];
    for (let i = 0; i < this.state().nextIndex; i++) if (!have.has(i)) missing.push(i);
    return { fragments: good.length, messages, breaks: checkChain(good).breaks, missing, bad };
  }

  start(): void {
    this.stopTimer();
    const cfg = this.config();
    if (!cfg) return;
    const ms = Math.min(60, Math.max(1, cfg.intervalMin)) * 60_000;
    this.timer = setInterval(() => { void this.uploadNow().then(() => this.pruneIfDue()).catch(() => undefined); }, ms);
    this.timer.unref();
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** 주기를 멈추고, 설정돼 있으면 마지막으로 한 번 올린다(최대 5초 기다림). */
  async stop(): Promise<void> {
    this.stopTimer();
    if (!this.status().configured || !this.d.spaceId()) return;
    await Promise.race([this.uploadNow().catch(() => undefined), new Promise((r) => setTimeout(r, STOP_WAIT_MS).unref())]);
  }
}
