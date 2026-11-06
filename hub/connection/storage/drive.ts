// Google Drive 백업 저장소(v3.0 3b): drive.file 범위(앱이 만든 파일만)로 내 드라이브에 3a와 같은 경로를 폴더로 만든다.
// 근거(공식 문서 2026-11-06): 토큰 갱신 https://oauth2.googleapis.com/token(client_secret 선택), multipart 업로드(5MB 이하),
// 목록 q="'<id>' in parents and trashed = false"(작은따옴표·역슬래시 이스케이프), 받기 files/<id>?alt=media,
// 제한 403(rate limit)/429 → 지수 백오프. 오류에는 code만 담는다(비밀·토큰을 남기지 않음).
import { randomBytes } from "node:crypto";
import { StorageError, type StorageBackend } from "./backend.js";

const DEFAULT_BASE = { token: "https://oauth2.googleapis.com/token", drive: "https://www.googleapis.com/drive/v3", upload: "https://www.googleapis.com/upload/drive/v3" };
const FOLDER = "application/vnd.google-apps.folder";
const TIMEOUT_MS = 30_000;
const RATE_WAIT_MS = 30_000;

/** Drive 검색어 문자열 이스케이프(공식 문서: 작은따옴표·역슬래시 앞에 역슬래시). */
export function qEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

export class DriveBackend implements StorageBackend {
  private readonly base: typeof DEFAULT_BASE;
  private readonly fetchImpl: typeof fetch;
  private access: { token: string; until: number } | null = null;
  private folders = new Map<string, string>(); // 경로 → 폴더 ID
  private writes: Promise<unknown> = Promise.resolve();

  constructor(private readonly o: { clientId: string; clientSecret?: string; refreshToken: string; apiBase?: typeof DEFAULT_BASE; fetchImpl?: typeof fetch }) {
    this.base = o.apiBase ?? DEFAULT_BASE;
    this.fetchImpl = o.fetchImpl ?? fetch;
  }

  private async send(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch {
      throw new StorageError("storage_unreachable");
    }
  }

  private async token(force = false): Promise<string> {
    if (!force && this.access && Date.now() < this.access.until) return this.access.token;
    const form = new URLSearchParams({ client_id: this.o.clientId, grant_type: "refresh_token", refresh_token: this.o.refreshToken });
    if (this.o.clientSecret) form.set("client_secret", this.o.clientSecret);
    const res = await this.send(this.base.token, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form.toString() });
    if (res.status === 400 || res.status === 401) throw new StorageError("storage_auth_failed"); // invalid_grant: 만료·해지(Testing은 7일)
    if (res.status === 429) throw new StorageError("storage_rate_limited", RATE_WAIT_MS);
    if (!res.ok) throw new StorageError("storage_bad_response");
    const j = (await res.json().catch(() => ({}))) as { access_token?: unknown; expires_in?: unknown };
    if (typeof j.access_token !== "string") throw new StorageError("storage_bad_response");
    const life = typeof j.expires_in === "number" ? j.expires_in : 3600;
    this.access = { token: j.access_token, until: Date.now() + Math.max(0, life - 60) * 1000 };
    return this.access.token;
  }

  /** Drive 요청. 401이면 access token을 한 번 갱신해 다시 보낸다. */
  private async req(url: string, init: RequestInit = {}): Promise<Response> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const tok = await this.token(attempt > 0);
      const res = await this.send(url, { ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${tok}` } });
      if (res.status === 401 && attempt === 0) continue;
      if (res.status === 401) throw new StorageError("storage_auth_failed");
      if (res.status === 429 || res.status === 403) {
        let reason = "";
        try {
          const j = (await res.json()) as { error?: { errors?: { reason?: string }[] } };
          reason = j.error?.errors?.map((e) => e.reason ?? "").join(" ") ?? "";
        } catch {
          // 본문 없음
        }
        if (res.status === 429 || /rateLimitExceeded/i.test(reason)) {
          const retry = Number(res.headers.get("retry-after"));
          throw new StorageError("storage_rate_limited", Number.isFinite(retry) && retry > 0 ? retry * 1000 : RATE_WAIT_MS);
        }
        throw new StorageError("storage_forbidden");
      }
      return res;
    }
    throw new StorageError("storage_auth_failed");
  }

  /** 부모 폴더 안에서 이름이 같은 항목(첫 번째). */
  private async find(parent: string, name: string): Promise<{ id: string; folder: boolean } | null> {
    const q = `'${qEscape(parent)}' in parents and trashed = false and name = '${qEscape(name)}'`;
    const res = await this.req(`${this.base.drive}/files?${new URLSearchParams({ q, fields: "files(id,name,mimeType)", pageSize: "10", spaces: "drive" })}`);
    if (!res.ok) throw new StorageError("storage_bad_response");
    const j = (await res.json()) as { files?: { id?: unknown; mimeType?: unknown }[] };
    const f = j.files?.find((x) => typeof x.id === "string");
    return f ? { id: f.id as string, folder: f.mimeType === FOLDER } : null;
  }

  /** "a/b/c" 폴더 ID. create=false면 없을 때 null. */
  private async folderOf(dir: string, create: boolean): Promise<string | null> {
    if (dir === "") return "root";
    const cached = this.folders.get(dir);
    if (cached) return cached;
    const i = dir.lastIndexOf("/");
    const parent = await this.folderOf(i < 0 ? "" : dir.slice(0, i), create);
    if (!parent) return null;
    const name = dir.slice(i + 1);
    const found = await this.find(parent, name);
    let id = found?.folder ? found.id : null;
    if (!id) {
      if (!create) return null;
      const res = await this.req(`${this.base.drive}/files?fields=id`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, mimeType: FOLDER, parents: [parent] }),
      });
      if (!res.ok) throw new StorageError("storage_bad_response");
      const j = (await res.json()) as { id?: unknown };
      if (typeof j.id !== "string") throw new StorageError("storage_bad_response");
      id = j.id;
    }
    this.folders.set(dir, id);
    return id;
  }

  private static split(path: string): [string, string] {
    const i = path.lastIndexOf("/");
    return i < 0 ? ["", path] : [path.slice(0, i), path.slice(i + 1)];
  }

  async check(): Promise<void> {
    await this.token(true);
    await this.find("root", "agent-uplink"); // 목록 권한 확인
  }

  put(path: string, bytes: Buffer): Promise<void> {
    // 폴더 만들기가 겹치지 않게 쓰기는 하나씩.
    const run = async () => {
      const [dir, name] = DriveBackend.split(path);
      const parent = (await this.folderOf(dir, true))!;
      if (await this.find(parent, name)) throw new StorageError("storage_bad_response"); // 덮어쓰지 않음
      const boundary = `uplink${randomBytes(12).toString("hex")}`;
      const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, parents: [parent] })}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`, "utf8"),
        bytes,
        Buffer.from(`\r\n--${boundary}--`, "utf8"),
      ]);
      const res = await this.req(`${this.base.upload}/files?uploadType=multipart&fields=id`, {
        method: "POST", headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body,
      });
      if (!res.ok) throw new StorageError("storage_bad_response");
    };
    const p = this.writes.then(run, run);
    this.writes = p.catch(() => undefined);
    return p;
  }

  async get(path: string): Promise<Buffer | null> {
    const [dir, name] = DriveBackend.split(path);
    const parent = await this.folderOf(dir, false);
    if (!parent) return null;
    const f = await this.find(parent, name);
    if (!f || f.folder) return null;
    const res = await this.req(`${this.base.drive}/files/${encodeURIComponent(f.id)}?alt=media`);
    if (res.status === 404) return null;
    if (!res.ok) throw new StorageError("storage_bad_response");
    return Buffer.from(await res.arrayBuffer());
  }

  async list(dir: string): Promise<string[]> {
    const id = await this.folderOf(dir, false);
    if (!id) return [];
    const names: string[] = [];
    let pageToken = "";
    for (let page = 0; page < 100; page++) {
      const params = new URLSearchParams({ q: `'${qEscape(id)}' in parents and trashed = false`, fields: "nextPageToken,files(name)", pageSize: "1000", spaces: "drive" });
      if (pageToken) params.set("pageToken", pageToken);
      const res = await this.req(`${this.base.drive}/files?${params}`);
      if (!res.ok) throw new StorageError("storage_bad_response");
      const j = (await res.json()) as { files?: { name?: unknown }[]; nextPageToken?: unknown };
      for (const f of j.files ?? []) if (typeof f.name === "string") names.push(f.name);
      if (typeof j.nextPageToken !== "string" || !j.nextPageToken) break;
      pageToken = j.nextPageToken;
    }
    return [...new Set(names)].sort();
  }
}
