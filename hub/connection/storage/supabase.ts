// Supabase Storage 백업 저장소(v3.0 3b, 사용자 결정 2026-11-07 — Google Drive 대신).
// 근거(공식 문서 2026-11-07): 기본 주소 https://<ref>.supabase.co/storage/v1, 업로드 POST /object/<bucket>/<path>(x-upsert:false,
// 이미 있으면 400 "Asset Already Exists"), 받기 GET /object/<bucket>/<path>, 목록 POST /object/list/<bucket> {prefix,limit,offset,sortBy},
// 새 secret key(sb_secret_…)는 apikey 헤더로(Bearer 아님 권장), secret key는 RLS 우회. 무료 프로젝트는 1주일 활동이 없으면 일시정지.
// 오류에는 code만 담는다(키를 남기지 않음).
import { StorageError, type StorageBackend } from "./backend.js";

const TIMEOUT_MS = 30_000;
const PAGE = 1000;

/** https://<프로젝트 ref>.supabase.co 만 받는다(끝의 / 와 앞뒤 공백은 정리). 아니면 null. */
export function parseSupabaseUrl(raw: string): string | null {
  const s = raw.trim().replace(/\/+$/, "");
  return /^https:\/\/[a-z0-9]{1,63}\.supabase\.co$/.test(s) ? s : null;
}

export class SupabaseBackend implements StorageBackend {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private bucketReady = false;
  private writes: Promise<unknown> = Promise.resolve();

  constructor(private readonly o: { url: string; key: string; bucket: string; fetchImpl?: typeof fetch; /** 시험 전용: http 가짜 서버 허용 */ allowInsecureForTest?: boolean }) {
    const url = o.allowInsecureForTest ? o.url.replace(/\/+$/, "") : parseSupabaseUrl(o.url);
    if (!url) throw new StorageError("storage_repo_not_found");
    this.base = `${url}/storage/v1`;
    this.fetchImpl = o.fetchImpl ?? fetch;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    // 새 secret key는 apikey만. 예전 service_role 키(JWT)는 Authorization도 필요하다.
    const h: Record<string, string> = { apikey: this.o.key, ...extra };
    if (this.o.key.startsWith("eyJ")) h.Authorization = `Bearer ${this.o.key}`;
    return h;
  }

  private async req(method: string, path: string, init: { body?: BodyInit; headers?: Record<string, string> } = {}): Promise<Response> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}${path}`, { method, headers: this.headers(init.headers), ...(init.body !== undefined ? { body: init.body } : {}), signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch {
      throw new StorageError("storage_unreachable");
    }
    if (res.status === 401) throw new StorageError("storage_auth_failed");
    if (res.status === 403) throw new StorageError("storage_forbidden");
    if (res.status === 429) {
      const retry = Number(res.headers.get("retry-after"));
      throw new StorageError("storage_rate_limited", Number.isFinite(retry) && retry > 0 ? retry * 1000 : 30_000);
    }
    if (res.status >= 500) throw new StorageError("storage_unreachable"); // 일시정지(540 등)·서버 오류
    return res;
  }

  /** 400 응답 본문이 '없음'을 뜻하는가(Storage는 없는 대상에도 400을 준다). */
  private static async isNotFound(res: Response): Promise<boolean> {
    if (res.status === 404) return true;
    if (res.status !== 400) return false;
    const t = await res.text().catch(() => "");
    return /not.?found|"404"/i.test(t);
  }

  private static async isDuplicate(res: Response): Promise<boolean> {
    if (res.status === 409) return true;
    if (res.status !== 400) return false;
    const t = await res.text().catch(() => "");
    return /already exists|duplicate|"409"/i.test(t);
  }

  private enc(path: string): string {
    return path.split("/").map(encodeURIComponent).join("/");
  }

  /** 버킷 확인 → 없으면 비공개로 만든다. */
  async check(): Promise<void> {
    const b = encodeURIComponent(this.o.bucket);
    const got = await this.req("GET", `/bucket/${b}`);
    if (got.ok) {
      this.bucketReady = true;
      return;
    }
    if (!(await SupabaseBackend.isNotFound(got))) throw new StorageError("storage_bad_response");
    const made = await this.req("POST", "/bucket", { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: this.o.bucket, name: this.o.bucket, public: false }) });
    if (!made.ok && !(await SupabaseBackend.isDuplicate(made))) throw new StorageError("storage_bad_response");
    this.bucketReady = true;
  }

  put(path: string, bytes: Buffer): Promise<void> {
    const run = async () => {
      if (!this.bucketReady) await this.check();
      const res = await this.req("POST", `/object/${encodeURIComponent(this.o.bucket)}/${this.enc(path)}`, {
        headers: { "Content-Type": "application/octet-stream", "x-upsert": "false", "cache-control": "max-age=0" },
        body: new Uint8Array(bytes),
      });
      if (!res.ok) throw new StorageError("storage_bad_response"); // 이미 있음(덮어쓰지 않음) 포함
    };
    const p = this.writes.then(run, run);
    this.writes = p.catch(() => undefined);
    return p;
  }

  async get(path: string): Promise<Buffer | null> {
    const res = await this.req("GET", `/object/${encodeURIComponent(this.o.bucket)}/${this.enc(path)}`);
    if (await SupabaseBackend.isNotFound(res)) return null;
    if (!res.ok) throw new StorageError("storage_bad_response");
    return Buffer.from(await res.arrayBuffer());
  }

  async list(dir: string): Promise<string[]> {
    const names: string[] = [];
    for (let offset = 0; offset < 1_000_000; offset += PAGE) {
      const res = await this.req("POST", `/object/list/${encodeURIComponent(this.o.bucket)}`, {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prefix: dir, limit: PAGE, offset, sortBy: { column: "name", order: "asc" } }),
      });
      if (await SupabaseBackend.isNotFound(res)) return [];
      if (!res.ok) throw new StorageError("storage_bad_response");
      const rows = (await res.json().catch(() => null)) as { name?: unknown }[] | null;
      if (!Array.isArray(rows)) throw new StorageError("storage_bad_response");
      for (const r of rows) if (typeof r?.name === "string" && r.name !== ".emptyFolderPlaceholder") names.push(r.name);
      if (rows.length < PAGE) break;
    }
    return [...new Set(names)].sort();
  }
}
