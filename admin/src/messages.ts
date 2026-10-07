// 관리 앱 문구표(ko/en): main 프로세스와 렌더러가 함께 쓴다(렌더러가 불러오므로 node 모듈을 쓰지 않는다).
// 판단은 Hub code로만 한다. 문구는 표시용이다.
import { defineCatalog, type Lang } from "./i18n.js";

/** 언어 선택 화면: 언어가 아직 없으므로 두 언어를 함께 쓴다. */
export const PICKER = { title: "언어를 선택하세요 / Choose your language", ko: "한국어", en: "English" } as const;

/** 구버전 Hub(code 없음) 호환 비교용. */
export const LEGACY_UNKNOWN_OP = "알 수 없는 op";

export const ADMIN_MESSAGES = defineCatalog({
  ko: {
    // main 프로세스
    window_title: "Agent-Uplink 관리",
    invalid_target: "잘못된 대상 ID입니다.",
    untrusted_call: "허용되지 않은 호출입니다.",
    bad_viewer_url: "Hub가 잘못된 뷰어 주소를 보냈습니다.",
    lang_invalid: "언어는 ko 또는 en이어야 합니다.",
    lang_old_hub: "이 Hub는 언어 설정을 지원하지 않습니다(구버전). 설정 파일에 저장했지만 Hub가 덮어쓸 수 있습니다. Hub를 재배포하세요.",
    lang_save_failed: (p: { detail: string }) => `언어를 저장하지 못했습니다: ${p.detail}. 다음 실행 때 다시 묻습니다.`,
    // Hub 연결(adminClient)
    hub_down: "Hub가 실행 중이 아닙니다. 세션을 열거나 Hub를 시작하세요.",
    hello_dropped: (p: { port: number }) =>
      `포트 ${p.port}의 프로그램이 Hub 응답 없이 연결을 끊었습니다. Hub가 종료 중이거나 Agent-Uplink Hub가 아닐 수 있습니다. 잠시 후 새로고침하세요.`,
    hello_timeout: (p: { detail: string }) => `${p.detail} 포트를 다른 프로그램이 쓰고 있을 수 있습니다.`,
    hub_cannot_start: (p: { detail: string }) => `Hub를 시작할 수 없습니다: ${p.detail}`,
    not_a_hub: (p: { port: number }) => `포트 ${p.port}의 프로그램은 Agent-Uplink Hub가 아닙니다.`,
    old_protocol_hub: "실행 중인 Hub가 구버전(v2.0.1 이하)입니다. Hub를 종료(재시작)한 뒤 새로고침하세요.",
    version_mismatch: (p: { port: number; hub: unknown; mine: number }) =>
      `포트 ${p.port}의 Agent-Uplink Hub 버전(v${String(p.hub)})이 관리 도구(v${p.mine})와 맞지 않습니다.`,
    op_dropped: "요청 도중 Hub 연결이 끊겼습니다. 작업이 적용됐는지 새로고침으로 확인하세요.",
    op_timeout: (p: { detail: string }) => `${p.detail} 작업이 Hub에서 이미 처리됐을 수 있습니다. 새로고침으로 확인하세요.`,
    old_hub_no_op: "이 Hub에는 이 관리 기능이 없습니다(구버전). Hub를 재배포한 뒤 다시 시도하세요.",
    op_failed: (p: { op: string }) => `${p.op} 실패`,
    not_our_hub: (p: { port: number }) =>
      `포트 ${p.port}의 Hub가 이 Windows 사용자의 Hub가 아닙니다(인증 실패). 다른 사용자가 포트를 점유했거나 UPLINK_DATA_DIR가 Hub와 다를 수 있습니다.`,
    auth_dropped: "인증 중 Hub 연결이 끊기거나 응답이 없습니다(Hub가 종료 중이거나 연결이 너무 많을 수 있습니다). 잠시 후 새로고침하세요.",
    admin_key_unreadable: (p: { file: string }) =>
      `admin.key를 읽을 수 없습니다: ${p.file}. 실행 중인 Hub가 관리 기능이 있는 버전인지, UPLINK_DATA_DIR가 Hub와 같은지 확인하세요.`,
    admin_key_empty: (p: { file: string }) => `admin.key가 비어 있습니다: ${p.file}`,
    connect_timeout: (p: { port: number; ms: number }) => `포트 ${p.port} 연결 시간이 초과됐습니다(${p.ms}ms).`,
    connect_failed: (p: { detail: string }) => `Hub 연결 실패: ${p.detail}`,
    disconnected: "Hub 연결이 끊겼습니다.",
    no_answer: (p: { op: string; ms: number }) => `Hub가 응답하지 않습니다(op=${p.op}, ${p.ms}ms).`,
    client_key_unreadable: (p: { file: string }) =>
      `client.key를 읽을 수 없습니다: ${p.file}. 실행 중인 Hub가 v2.0.2 이상인지, UPLINK_DATA_DIR가 Hub와 같은지 확인하세요.`,
    client_key_malformed: (p: { file: string }) => `client.key 형식이 잘못됐습니다: ${p.file}. Hub를 재시작해 보세요.`,
  },
  en: {
    window_title: "Agent-Uplink Admin",
    invalid_target: "Invalid target ID.",
    untrusted_call: "This call is not allowed.",
    bad_viewer_url: "The hub sent an invalid viewer address.",
    lang_invalid: "The language must be ko or en.",
    lang_old_hub: "This hub does not support the language setting (old version). It was saved to the settings file, but the hub may overwrite it. Redeploy the hub.",
    lang_save_failed: (p: { detail: string }) => `Could not save the language: ${p.detail}. You will be asked again next time.`,
    hub_down: "The hub is not running. Open a session or start the hub.",
    hello_dropped: (p: { port: number }) =>
      `The program on port ${p.port} closed the connection without a hub reply. The hub may be shutting down, or it may not be an Agent-Uplink hub. Refresh in a moment.`,
    hello_timeout: (p: { detail: string }) => `${p.detail} Another program may be using the port.`,
    hub_cannot_start: (p: { detail: string }) => `The hub cannot start: ${p.detail}`,
    not_a_hub: (p: { port: number }) => `The program on port ${p.port} is not an Agent-Uplink hub.`,
    old_protocol_hub: "The running hub is an old version (v2.0.1 or earlier). Stop (restart) the hub, then refresh.",
    version_mismatch: (p: { port: number; hub: unknown; mine: number }) =>
      `The Agent-Uplink hub on port ${p.port} is version v${String(p.hub)}, which does not match the admin app (v${p.mine}).`,
    op_dropped: "The hub connection dropped during the request. Refresh to check whether it was applied.",
    op_timeout: (p: { detail: string }) => `${p.detail} The hub may already have done it. Refresh to check.`,
    old_hub_no_op: "This hub does not have this admin feature (old version). Redeploy the hub, then try again.",
    op_failed: (p: { op: string }) => `${p.op} failed`,
    not_our_hub: (p: { port: number }) =>
      `The hub on port ${p.port} is not this Windows user's hub (authentication failed). Another user may be using the port, or UPLINK_DATA_DIR may differ from the hub's.`,
    auth_dropped: "The hub connection dropped or did not answer during authentication (the hub may be shutting down or have too many connections). Refresh in a moment.",
    admin_key_unreadable: (p: { file: string }) =>
      `Cannot read admin.key: ${p.file}. Check that the running hub is a version with admin features and that UPLINK_DATA_DIR matches the hub's.`,
    admin_key_empty: (p: { file: string }) => `admin.key is empty: ${p.file}`,
    connect_timeout: (p: { port: number; ms: number }) => `Connecting to port ${p.port} timed out (${p.ms}ms).`,
    connect_failed: (p: { detail: string }) => `Could not connect to the hub: ${p.detail}`,
    disconnected: "The hub connection was closed.",
    no_answer: (p: { op: string; ms: number }) => `The hub is not answering (op=${p.op}, ${p.ms}ms).`,
    client_key_unreadable: (p: { file: string }) =>
      `Cannot read client.key: ${p.file}. Check that the running hub is v2.0.2 or later and that UPLINK_DATA_DIR matches the hub's.`,
    client_key_malformed: (p: { file: string }) => `client.key is malformed: ${p.file}. Try restarting the hub.`,
  },
});

export type AdminKey = keyof typeof ADMIN_MESSAGES.ko;

export function adminMsg(lang: Lang, key: AdminKey, params?: object): string {
  const e = ADMIN_MESSAGES[lang][key] as string | ((p: object | undefined) => string);
  return typeof e === "function" ? e(params) : e;
}
