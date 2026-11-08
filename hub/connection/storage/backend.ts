// 백업 저장소 인터페이스(v3.0 3단계): GitHub(와 이후 저장소)가 같은 모양으로 붙는다. 경로는 "/"로 나눈 상대 경로.
export type StorageErrorCode =
  | "storage_auth_failed"
  | "storage_forbidden"
  | "storage_repo_not_found"
  | "storage_rate_limited"
  | "storage_unreachable"
  | "storage_bad_response";

/** 저장소 오류. message에는 code만 담는다(토큰·응답 본문을 남기지 않음). */
export class StorageError extends Error {
  constructor(readonly code: StorageErrorCode, readonly retryAfterMs?: number) {
    super(code);
    this.name = "StorageError";
  }
}

export interface StorageBackend {
  /** 새 파일로 쓴다. 이미 있으면 덮어쓰지 않고 storage_bad_response. */
  put(path: string, bytes: Buffer): Promise<void>;
  /** 있으면 바꾸고 없으면 새로 쓴다(마지막 번호 파일 전용 — 조각은 put만 쓴다). */
  overwrite(path: string, bytes: Buffer): Promise<void>;
  /** 없으면 null. */
  get(path: string): Promise<Buffer | null>;
  /** 폴더 바로 아래 이름(파일·폴더). 폴더가 없으면 []. */
  list(dir: string): Promise<string[]>;
  /** 연결·권한 확인. */
  check(): Promise<void>;
}

/** 시험용 메모리 저장소. */
export class MemoryBackend implements StorageBackend {
  readonly files = new Map<string, Buffer>();
  failNext: StorageError | null = null;

  private takeFail(): void {
    const f = this.failNext;
    if (f) {
      this.failNext = null;
      throw f;
    }
  }

  async put(path: string, bytes: Buffer): Promise<void> {
    this.takeFail();
    if (this.files.has(path)) throw new StorageError("storage_bad_response");
    this.files.set(path, Buffer.from(bytes));
  }

  async overwrite(path: string, bytes: Buffer): Promise<void> {
    this.takeFail();
    this.files.set(path, Buffer.from(bytes));
  }

  async get(path: string): Promise<Buffer | null> {
    this.takeFail();
    return this.files.get(path) ?? null;
  }

  async list(dir: string): Promise<string[]> {
    this.takeFail();
    const pre = `${dir}/`;
    return [...new Set([...this.files.keys()].filter((k) => k.startsWith(pre)).map((k) => k.slice(pre.length).split("/")[0]))].sort();
  }

  async check(): Promise<void> {
    this.takeFail();
  }
}
