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

export type DeleteTarget =
  | { kind: "channel"; name: string; serverName: string }
  | { kind: "server"; name: string; channelCount: number }
  | { kind: "account"; name: string; uuid: string; dmCount: number };

const IRREVERSIBLE = "\n\n이 작업은 되돌릴 수 없습니다.";

/** 삭제 확인 대화상자 문구. */
export function deleteConfirmMessage(t: DeleteTarget): string {
  switch (t.kind) {
    case "channel":
      return `채널 '${t.serverName}/${t.name}'을(를) 삭제합니다.${IRREVERSIBLE}`;
    case "server":
      return `서버 '${t.name}'과(와) 그 채널 ${t.channelCount}개를 삭제합니다.${IRREVERSIBLE}`;
    case "account":
      return `계정 '${t.name}' (${t.uuid})을(를) 삭제합니다.\n이 계정의 DM ${t.dmCount}개와 알림도 함께 정리됩니다.${IRREVERSIBLE}`;
  }
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
