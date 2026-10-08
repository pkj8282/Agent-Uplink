import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "./fsutil.js";
import { Guard, plainGuard } from "./securityLog.js";
import { AccountInfo } from "../shared/protocol.js";

export interface Account {
  uuid: string;
  name: string;
  createdAt: number;
  dm: Record<string, string>;
  inboxCursor: number;
  description?: string;
}

export class AccountStore {
  private readonly dir: string;
  private accounts = new Map<string, Account>();

  constructor(opts: { dir: string; guard?: Guard }) {
    const guard = opts.guard ?? plainGuard;
    this.dir = path.join(opts.dir, "accounts");
    fs.mkdirSync(this.dir, { recursive: true });
    for (const f of fs.readdirSync(this.dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const a = JSON.parse(fs.readFileSync(path.join(this.dir, f), "utf8")) as Account;
        a.dm ??= {};
        a.inboxCursor ??= 0;
        // 디스크 입구(v2.1.2): 이전 버전·손으로 고친 파일의 위장 문자를 메모리에 들이지 않는다(다음 저장 때 이스케이프된 값으로 기록됨).
        const at = { source: "disk" as const, where: "accounts", account: String(a.uuid) };
        if (typeof a.name === "string") a.name = guard(a.name, { ...at, field: "name" });
        if (typeof a.description === "string") a.description = guard(a.description, { ...at, field: "description" });
        this.accounts.set(a.uuid, a);
      } catch {
        // 손상 파일 무시
      }
    }
  }

  private save(a: Account): void {
    try {
      // 수신 경로(커서 갱신)에서 자주 재작성되므로, 크래시 시 계정 파일이 손상돼
      // 신원·DM역색인·커서가 통째로 소실되지 않도록 원자적으로 교체한다.
      writeFileAtomic(path.join(this.dir, `${a.uuid}.json`), JSON.stringify(a, null, 2));
    } catch {
      // 쓰기 실패해도 메모리 유지
    }
  }

  getOrCreate(uuid: string, name?: string): Account {
    const found = this.accounts.get(uuid);
    if (found) return found;
    const a: Account = { uuid, name: name ?? uuid.slice(0, 8), createdAt: Date.now(), dm: {}, inboxCursor: 0 };
    this.accounts.set(uuid, a);
    this.save(a);
    return a;
  }

  /** 복원: 계정이 없으면 원래 정보로 만든다(true). 이미 있으면 현재 정보를 유지(false). */
  restore(rec: { uuid: string; name: string; createdAt: number; description?: string }): boolean {
    if (this.accounts.has(rec.uuid)) return false;
    const a: Account = { uuid: rec.uuid, name: rec.name, createdAt: rec.createdAt, dm: {}, inboxCursor: 0 };
    if (rec.description) a.description = rec.description;
    this.accounts.set(a.uuid, a);
    this.save(a);
    return true;
  }

  get(uuid: string): Account | undefined {
    return this.accounts.get(uuid);
  }

  setName(uuid: string, name: string): string {
    const a = this.getOrCreate(uuid);
    a.name = name;
    this.save(a);
    return a.name;
  }

  list(): AccountInfo[] {
    return [...this.accounts.values()].map((a) => ({ uuid: a.uuid, name: a.name, description: a.description ?? "" }));
  }

  setDescription(uuid: string, description: string): string {
    const a = this.getOrCreate(uuid);
    a.description = description;
    this.save(a);
    return description;
  }

  allUuids(): string[] {
    return [...this.accounts.keys()];
  }

  setInboxCursor(uuid: string, cursor: number): void {
    const a = this.getOrCreate(uuid);
    a.inboxCursor = cursor;
    this.save(a);
  }

  setDm(uuid: string, peerUuid: string, channelId: string): void {
    const a = this.getOrCreate(uuid);
    a.dm[peerUuid] = channelId;
    this.save(a);
  }

  remove(uuid: string): boolean {
    const existed = this.accounts.delete(uuid);
    if (existed) {
      try {
        fs.rmSync(path.join(this.dir, `${uuid}.json`), { force: true });
      } catch {
        // 파일 삭제 실패해도 메모리에서는 제거됨
      }
    }
    return existed;
  }

  removeDm(uuid: string, peerUuid: string): void {
    const a = this.accounts.get(uuid);
    if (!a) return;
    delete a.dm[peerUuid];
    this.save(a);
  }
}
