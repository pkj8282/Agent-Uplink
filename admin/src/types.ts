// 메인·프리로드·렌더러가 공유하는 타입(값 없음 → 렌더러에서 import type 가능).

export interface AdminConfig {
  maxChannelsPerServer: number;
  allowDevDelete: boolean;
  inboxMaxBatch: number;
}

export type ConfigPatch = Partial<AdminConfig>;

export interface SnapshotServer { id: string; name: string; channels: { id: string; name: string }[]; }
export interface SnapshotAccount { uuid: string; name: string; description?: string; online?: boolean; }
export interface SnapshotDm { channelId: string; members: string[]; label: string; }

export interface TrashItem {
  id: string;
  kind: "channel" | "server" | "account" | "orphan";
  name: string;
  serverName?: string;
  deletedAt: number;
  deletedBy: "admin" | "mcp" | "recovery";
  bytes: number;
  fileCount: number;
  intact: boolean;
  restorable: boolean;
  dmLeftover?: number;
}

export interface NameConflict { kind: "server" | "channel"; name: string; to: string; }

export interface RestoreReport {
  renamed: { kind: "server" | "channel"; from: string; to: string }[];
  recreatedServer?: { id: string; name: string };
  dmsRestored: number;
  dmsLeft: number;
  itemRemoved: boolean;
}

export interface Snapshot {
  config: AdminConfig;
  servers: SnapshotServer[];
  accounts: SnapshotAccount[];
  dms: SnapshotDm[];
  /** undefined = 휴지통을 지원하지 않는 구버전 Hub. */
  trash?: TrashItem[];
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
  restoreTrash(id: string, confirmRename: boolean): Promise<IpcResult<RestoreReport>>;
  emptyTrash(): Promise<IpcResult<{ removed: number }>>;
}
