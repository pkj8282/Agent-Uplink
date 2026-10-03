// 렌더러의 순수 로직(DOM 없음 → Node에서 테스트).
import type { ConfigPatch, NameConflict, RestoreReport, SnapshotAccount, SnapshotDm, TrashItem } from "../types.js";
import { oneLine } from "../text.js";

export interface ConfigFormInput {
  maxChannelsPerServer: string;
  inboxMaxBatch: string;
  allowDevDelete: boolean;
}

export type ParseResult = { ok: true; patch: Required<ConfigPatch> } | { ok: false; error: string };

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
  if (max === null) return { ok: false, error: "서버당 최대 채널 수는 1 이상 정수여야 합니다." };
  const batch = posInt(input.inboxMaxBatch);
  if (batch === null) return { ok: false, error: "인박스 최대 배치는 1 이상 정수여야 합니다." };
  return { ok: true, patch: { maxChannelsPerServer: max, inboxMaxBatch: batch, allowDevDelete: input.allowDevDelete } };
}

export interface FormMessage { text: string; kind: "ok" | "err" | "dirty" }

/**
 * 설정 폼의 저장 상태. 저장 안 된 수정이 있으면 "저장됨" 표시를 지우고,
 * 새로고침이 사용자의 수정값을 조용히 덮어쓰지 못하게 한다(allowDevDelete 오인 방지).
 */
export class ConfigFormState {
  private dirty = false;

  edit(): FormMessage {
    this.dirty = true;
    return { text: "저장되지 않은 변경이 있습니다. 저장을 눌러야 반영됩니다.", kind: "dirty" };
  }

  saved(): FormMessage {
    this.dirty = false;
    return { text: "저장했습니다(즉시 반영).", kind: "ok" };
  }

  failed(text: string): FormMessage {
    return { text, kind: "err" };
  }

  /** 새로고침 시 Hub 값으로 폼을 채워도 되는가. */
  acceptsRefresh(): boolean {
    return !this.dirty;
  }
}

export type DeleteTarget =
  | { kind: "channel"; name: string; serverName: string }
  | { kind: "server"; name: string; channelCount: number }
  | { kind: "account"; name: string; uuid: string; dmCount: number };

const IRREVERSIBLE = "\n\n이 작업은 되돌릴 수 없습니다.";
const TO_TRASH = "\n\n휴지통으로 이동합니다. 휴지통 탭에서 복원할 수 있습니다.";

/** 확인창 등 평문 UI에 넣을 이름: 위장 문자(제어·방향·폭 0)를 정리하고 코드포인트 기준으로 자른다. */
export function displayName(s: string, max = 80): string {
  return oneLine(s, max);
}

const KIND_LABEL: Record<TrashItem["kind"], string> = { channel: "채널", server: "서버", account: "계정", orphan: "고아 로그" };

export function trashKindLabel(kind: TrashItem["kind"]): string {
  return KIND_LABEL[kind];
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
  if (!t.intact) f.push("손상됨");
  if (t.dmLeftover) f.push(`DM ${t.dmLeftover}개 남음`);
  return f;
}

export function trashSummary(items: TrashItem[] | undefined): string {
  if (items === undefined) return "이 Hub는 휴지통을 지원하지 않습니다.";
  return `${items.length}개 항목 · ${formatBytes(items.reduce((s, t) => s + t.bytes, 0))}`;
}

export function restoreConfirmMessage(t: TrashItem): string {
  return `${trashKindLabel(t.kind)} '${displayName(trashTitle(t))}'을(를) 복원합니다.\n이름이 겹치면 다음 단계에서 확인합니다.`;
}

/** 이름 충돌 확인 입력 창 문구(서버 충돌이 하나라도 있으면 허브 문구). */
export function conflictConfirmMessage(conflicts: NameConflict[]): string {
  const head = conflicts.some((c) => c.kind === "server")
    ? "이미 똑같은 이름의 허브가 올려져 있어요! 복원할까요?"
    : "이미 똑같은 이름의 채널이 올려져 있어요! 복원할까요?";
  const lines = conflicts.map((c) => `${trashKindLabel(c.kind)}: ${displayName(c.name)} → ${displayName(c.to)}`);
  return `${head}\n\n${lines.join("\n")}`;
}

export function restoreResultMessage(r: RestoreReport): string {
  const parts = ["복원했습니다."];
  for (const x of r.renamed) parts.push(`이름 변경: ${displayName(x.from)} → ${displayName(x.to)}`);
  if (r.recreatedServer) parts.push(`서버 '${displayName(r.recreatedServer.name)}'을(를) 다시 만들었습니다.`);
  if (r.dmsLeft) parts.push(`DM ${r.dmsLeft}개는 상대 계정이 없거나 이미 다른 DM이 있어 휴지통에 남았습니다.`);
  return parts.join(" ");
}

const CODE_TEXT: Record<string, string> = {
  trash_missing: "이미 지워져있는 것 같아요!",
  trash_not_restorable: "고아 로그는 복원할 위치 정보가 없어 복원할 수 없습니다.",
  trash_bad_id: "잘못된 휴지통 항목입니다. 새로고침하세요.",
  channel_limit: "복원하면 서버당 채널 수 한계를 넘습니다. 설정에서 한계를 올리거나 채널을 정리한 뒤 다시 시도하세요.",
  trash_busy: "이 항목은 삭제를 마무리하는 중입니다. 같은 대상을 다시 삭제하거나 Hub를 재시작한 뒤 다시 시도하세요.",
  io_error: "파일을 옮기지 못했습니다. 다른 프로그램이 사용 중일 수 있습니다(백신·백업 도구 등). 잠시 후 다시 시도하세요.",
};

/** Hub 오류 코드 → 관리 앱 문구(영어 UI를 추가할 때 이 표만 바꾼다). 모르는 코드는 원문. */
export function opErrorMessage(code: string | undefined, fallback: string): string {
  return (code && CODE_TEXT[code]) || fallback;
}

export function emptyTrashConfirmMessage(count: number, bytes: number): string {
  return `휴지통의 ${count}개 항목(${formatBytes(bytes)})을 영구 삭제합니다.${IRREVERSIBLE}`;
}

/** 삭제 확인 대화상자 문구. */
export function deleteConfirmMessage(t: DeleteTarget): string {
  switch (t.kind) {
    case "channel":
      return `채널 '${displayName(t.serverName)}/${displayName(t.name)}'을(를) 삭제합니다.${TO_TRASH}`;
    case "server":
      return `서버 '${displayName(t.name)}'과(와) 그 채널 ${t.channelCount}개를 삭제합니다.${TO_TRASH}`;
    case "account":
      return `계정 '${displayName(t.name)}' (${displayName(t.uuid)})을(를) 삭제합니다.\n이 계정의 DM ${t.dmCount}개도 함께 옮겨지며, 알림은 복원되지 않습니다.${TO_TRASH}`;
  }
}

/** 동시에 여러 번 시작된 비동기 요청 중 마지막 것만 반영하기 위한 순번. */
export class LatestOnly {
  private n = 0;
  begin(): number { return ++this.n; }
  isLatest(t: number): boolean { return t === this.n; }
}

/** 그 계정이 멤버인 DM 수. */
export function dmCountOf(uuid: string, dms: SnapshotDm[]): number {
  return dms.filter((d) => d.members.includes(uuid)).length;
}

/** DM 멤버를 "이름 ↔ 이름"으로. 디렉터리에 없는 uuid는 앞 8자로 표시. */
export function memberNames(dm: SnapshotDm, accounts: SnapshotAccount[]): string {
  const byUuid = new Map(accounts.map((a) => [a.uuid, a.name]));
  return dm.members.map((u) => byUuid.get(u) ?? `(알 수 없음 ${u.slice(0, 8)})`).join(" ↔ ");
}

/** 계정 행의 보조 정보. online이 없으면(구버전 Hub) 접속 표시를 생략한다. */
export function accountMeta(online: boolean | undefined, dmCount: number): string {
  return online ? `접속 중 · DM ${dmCount}` : `DM ${dmCount}`;
}
