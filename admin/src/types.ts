// 메인·프리로드·렌더러가 공유하는 타입(값 없음 → 렌더러에서 import type 가능).

export interface AdminConfig {
  maxChannelsPerServer: number;
  allowDevDelete: boolean;
  inboxMaxBatch: number;
}

export type ConfigPatch = Partial<AdminConfig>;

export interface SnapshotServer { id: string; name: string; channels: { id: string; name: string }[]; }
export interface SnapshotAccount { uuid: string; name: string; }
export interface SnapshotDm { channelId: string; members: string[]; label: string; }

export interface Snapshot {
  config: AdminConfig;
  servers: SnapshotServer[];
  accounts: SnapshotAccount[];
  dms: SnapshotDm[];
}

/** IPC 결과 봉투. hubDown은 Hub 미실행(접속 거부)일 때만 true. */
export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string; hubDown: boolean };

/** preload가 window.admin으로 노출하는 API. */
export interface AdminApi {
  snapshot(): Promise<IpcResult<Snapshot>>;
  setConfig(patch: ConfigPatch): Promise<IpcResult<AdminConfig>>;
  deleteChannel(channelId: string): Promise<IpcResult<void>>;
  deleteServer(serverId: string): Promise<IpcResult<void>>;
  deleteAccount(uuid: string): Promise<IpcResult<void>>;
}
