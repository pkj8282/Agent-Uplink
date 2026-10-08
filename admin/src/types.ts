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
}

export interface NameConflict { kind: "server" | "channel"; name: string; to: string; }

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
}
