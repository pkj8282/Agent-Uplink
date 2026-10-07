// Hub 문구표(ko/en). 오류 키는 대부분 응답 code와 같은 이름이다. 판단은 code로만 하고 문구는 표시용이다.
import { defineCatalog, type Lang } from "../shared/i18n.js";

type NameKind = "account" | "server" | "channel";
const KIND_KO: Record<NameKind, string> = { account: "계정", server: "서버", channel: "채널" };
const KIND_EN: Record<NameKind, string> = { account: "Account", server: "Server", channel: "Channel" };

export const HUB_MESSAGES = defineCatalog({
  ko: {
    io_error: (p: { detail: string }) => `처리 중 오류가 났습니다: ${p.detail}`,
    login_required: "먼저 login 하세요(계정 맥락 없음).",
    account_gone: "이 계정은 더 이상 존재하지 않습니다. 다시 login 하세요.",
    admin_auth_failed: "admin 인증 실패",
    hello_pending: "Hub 보안 준비 중입니다. 앞선 hello 응답을 기다리세요.",
    auth_required: "먼저 인증하세요(Hub 프로토콜 v3).",
    auth_hello_first: "먼저 hello를 보내세요.",
    already_authed: "이미 인증된 연결입니다.",
    auth_failed: "인증 실패",
    uuid_required: "login에는 uuid가 필요합니다.",
    uuid_invalid: "uuid에는 영숫자와 '-', '_', '.'만 쓸 수 있습니다(128자 이하).",
    name_invalid: (p: { kind: NameKind; max: number }) => `${KIND_KO[p.kind]} 이름은 1~${p.max}자여야 합니다.`,
    account_in_use: "이미 다른 세션이 사용 중인 계정입니다.",
    viewer_unavailable: (p: { port: number }) => `뷰어가 꺼져 있습니다(포트 ${p.port}를 열지 못함).`,
    peer_required: "peer가 필요합니다.",
    server_name_taken: (p: { name: string; id: string }) => `이미 같은 이름의 서버가 있습니다: ${p.name} (${p.id})`,
    server_not_found: (p: { id: unknown }) => `서버가 없습니다: ${String(p.id)}`,
    channel_name_taken: (p: { name: string; id: string }) => `이 서버에 이미 같은 이름의 채널이 있습니다: ${p.name} (${p.id})`,
    channel_limit: (p: { max: number }) => `채널 수 한계(${p.max})를 초과했습니다.`,
    dev_delete_disabled: "MCP 삭제가 꺼져 있습니다(allowDevDelete=false). 사용자가 관리 앱 설정에서 켤 수 있습니다.",
    channel_not_found: (p: { id: unknown }) => `채널이 없습니다: ${String(p.id)}`,
    text_invalid: "text는 비어있지 않은 문자열이어야 합니다.",
    text_too_long: (p: { max: number }) => `메시지는 ${p.max}자 이하여야 합니다.`,
    channel_forbidden: "이 채널에 접근할 수 없습니다.",
    config_max_invalid: "maxChannelsPerServer는 1 이상 정수여야 합니다.",
    config_batch_invalid: "inboxMaxBatch는 1 이상 정수여야 합니다.",
    config_dev_delete_invalid: "allowDevDelete는 boolean이어야 합니다.",
    config_language_invalid: "language는 ko 또는 en이어야 합니다.",
    account_not_found: (p: { id: unknown }) => `계정이 없습니다: ${String(p.id)}`,
    description_invalid: "description은 500자 이하 문자열이어야 합니다.",
    uuids_invalid: "uuids는 문자열 배열(최대 100개)이어야 합니다.",
    unknown_op: "알 수 없는 op",
    dm_self: "자기 자신과는 DM할 수 없습니다.",
    peer_not_found: (p: { peer: string }) => `그런 계정이 없습니다: ${p.peer}`,
    peer_ambiguous: (p: { count: number; peer: string }) => `이름이 모호합니다(${p.count}명). UUID로 지정하세요: ${p.peer}`,
    http_not_ready: "Hub 준비 중",
    http_too_many_viewers: "뷰어 연결이 너무 많습니다.",
    // 휴지통 복원 실패(code는 trashOps가 정한다)
    trash_bad_id: "잘못된 휴지통 항목 ID입니다.",
    trash_missing: "휴지통 항목 파일이 없습니다(이미 지워진 것 같습니다).",
    trash_missing_or_damaged: "휴지통 항목 파일이 없거나 손상됐습니다(이미 지워진 것 같습니다).",
    trash_finishing: "이 항목은 삭제를 마무리하는 중입니다. 같은 대상을 다시 삭제하거나 Hub를 재시작하세요.",
    trash_not_restorable: "고아 로그는 복원할 위치 정보가 없습니다.",
    trash_channel_exists: "같은 채널이 이미 있습니다.",
    restore_channel_limit: (p: { max: number }) => `복원하면 서버당 채널 수 한계(${p.max})를 넘습니다.`,
    name_conflict: "같은 이름이 이미 있습니다.",
    // 콘솔(stderr)
    log_trash_defer: (p: { id: string; detail: string }) => `휴지통 항목 ${p.id} 복구를 미룹니다: ${p.detail}`,
    log_orphan_defer: (p: { name: string; detail: string }) => `고아 로그 ${p.name} 정리를 미룹니다: ${p.detail}`,
    log_start_failed: (p: { detail: string }) => `Hub 시작 실패: ${p.detail}`,
    log_secure_failed: (p: { detail: string }) => `Hub 보안 준비 실패(종료합니다): ${p.detail}`,
    log_started: (p: { tcp: number; http: number }) => `Agent-Uplink Hub(v2) 시작: tcp=127.0.0.1:${p.tcp} viewer=http://127.0.0.1:${p.http}`,
    log_fatal: (p: { detail: string }) => `치명적 오류: ${p.detail}`,
    startup_denied: (p: { dir: string; code: string }) =>
      [
        `Hub 시작 실패: 데이터 폴더(${p.dir})에 접근할 수 없습니다(${p.code}).`,
        "같은 PC의 다른 Windows 사용자가 먼저 Hub를 실행해 이 폴더가 그 사용자 전용이 됐을 수 있습니다.",
        "Windows 사용자마다 MCP 설정의 env에 UPLINK_DATA_DIR를 서로 다른 폴더로 지정하세요.",
      ].join(" "),
    // 보안 준비 실패(hello의 secure_setup_failed 사유이기도 하다)
    secure_foreign: (p: { dir: string; count: number; example?: { path: string; owner: string | null } }) =>
      [
        `데이터 폴더(${p.dir})에 다른 사용자가 만든 항목이 ${p.count}개 있습니다.${p.example ? ` 예: ${p.example.path} (소유자 ${p.example.owner ?? "확인 불가"})` : ""}`,
        "같은 PC의 다른 Windows 사용자가 먼저 만든 폴더·파일일 수 있어 사용하지 않습니다.",
        "MCP 설정 env의 UPLINK_DATA_DIR를 자기 사용자 폴더(예: %LOCALAPPDATA%/AgentUplink)로 지정하거나, 관리자에게 이 폴더 정리를 요청하세요.",
      ].join(" "),
    secure_acl_failed: (p: { dir: string; detail: string }) =>
      `데이터 폴더(${p.dir}) 권한을 현재 사용자 전용으로 바꾸지 못했습니다(${p.detail}). ` +
      "다른 Windows 사용자가 만든 폴더이거나 권한이 바뀐 폴더일 수 있습니다. " +
      "MCP 설정 env의 UPLINK_DATA_DIR를 자기 사용자 폴더(예: %LOCALAPPDATA%/AgentUplink)로 지정하세요.",
    // 웹 뷰어
    viewer_title: "Agent-Uplink 로그",
    viewer_heading: "Agent-Uplink 로그 (127.0.0.1)",
    viewer_all_channels: "전체 채널",
    viewer_auth_note:
      "이 뷰어는 같은 Windows 사용자만 열 수 있습니다. 관리 앱의 '뷰어 열기' 버튼이나 터미널의 agent-uplink-viewer 명령으로 여세요. Hub가 재시작되면(유휴 종료 등) 다시 열어야 합니다.",
  },
  en: {
    io_error: (p: { detail: string }) => `Error while processing: ${p.detail}`,
    login_required: "Log in first (no account context).",
    account_gone: "This account no longer exists. Log in again.",
    admin_auth_failed: "Admin authentication failed.",
    hello_pending: "The hub is still preparing security. Wait for the earlier hello reply.",
    auth_required: "Authenticate first (hub protocol v3).",
    auth_hello_first: "Send hello first.",
    already_authed: "This connection is already authenticated.",
    auth_failed: "Authentication failed.",
    uuid_required: "login requires a uuid.",
    uuid_invalid: "A uuid may contain only letters, digits, '-', '_' and '.' (up to 128 characters).",
    name_invalid: (p: { kind: NameKind; max: number }) => `${KIND_EN[p.kind]} name must be 1–${p.max} characters.`,
    account_in_use: "Another session is already using this account.",
    viewer_unavailable: (p: { port: number }) => `The viewer is off (could not open port ${p.port}).`,
    peer_required: "peer is required.",
    server_name_taken: (p: { name: string; id: string }) => `A server with the same name already exists: ${p.name} (${p.id})`,
    server_not_found: (p: { id: unknown }) => `No such server: ${String(p.id)}`,
    channel_name_taken: (p: { name: string; id: string }) => `This server already has a channel with the same name: ${p.name} (${p.id})`,
    channel_limit: (p: { max: number }) => `Channel limit (${p.max}) exceeded.`,
    dev_delete_disabled: "Deletion by MCP is off (allowDevDelete=false). The user can turn it on in the admin app settings.",
    channel_not_found: (p: { id: unknown }) => `No such channel: ${String(p.id)}`,
    text_invalid: "text must be a non-empty string.",
    text_too_long: (p: { max: number }) => `Messages must be at most ${p.max} characters.`,
    channel_forbidden: "You cannot access this channel.",
    config_max_invalid: "maxChannelsPerServer must be an integer of 1 or more.",
    config_batch_invalid: "inboxMaxBatch must be an integer of 1 or more.",
    config_dev_delete_invalid: "allowDevDelete must be a boolean.",
    config_language_invalid: "language must be ko or en.",
    account_not_found: (p: { id: unknown }) => `No such account: ${String(p.id)}`,
    description_invalid: "description must be a string of at most 500 characters.",
    uuids_invalid: "uuids must be an array of strings (at most 100).",
    unknown_op: "Unknown op.",
    dm_self: "You cannot DM yourself.",
    peer_not_found: (p: { peer: string }) => `No such account: ${p.peer}`,
    peer_ambiguous: (p: { count: number; peer: string }) => `The name is ambiguous (${p.count} accounts). Specify a UUID: ${p.peer}`,
    http_not_ready: "Hub is starting",
    http_too_many_viewers: "Too many viewer connections.",
    trash_bad_id: "Invalid trash item ID.",
    trash_missing: "The trash item's files are missing (it seems to be deleted already).",
    trash_missing_or_damaged: "The trash item's files are missing or damaged (it seems to be deleted already).",
    trash_finishing: "This item is still being deleted. Delete the same target again or restart the hub.",
    trash_not_restorable: "An orphan log has no location to restore to.",
    trash_channel_exists: "The same channel already exists.",
    restore_channel_limit: (p: { max: number }) => `Restoring would exceed the per-server channel limit (${p.max}).`,
    name_conflict: "The same name already exists.",
    log_trash_defer: (p: { id: string; detail: string }) => `Postponing recovery of trash item ${p.id}: ${p.detail}`,
    log_orphan_defer: (p: { name: string; detail: string }) => `Postponing cleanup of orphan log ${p.name}: ${p.detail}`,
    log_start_failed: (p: { detail: string }) => `Hub failed to start: ${p.detail}`,
    log_secure_failed: (p: { detail: string }) => `Hub security setup failed (exiting): ${p.detail}`,
    log_started: (p: { tcp: number; http: number }) => `Agent-Uplink Hub (v2) started: tcp=127.0.0.1:${p.tcp} viewer=http://127.0.0.1:${p.http}`,
    log_fatal: (p: { detail: string }) => `Fatal error: ${p.detail}`,
    startup_denied: (p: { dir: string; code: string }) =>
      [
        `Hub failed to start: cannot access the data folder (${p.dir}) (${p.code}).`,
        "Another Windows user on this PC may have started the hub first, making this folder private to that user.",
        "Give each Windows user a different folder with UPLINK_DATA_DIR in the MCP env.",
      ].join(" "),
    secure_foreign: (p: { dir: string; count: number; example?: { path: string; owner: string | null } }) =>
      [
        `The data folder (${p.dir}) contains ${p.count} items created by another user.${p.example ? ` Example: ${p.example.path} (owner ${p.example.owner ?? "unknown"})` : ""}`,
        "They may have been created first by another Windows user on this PC, so they are not used.",
        "Set UPLINK_DATA_DIR in the MCP env to your own user folder (e.g. %LOCALAPPDATA%/AgentUplink), or ask an administrator to clean up this folder.",
      ].join(" "),
    secure_acl_failed: (p: { dir: string; detail: string }) =>
      `Could not restrict the data folder (${p.dir}) to the current user (${p.detail}). ` +
      "The folder may have been created by another Windows user, or its permissions were changed. " +
      "Set UPLINK_DATA_DIR in the MCP env to your own user folder (e.g. %LOCALAPPDATA%/AgentUplink).",
    viewer_title: "Agent-Uplink log",
    viewer_heading: "Agent-Uplink log (127.0.0.1)",
    viewer_all_channels: "All channels",
    viewer_auth_note:
      "Only the same Windows user can open this viewer. Open it with the admin app's 'Open viewer' button or the agent-uplink-viewer command in a terminal. If the hub restarts (for example after idle shutdown), open it again.",
  },
});

export type HubKey = keyof typeof HUB_MESSAGES.ko;

/** 현재 언어의 Hub 문구(키별 params는 문구 함수의 인자). */
export function hubMsg(lang: Lang, key: HubKey, params?: object): string {
  const e = HUB_MESSAGES[lang][key] as string | ((p: object | undefined) => string);
  return typeof e === "function" ? e(params) : e;
}
