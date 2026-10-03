// 렌더러의 순수 로직(DOM 없음 → Node에서 테스트).
import type { ConfigPatch, SnapshotAccount, SnapshotDm } from "../types.js";

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

// C0/C1 제어문자(개행 포함), 줄·문단 구분자, bidi 방향 제어
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

/** 확인창 등 평문 UI에 넣을 이름: 에이전트가 정한 이름이 문구를 위장하지 못하게 정리하고 길이를 자른다. */
export function displayName(s: string, max = 80): string {
  const flat = s.replace(UNSAFE_CHARS, " ");
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** 삭제 확인 대화상자 문구. */
export function deleteConfirmMessage(t: DeleteTarget): string {
  switch (t.kind) {
    case "channel":
      return `채널 '${displayName(t.serverName)}/${displayName(t.name)}'을(를) 삭제합니다.${IRREVERSIBLE}`;
    case "server":
      return `서버 '${displayName(t.name)}'과(와) 그 채널 ${t.channelCount}개를 삭제합니다.${IRREVERSIBLE}`;
    case "account":
      return `계정 '${displayName(t.name)}' (${displayName(t.uuid)})을(를) 삭제합니다.\n이 계정의 DM ${t.dmCount}개와 알림도 함께 정리됩니다.${IRREVERSIBLE}`;
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
