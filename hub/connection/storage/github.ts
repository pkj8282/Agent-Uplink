// GitHub 백업 저장소(v3.0 3단계): Contents API로 저장소 하나에 조각 파일을 올린다.
// 근거(공식 문서 2026-11-06): 쓰기·지우기는 동시에 보내면 충돌 → 차례로. 디렉터리 목록 1,000개 상한(날짜 폴더로 피함).
// 제한 응답 403/429: retry-after(초) → x-ratelimit-remaining 0이면 x-ratelimit-reset(epoch 초) → 아니면 최소 1분.
import { StorageError, type StorageBackend } from "./backend.js";

const API = "https://api.github.com";
const TIMEOUT_MS = 30_000;

export function parseRepo(s: string): { owner: string; name: string } | null {
  const m = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/.exec(s);
  if (!m || m[2] === "." || m[2] === "..") return null;
  return { owner: m[1], name: m[2] };
}

export class GitHubBackend implements StorageBackend {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private writes: Promise<unknown> = Promise.resolve();

  constructor(private readonly o: { token: string; repo: string; branch?: string; apiBase?: string; fetchImpl?: typeof fetch }) {
    const r = parseRepo(o.repo);
    if (!r) throw new StorageError("storage_repo_not_found");
    this.base = `${o.apiBase ?? API}/repos/${r.owner}/${r.name}`;
    this.fetchImpl = o.fetchImpl ?? fetch;
  }

  private url(path?: string): string {
    if (path === undefined) return this.base;
    const enc = path.split("/").map(encodeURIComponent).join("/");
    const ref = this.o.branch ? `?ref=${encodeURIComponent(this.o.branch)}` : "";
    return `${this.base}/contents/${enc}${ref}`;
  }

  private async req(method: string, url: string, body?: object, accept = "application/vnd.github+json"): Promise<Response> {
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.o.token}`,
          Accept: accept,
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "agent-uplink",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new StorageError("storage_unreachable");
    }
    if (res.status === 401) throw new StorageError("storage_auth_failed");
    if (res.status === 403 || res.status === 429) {
      const retry = Number(res.headers.get("retry-after"));
      if (Number.isFinite(retry) && retry > 0) throw new StorageError("storage_rate_limited", retry * 1000);
      if (res.headers.get("x-ratelimit-remaining") === "0") {
        const reset = Number(res.headers.get("x-ratelimit-reset"));
        const wait = Number.isFinite(reset) ? Math.max(1000, reset * 1000 - Date.now()) : 60_000;
        throw new StorageError("storage_rate_limited", wait);
      }
      let msg = "";
      try {
        msg = String(((await res.json()) as { message?: unknown }).message ?? "");
      } catch {
        // 본문 없음
      }
      if (res.status === 429 || /rate limit/i.test(msg)) throw new StorageError("storage_rate_limited", 60_000);
      throw new StorageError("storage_forbidden");
    }
    return res;
  }

  async check(): Promise<void> {
    const res = await this.req("GET", this.url());
    if (res.status === 404) throw new StorageError("storage_repo_not_found");
    if (!res.ok) throw new StorageError("storage_bad_response");
  }

  put(path: string, bytes: Buffer): Promise<void> {
    const run = async () => {
      const body: Record<string, string> = { message: "agent-uplink backup", content: bytes.toString("base64") };
      if (this.o.branch) body.branch = this.o.branch;
      const res = await this.req("PUT", this.url(path).split("?")[0], body);
      if (res.status === 404) throw new StorageError("storage_repo_not_found");
      if (res.status !== 201 && res.status !== 200) throw new StorageError("storage_bad_response"); // 422 = 이미 있음(sha 없음) 포함
    };
    const p = this.writes.then(run, run);
    this.writes = p.catch(() => undefined);
    return p;
  }

  async get(path: string): Promise<Buffer | null> {
    const res = await this.req("GET", this.url(path));
    if (res.status === 404) return null;
    if (!res.ok) throw new StorageError("storage_bad_response");
    const j = (await res.json()) as { type?: string; encoding?: string; content?: string };
    if (Array.isArray(j) || j.type !== "file") return null;
    if (j.encoding === "base64" && typeof j.content === "string") return Buffer.from(j.content, "base64");
    // 1MB 넘는 파일은 raw 형식으로만 내용이 온다.
    const raw = await this.req("GET", this.url(path), undefined, "application/vnd.github.raw+json");
    if (!raw.ok) throw new StorageError("storage_bad_response");
    return Buffer.from(await raw.arrayBuffer());
  }

  async list(dir: string): Promise<string[]> {
    const res = await this.req("GET", this.url(dir));
    if (res.status === 404) return [];
    if (!res.ok) throw new StorageError("storage_bad_response");
    const j = (await res.json()) as unknown;
    if (!Array.isArray(j)) return [];
    return j.map((x) => (x as { name?: unknown }).name).filter((n): n is string => typeof n === "string").sort();
  }
}
