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
  kind: "github";
  repo: string;
  branch?: string;
  /** 업로드 주기(분, 1~60). */
  intervalMin: number;
}

interface Secrets { token?: string; spaceKey?: string }
interface State { lastSeq: Record<string, number>; nextIndex: number; lastHash: string; lastUploadAt: number | null; lastError: string | null }

export interface UploaderDeps {
  dir: string;
  spaceId: () => string | null;
  profile: () => ProfileId;
  keys: () => SigningKeys;
  channels: () => { id: string; logFile: string }[];
  makeBackend: (cfg: StorageConfig, token: string) => StorageBackend;
  log: (code: string, detail?: object) => void;
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
    return { lastSeq: s.lastSeq ?? {}, nextIndex: s.nextIndex ?? 0, lastHash: s.lastHash ?? "", lastUploadAt: s.lastUploadAt ?? null, lastError: s.lastError ?? null };
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
  async configure(cfg: StorageConfig, token: string): Promise<{ recoveryKey: string }> {
    await this.d.makeBackend(cfg, token).check();
    const sec = this.secrets();
    const spaceKey = sec.spaceKey ? Buffer.from(sec.spaceKey, "base64") : randomBytes(32);
    this.saveSecrets({ token, spaceKey: spaceKey.toString("base64") });
    writeFileAtomic(this.file("config.json"), JSON.stringify({ kind: cfg.kind, repo: cfg.repo, ...(cfg.branch ? { branch: cfg.branch } : {}), intervalMin: cfg.intervalMin }, null, 2));
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

  status(): { configured: boolean; kind?: "github"; repo?: string; intervalMin?: number; lastUploadAt: number | null; lastError: string | null; nextIndex: number } {
    const cfg = this.config();
    const st = this.state();
    const configured = !!cfg && !!this.secrets().token;
    return {
      configured,
      ...(configured && cfg ? { kind: cfg.kind, repo: cfg.repo, intervalMin: cfg.intervalMin } : {}),
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
    this.timer = setInterval(() => { void this.uploadNow().catch(() => undefined); }, ms);
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
