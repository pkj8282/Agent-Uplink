// 메인·프리로드·렌더러가 공유하는 타입(값 없음 → 렌더러에서 import type 가능).
import type { Lang, LangSetting } from "./i18n.js";

export interface AdminConfig {
  maxChannelsPerServer: number;
  allowDevDelete: boolean;
  inboxMaxBatch: number;
  /** 구버전 Hub는 없음. */
  language?: LangSetting;
}

export type ConfigPatch = Partial<Omit<AdminConfig, "language">> & { language?: Lang };

export interface SnapshotServer { id: string; name: string; channels: { id: string; name: string }[]; }
export interface SnapshotAccount { uuid: string; name: string; description?: string; online?: boolean; /** 연결 계정(v3.1 Hub). 없으면 로컬. */ area?: "connection"; }
export interface SnapshotDm { channelId: string; members: string[]; label: string; }

export interface TrashItem {
  id: string;
  kind: "channel" | "server" | "account" | "orphan" | "dm";
  name: string;
  serverName?: string;
  deletedAt: number;
  deletedBy: "admin" | "mcp" | "recovery";
  bytes: number;
  fileCount: number;
  intact: boolean;
  restorable: boolean;
  dmLeftover?: number;
  /** 삭제·복원이 아직 끝나지 않은 항목(Hub v2.1.3+). 비우기는 이것을 지우지 않는다. */
  pending?: true;
  /** 통신 서버·채널에서 지운 항목(v3.0). */
  area?: "connection";
}

export interface NameConflict { kind: "server" | "channel"; name: string; to: string; }

/** 통신 상태(v3.0, admin_conn_status). */
export type ConnProfile = "tls13-aes256gcm" | "tls13-chacha20";
export interface ConnStatus {
  server: { enabled: boolean; port: number; profile: ConnProfile; spaceName: string; burnOnJoin: boolean; shared: string[]; listening: boolean } | null;
  members: { memberId: string; userName: string; joinedAt: number; revoked: boolean; online: boolean }[];
  joined: { spaceId: string; spaceName: string; hostUser: string; connected: boolean; /** 그 서버가 공유한 서버·채널(v3.1 Hub, 원격 id). */ servers?: { serverId: string; name: string; channels: { channelId: string; name: string }[] }[] }[];
  userName: string | null;
  /** 이 Hub의 통신 서버·채널(Connection Communications). 1단계 Hub는 없음 → []. */
  comms: ConnCommsServer[];
  /** 최근 통신 사건(오래된 것 → 최근, 최대 50). 1단계 Hub는 없음 → []. */
  events: ConnEvent[];
  /** 저장소(백업) 상태. 3a 이전 Hub는 없음 → null. */
  storage: StorageStatus | null;
  /** 방식 1 공간(v3.0 4단계). 이전 Hub는 없음 → []. */
  spaces1: Space1Status[];
  /** 방식 3 망(v3.0 5단계). 통신 서버가 없거나 이전 Hub → null. */
  mesh: MeshStatus | null;
  /** 다른 PC의 연결 계정(방식 2, v3.1 Hub). 이전 Hub는 없음. */
  remoteAccounts?: RemoteAccount[];
}
export interface RemoteAccount { uuid: string; name: string; description?: string; online: boolean; remote: { spaceName: string; hubUser: string } }
export interface Space1Status {
  spaceId: string; spaceName: string; role: "owner" | "member"; state: "pending" | "active" | "revoked"; repo: string; epoch: number;
  members: { hubId: string; userName: string; revoked: boolean; me: boolean }[]; lastSyncAt: number | null; lastError: string | null;
  /** 공간 채널(v3.1 Hub). 구성원은 거울 채널 id. 이전 Hub는 없음. */
  channels?: { channelId: string; name: string }[];
  /** 관리자 쪽: 공간으로 공유한 로컬 서버 id(v3.1 Hub). */
  localServerId?: string;
}
export type RestoreInput = ({ kind: "github"; repo: string; ghToken: string } | { kind: "supabase"; url: string; key: string; bucket: string }) & { recoveryKey: string; serverName: string };
export interface BackupCandidate { spaceId: string; hubId: string; fragments: number; firstDay: string; lastDay: string; }
export interface RestoreResult { serverId: string; channelCount: number; messageCount: number; breaks: number[]; bad: { path: string; code: string }[]; head?: "ok" | "behind" | "missing"; }
export interface MeshCaseChoice { case: "distributed" | "main" | "single"; main?: string; standby: string[]; }
export type MeshCommand =
  | { type: "case"; choice: MeshCaseChoice }
  | { type: "cut"; target: string }
  | { type: "unshare"; target: string; ch: string }
  | { type: "noWrite"; entry: string; hubUser?: string };
export interface MeshStatus {
  self: string;
  shared: string[];
  excluded: string[];
  links: { spaceId: string; spaceName: string; dir: "in" | "out"; fingerprint: string; connected: boolean }[];
  servers: { spaceId: string; spaceName: string; channelCount: number; direct: boolean }[];
  /** 망 서버별 채널(이름 표시·공유 중단 명령 대상 고르기). */
  channels?: { spaceId: string; channels: { id: string; name: string }[] }[];
  /** 다른 서버가 알려 줬지만 아직 인정하지 않은 서버. */
  candidates?: { origin: string; spaceName: string; viaName: string; fingerprint: string; warning: boolean; at: number }[];
  verify?: { managed: { cid: string; label: string; createdAt: number; boundName: string | null }[]; held: { cid: string; issuerName: string; addedAt: number }[] };
  gov: {
    choice: MeshCaseChoice; effective: MeshCaseChoice; coordinator: boolean; accepted: string | null; coordinators: string[];
    blocked: string[]; unshared: { origin: string; ch: string }[]; noWrite: { entry: string; hubUser?: string }[]; upload: { own: boolean; mirrors: number };
  } | null;
}
export interface Space1CreateInput { spaceName: string; localServerId: string; repo: string; ghToken: string; intervalSec: number; }
export interface Space1JoinInput { code: string; ghToken: string; }
export interface StorageStatus { configured: boolean; kind?: "github" | "supabase"; repo?: string; url?: string; bucket?: string; intervalMin?: number; lastUploadAt: number | null; lastError: string | null; nextIndex: number; prune?: { enabled: boolean; days: number; lastPruneAt: number | null }; }
export interface StorageInput { repo: string; token: string; intervalMin: number; }
export interface SupabaseInput { url: string; key: string; bucket: string; intervalMin: number; }
export interface VerifyResult { fragments: number; messages: number; breaks: number[]; missing: number[]; bad: { path: string; code: string }[]; }
export interface ConnCommsServer { serverId: string; name: string; channels: { channelId: string; name: string }[]; }
export interface ConnEvent { ts: number; code: string; detail: Record<string, unknown>; }
export interface ConnServerInput { port: number; profile: ConnProfile; spaceName: string; burnOnJoin: boolean; }
export interface ConnInviteInput { label: string; host: string; expiresInMs: number; }

export interface RestoreReport {
  renamed: { kind: "server" | "channel"; from: string; to: string }[];
  recreatedServer?: { id: string; name: string };
  dmsRestored: number;
  dmsLeft: number;
  itemRemoved: boolean;
}

/** 유니코드 스테가노그래피 감독 기록(Hub v2.1.2+). preview는 Hub가 이스케이프한 앞 80자. */
export interface SecurityFinding {
  ts: number;
  source: "request" | "disk";
  where: string;
  field: string;
  account?: string;
  counts: Record<string, number>;
  preview: string;
}

export interface Snapshot {
  config: AdminConfig;
  servers: SnapshotServer[];
  accounts: SnapshotAccount[];
  dms: SnapshotDm[];
  /** undefined = 휴지통을 지원하지 않는 구버전 Hub. */
  trash?: TrashItem[];
  /** undefined = 보안 기록을 지원하지 않는 구버전 Hub. */
  findings?: SecurityFinding[];
  /** 이번 실행 동안 저장을 멈춘 색인 파일(데이터 폴더 기준). undefined = 구버전 Hub. */
  saveBlocked?: string[];
  /** 서버 참가자 종합 리스트(v3.1.1 Hub): 서버 관점 현재 참가자. 옛 Hub는 없음. */
  memberships?: Record<string, string[]>;
  /** 서버 관점 참가 전적(한 번이라도 참가한 계정). */
  membershipHistory?: Record<string, string[]>;
  /** 참가자 관점(계정 → 서버). 계정 줄 표시에 쓴다 — 두 관점이 어긋나면 드러나게. */
  membershipAccounts?: Record<string, string[]>;
}

/** IPC 결과 봉투. hubDown은 Hub 미실행(접속 거부)일 때만 true. code는 Hub 오류 코드(관리 앱이 문구로 변환). */
export type IpcResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; hubDown: boolean; code?: string; conflicts?: NameConflict[] };

/** preload가 window.admin으로 노출하는 API. */
export interface AdminApi {
  snapshot(): Promise<IpcResult<Snapshot>>;
  setConfig(patch: ConfigPatch): Promise<IpcResult<AdminConfig>>;
  deleteChannel(channelId: string): Promise<IpcResult<void>>;
  deleteServer(serverId: string): Promise<IpcResult<void>>;
  deleteAccount(uuid: string): Promise<IpcResult<void>>;
  deleteDm(channelId: string): Promise<IpcResult<void>>;
  restoreTrash(id: string, confirmRename: boolean): Promise<IpcResult<RestoreReport>>;
  emptyTrash(): Promise<IpcResult<{ removed: number }>>;
  openViewer(): Promise<IpcResult<void>>;
  /** Hub 수동 시작(v3.1). started: false = 이미 떠 있음. 실패 code: no_launch_info | launch_untrusted. */
  startHub(): Promise<IpcResult<{ started: boolean }>>;
  /** 서버 참가자 종합 리스트 동기화(v3.1.1, 앱 설정 버튼). */
  syncMemberships(): Promise<IpcResult<MembershipSyncResult>>;
  /** Hub 꺼짐 화면: 수동 시작을 할 수 있는가(code: null = 가능, 아니면 no_launch_info | launch_untrusted). 실행하지 않음. */
  /** 이 관리 앱이 붙는 Hub 포트(맨 위 줄 표시, v3.1). Hub가 꺼져 있어도 답한다. */
  hubInfo(): Promise<IpcResult<{ port: number }>>;
  launchAvailable(): Promise<IpcResult<{ code: null | "no_launch_info" | "launch_untrusted" }>>;
  /** 데이터 폴더 config.json의 언어(Hub가 꺼져 있어도 읽는다). */
  getLanguage(): Promise<IpcResult<LangSetting>>;
  /** 언어 저장: Hub가 켜져 있으면 Hub로, 꺼져 있으면 파일에 직접. */
  setLanguage(lang: Lang): Promise<IpcResult<{ via: "hub" | "file" }>>;
  // 통신(v3.0)
  connStatus(): Promise<IpcResult<ConnStatus>>;
  connSetUser(name: string): Promise<IpcResult<string>>;
  connEnableServer(o: ConnServerInput): Promise<IpcResult<number>>;
  connDisableServer(): Promise<IpcResult<void>>;
  connCreateServer(name: string): Promise<IpcResult<string>>;
  connCreateChannel(serverId: string, name: string): Promise<IpcResult<string>>;
  connSetShared(serverIds: string[]): Promise<IpcResult<void>>;
  connCreateInvite(o: ConnInviteInput): Promise<IpcResult<{ code: string; ipWarning: boolean }>>;
  connJoin(code: string): Promise<IpcResult<string>>;
  connRevoke(memberId: string): Promise<IpcResult<void>>;
  // 저장소(백업, v3.0 3a)
  connStorageSet(o: StorageInput): Promise<IpcResult<{ recoveryKey: string }>>;
  connStorageSetSupabase(o: SupabaseInput): Promise<IpcResult<{ recoveryKey: string }>>;
  connStorageUploadNow(): Promise<IpcResult<{ fragments: number; messages: number }>>;
  connStorageVerify(): Promise<IpcResult<VerifyResult>>;
  connStorageClear(): Promise<IpcResult<void>>;
  // 공간(방식 1, v3.0 4단계)
  connS1Create(o: Space1CreateInput): Promise<IpcResult<string>>;
  connS1Invite(spaceId: string, label: string, expiresInMs: number): Promise<IpcResult<string>>;
  connS1Join(o: Space1JoinInput): Promise<IpcResult<string>>;
  connS1Revoke(spaceId: string, hubId: string): Promise<IpcResult<void>>;
  connS1SyncNow(spaceId: string): Promise<IpcResult<void>>;
  connS1Leave(spaceId: string): Promise<IpcResult<void>>;
  // 다른 PC 백업 가져오기(v3.0 7단계)
  connRestoreScan(o: RestoreInput): Promise<IpcResult<BackupCandidate[]>>;
  connRestore(o: RestoreInput & { spaceId: string; hubId: string }): Promise<IpcResult<RestoreResult>>;
  // 서버 연결(방식 3, v3.0 5단계)
  connMeshInvite(label: string, host: string, expiresInMs: number): Promise<IpcResult<{ code: string; ipWarning: boolean }>>;
  connMeshJoin(code: string): Promise<IpcResult<string>>;
  connMeshRemove(spaceId: string): Promise<IpcResult<void>>;
  connMeshSetShared(serverIds: string[]): Promise<IpcResult<void>>;
  connMeshSetCase(choice: MeshCaseChoice): Promise<IpcResult<void>>;
  connMeshCoordinator(on: boolean): Promise<IpcResult<void>>;
  connMeshAccept(spaceId: string | null): Promise<IpcResult<void>>;
  connMeshServerAccept(origin: string): Promise<IpcResult<void>>;
  connMeshServerReject(origin: string): Promise<IpcResult<void>>;
  connMeshVerifyCreate(label: string): Promise<IpcResult<string>>;
  connMeshVerifyRegister(code: string): Promise<IpcResult<void>>;
  connMeshVerifyDelete(kind: "managed" | "held", cid: string): Promise<IpcResult<void>>;
  connMeshCommand(cmd: MeshCommand): Promise<IpcResult<void>>;
  connStoragePruneSet(o: { enabled: boolean; days: number }): Promise<IpcResult<void>>;
  // 통신 서버·채널 삭제(휴지통으로)
  connDeleteServer(serverId: string): Promise<IpcResult<void>>;
  connDeleteChannel(channelId: string): Promise<IpcResult<void>>;
}

/** Hub 수동 시작용 실행 정보(v3.1 Hub가 hub.json의 launch에 적음 — hub/launchInfo.ts와 같은 모양). */
export interface MembershipSyncResult { removedServers: number; removedMembers: number; addedServers: number; repaired: number }

export interface LaunchInfo { execPath: string; execArgv: string[]; entry: string; env: Record<string, string> }
