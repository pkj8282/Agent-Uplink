// 렌더러의 순수 로직(DOM 없음 → Node에서 테스트).
import type { ConfigPatch, NameConflict, RestoreReport, SecurityFinding, SnapshotAccount, SnapshotDm, TrashItem } from "../types.js";
import { oneLine } from "../text.js";
import type { AdminKey } from "../messages.js";
import { tr } from "./lang.js";

export interface ConfigFormInput {
  maxChannelsPerServer: string;
  inboxMaxBatch: string;
  allowDevDelete: boolean;
}

export type ParseResult = { ok: true; patch: Required<Omit<ConfigPatch, "language">> } | { ok: false; error: string };

/** "1 이상 안전 정수" 문자열만 숫자로. 아니면 null. */
function posInt(raw: string): number | null {
  const s = raw.trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
}

/** 설정 폼 값을 검증해 Hub admin_set_config patch로 바꾼다(Hub도 재검증한다). */
export function parseConfigForm(input: ConfigFormInput): ParseResult {
  const max = posInt(input.maxChannelsPerServer);
  if (max === null) return { ok: false, error: tr("form_max_invalid") };
  const batch = posInt(input.inboxMaxBatch);
  if (batch === null) return { ok: false, error: tr("form_batch_invalid") };
  return { ok: true, patch: { maxChannelsPerServer: max, inboxMaxBatch: batch, allowDevDelete: input.allowDevDelete } };
}

export interface FormMessage { text: string; kind: "ok" | "err" | "dirty" }

/**
 * 설정 폼의 저장 상태. 저장 안 된 수정이 있으면 "저장됨" 표시를 지우고,
 * 새로고침이 사용자의 수정값을 조용히 덮어쓰지 못하게 한다(allowDevDelete 오인 방지).
 */
export class ConfigFormState {
  private dirty = false;
  /** 지금 보이는 상태 문구의 종류(문구는 언어를 바꾸면 다시 만든다). 실패 문구는 그 순간의 내용이라 다시 만들지 않는다. */
  private shown: "dirty" | "saved" | null = null;

  edit(): FormMessage {
    this.dirty = true;
    this.shown = "dirty";
    return this.message()!;
  }

  saved(): FormMessage {
    this.dirty = false;
    this.shown = "saved";
    return this.message()!;
  }

  failed(text: string): FormMessage {
    this.shown = null;
    return { text, kind: "err" };
  }

  /** 현재 언어로 다시 만든 상태 문구. 다시 만들 수 없는 것(실패·없음)은 null. */
  message(): FormMessage | null {
    if (this.shown === "dirty") return { text: tr("form_dirty"), kind: "dirty" };
    if (this.shown === "saved") return { text: tr("form_saved"), kind: "ok" };
    return null;
  }

  /** 새로고침 시 Hub 값으로 폼을 채워도 되는가. */
  acceptsRefresh(): boolean {
    return !this.dirty;
  }
}

export type DeleteTarget =
  | { kind: "channel"; name: string; serverName: string }
  | { kind: "server"; name: string; channelCount: number }
  | { kind: "account"; name: string; uuid: string; dmCount: number }
  | { kind: "dm"; names: string };


/** 확인창 등 평문 UI에 넣을 이름: 위장 문자(제어·방향·폭 0)를 정리하고 코드포인트 기준으로 자른다. */
export function displayName(s: string, max = 80): string {
  return oneLine(s, max);
}

const KIND_KEY: Record<TrashItem["kind"], AdminKey> = { channel: "kind_channel", server: "kind_server", account: "kind_account", orphan: "kind_orphan", dm: "kind_dm" };

export function trashKindLabel(kind: TrashItem["kind"]): string {
  return tr(KIND_KEY[kind]);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** 휴지통 항목 제목: 채널은 '서버/채널'. */
export function trashTitle(t: TrashItem): string {
  return t.kind === "channel" && t.serverName !== undefined ? `${t.serverName}/${t.name}` : t.name;
}

export function trashFlags(t: TrashItem): string[] {
  const f: string[] = [];
  if (!t.intact) f.push(tr("flag_damaged"));
  if (t.dmLeftover) f.push(tr("flag_dm_left", { count: t.dmLeftover }));
  return f;
}

export function trashSummary(items: TrashItem[] | undefined): string {
  if (items === undefined) return tr("trash_unsupported");
  return tr("trash_summary", { count: items.length, size: formatBytes(items.reduce((s, t) => s + t.bytes, 0)) });
}

export function restoreConfirmMessage(t: TrashItem): string {
  return tr("restore_confirm", { kind: trashKindLabel(t.kind), title: displayName(trashTitle(t)) });
}

/** 이름 충돌 확인 입력 창 문구(서버 충돌이 하나라도 있으면 허브 문구). */
export function conflictConfirmMessage(conflicts: NameConflict[]): string {
  const head = conflicts.some((c) => c.kind === "server")
    ? tr("conflict_server")
    : tr("conflict_channel");
  const lines = conflicts.map((c) => `${trashKindLabel(c.kind)}: ${displayName(c.name)} → ${displayName(c.to)}`);
  return `${head}\n\n${lines.join("\n")}`;
}

export function restoreResultMessage(r: RestoreReport): string {
  const parts = [tr("restored")];
  for (const x of r.renamed) parts.push(tr("renamed", { from: displayName(x.from), to: displayName(x.to) }));
  if (r.recreatedServer) parts.push(tr("server_recreated", { name: displayName(r.recreatedServer.name) }));
  if (r.dmsLeft) parts.push(tr("dms_left", { count: r.dmsLeft }));
  return parts.join(" ");
}

// 판단은 code로 한다 — 휴지통 작업 오류는 관리 앱이 더 자세한 문구로 바꾼다.
const CODE_KEY: Record<string, AdminKey> = {
  trash_missing: "op_trash_missing",
  trash_not_restorable: "op_trash_not_restorable",
  trash_bad_id: "op_trash_bad_id",
  channel_limit: "op_channel_limit",
  trash_busy: "op_trash_busy",
  dm_not_found: "op_dm_not_found",
  dm_member_missing: "op_dm_member_missing",
  dm_exists: "op_dm_exists",
  io_error: "op_io_error",
};

/** Hub 오류 코드 → 관리 앱 문구(현재 언어). 모르는 코드는 Hub가 보낸 원문(Hub도 같은 언어 설정을 따른다). */
export function opErrorMessage(code: string | undefined, fallback: string): string {
  const key = code && Object.hasOwn(CODE_KEY, code) ? CODE_KEY[code] : undefined;
  return key ? tr(key) : fallback;
}

export function emptyTrashConfirmMessage(count: number, bytes: number): string {
  return `${tr("empty_trash_confirm", { count, size: formatBytes(bytes) })}${tr("suffix_irreversible")}`;
}

/** 삭제 확인 대화상자 문구. */
export function deleteConfirmMessage(t: DeleteTarget): string {
  switch (t.kind) {
    case "channel":
      return `${tr("delete_channel_confirm", { server: displayName(t.serverName), name: displayName(t.name) })}${tr("suffix_to_trash")}`;
    case "server":
      return `${tr("delete_server_confirm", { name: displayName(t.name), count: t.channelCount })}${tr("suffix_to_trash")}`;
    case "account":
      return `${tr("delete_account_confirm", { name: displayName(t.name), uuid: displayName(t.uuid), count: t.dmCount })}${tr("suffix_to_trash")}`;
    case "dm":
      return `${tr("delete_dm_confirm", { names: displayName(t.names, 170) })}${tr("suffix_to_trash")}`;
  }
}

/** 동시에 여러 번 시작된 비동기 요청 중 마지막 것만 반영하기 위한 순번. */
export class LatestOnly {
  private n = 0;
  begin(): number { return ++this.n; }
  isLatest(t: number): boolean { return t === this.n; }
}

/** 마지막으로 본 시각 이후의 보안 기록 수(탭 알림). */
export function unseenCount(findings: SecurityFinding[] | undefined, lastSeen: number): number {
  return (findings ?? []).filter((f) => f.ts > lastSeen).length;
}

const FINDING_KEY: Record<string, AdminKey> = {
  control: "fk_control", separator: "fk_separator", bidi: "fk_bidi", zero_width: "fk_zero_width", tag: "fk_tag",
  variation_selector: "fk_variation_selector", filler: "fk_filler", format: "fk_format", ignorable: "fk_ignorable",
  surrogate: "fk_surrogate", emoji_smuggling: "fk_emoji_smuggling",
};

/** 종류별 개수: "태그 문자(숨은 ASCII) 28 · 폭 0 문자 1". 모르는 종류(새 Hub)는 기타. */
export function findingCounts(counts: Record<string, number>): string {
  return Object.entries(counts)
    .map(([k, n]) => `${tr(Object.hasOwn(FINDING_KEY, k) ? FINDING_KEY[k] : "fk_other")} ${n}`)
    .join(" · ");
}

/** 출처: 요청이면 op·항목·계정 이름, 디스크면 파일 종류·항목. 이름은 위장 문자를 정리한다. */
export function findingSource(f: SecurityFinding, accounts: SnapshotAccount[]): string {
  const parts = [tr(f.source === "request" ? "src_request" : "src_disk"), displayName(f.where, 40), displayName(f.field, 40)];
  if (f.source === "request" && f.account !== undefined) {
    const name = accounts.find((a) => a.uuid === f.account)?.name;
    parts.push(name !== undefined ? displayName(name) : tr("unknown_member", { id: displayName(f.account, 8) }));
  }
  return parts.join(" · ");
}

/** 그 계정이 멤버인 DM 수. */
export function dmCountOf(uuid: string, dms: SnapshotDm[]): number {
  return dms.filter((d) => d.members.includes(uuid)).length;
}

/** DM 멤버를 "이름 ↔ 이름"으로. 디렉터리에 없는 uuid는 앞 8자로 표시. */
export function memberNames(dm: SnapshotDm, accounts: SnapshotAccount[]): string {
  const byUuid = new Map(accounts.map((a) => [a.uuid, a.name]));
  return dm.members.map((u) => byUuid.get(u) ?? tr("unknown_member", { id: u.slice(0, 8) })).join(" ↔ ");
}

/** 계정 행의 보조 정보. online이 없으면(구버전 Hub) 접속 표시를 생략한다. */
export function accountMeta(online: boolean | undefined, dmCount: number): string {
  return online ? tr("meta_online", { count: dmCount }) : tr("meta_dms", { count: dmCount });
}
