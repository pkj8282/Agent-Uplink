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
export interface SnapshotAccount { uuid: string; name: string; description?: string; online?: boolean; }
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
  joined: { spaceId: string; spaceName: string; hostUser: string; connected: boolean }[];
  userName: string | null;
  /** 이 Hub의 통신 서버·채널(Connection Communications). 1단계 Hub는 없음 → []. */
  comms: ConnCommsServer[];
  /** 최근 통신 사건(오래된 것 → 최근, 최대 50). 1단계 Hub는 없음 → []. */
  events: ConnEvent[];
  /** 저장소(백업) 상태. 3a 이전 Hub는 없음 → null. */
  storage: StorageStatus | null;
}
export interface StorageStatus { configured: boolean; kind?: "github"; repo?: string; intervalMin?: number; lastUploadAt: number | null; lastError: string | null; nextIndex: number; prune?: { enabled: boolean; days: number; lastPruneAt: number | null }; }
export interface StorageInput { repo: string; token: string; intervalMin: number; }
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
  connStorageUploadNow(): Promise<IpcResult<{ fragments: number; messages: number }>>;
  connStorageVerify(): Promise<IpcResult<VerifyResult>>;
  connStorageClear(): Promise<IpcResult<void>>;
  connStoragePruneSet(o: { enabled: boolean; days: number }): Promise<IpcResult<void>>;
  // 통신 서버·채널 삭제(휴지통으로)
  connDeleteServer(serverId: string): Promise<IpcResult<void>>;
  connDeleteChannel(channelId: string): Promise<IpcResult<void>>;
}
