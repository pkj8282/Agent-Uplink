// v2 프로토콜 상수와 타입.
export const MAGIC = "agent-uplink";
export const PROTOCOL_VERSION = 2;
export const DEFAULT_TCP_PORT = 47800;
export const DEFAULT_HTTP_PORT = 47801;
export const LOBBY_CHANNEL_ID = "lobby";

export type ChannelKind = "dm" | "server";

export interface Channel {
  id: string;
  kind: ChannelKind;
  label: string;
  members: string[] | null; // null = 전체 공개(모든 계정), 배열 = 해당 uuid만(DM)
}

export interface Message {
  seq: number; // 채널별 단조 증가
  ts: number;
  channelId: string;
  from: string; // 발신 계정 uuid
  fromName: string;
  text: string;
}

export interface InboxItem {
  seq: number; // 계정 인박스 라인 단조 증가
  ts: number;
  channelId: string;
  channelKind: ChannelKind;
  channelLabel: string;
  from: string;
  fromName: string;
  text: string;
}

export interface AccountInfo {
  uuid: string;
  name: string;
  description?: string;
  online?: boolean;
}

export interface AccountStatus {
  uuid: string;
  exists: boolean;
  name: string;
  description: string;
  online: boolean;
}

export type Request =
  | { op: "hello"; id: number }
  | { op: "login"; id: number; uuid: string; name?: string; exclusive?: boolean; sessionToken?: string }
  | { op: "set_profile"; id: number; description: string }
  | { op: "account_status"; id: number; uuids: string[] }
  | { op: "whoami"; id: number }
  | { op: "set_name"; id: number; name: string }
  | { op: "list_accounts"; id: number }
  | { op: "send"; id: number; channelId: string; text: string }
  | { op: "read"; id: number; channelId: string; limit?: number }
  | { op: "check"; id: number }
  | { op: "wait"; id: number; timeoutMs?: number }
  | { op: "open_dm"; id: number; peer: string }
  | { op: "list_dms"; id: number }
  | { op: "create_server"; id: number; name: string }
  | { op: "list_servers"; id: number }
  | { op: "create_channel"; id: number; serverId: string; name: string }
  | { op: "list_channels"; id: number; serverId: string }
  | { op: "delete_channel"; id: number; channelId: string }
  | { op: "delete_server"; id: number; serverId: string }
  | { op: "admin_snapshot"; id: number; token: string }
  | { op: "admin_set_config"; id: number; token: string; patch: { maxChannelsPerServer?: number; allowDevDelete?: boolean; inboxMaxBatch?: number } }
  | { op: "admin_delete_channel"; id: number; token: string; channelId: string }
  | { op: "admin_delete_server"; id: number; token: string; serverId: string }
  | { op: "admin_delete_account"; id: number; token: string; uuid: string };

export interface Response {
  ok: boolean;
  id: number;
  magic?: string;
  version?: number;
  uuid?: string;
  name?: string;
  accounts?: AccountInfo[];
  description?: string; // whoami / set_profile
  statuses?: AccountStatus[]; // account_status
  seq?: number;
  messages?: Message[];
  items?: InboxItem[];
  channelId?: string; // open_dm / create_channel
  dms?: { peer: string; peerName: string; channelId: string; peerDescription: string; peerOnline: boolean }[]; // list_dms
  serverId?: string; // create_server
  servers?: { serverId: string; name: string; channelCount: number }[]; // list_servers
  channels?: { channelId: string; name: string }[]; // list_channels
  config?: { maxChannelsPerServer: number; allowDevDelete: boolean; inboxMaxBatch: number }; // admin_snapshot/set_config
  snapshotServers?: { id: string; name: string; channels: { id: string; name: string }[] }[]; // admin_snapshot
  snapshotAccounts?: { uuid: string; name: string; description: string; online: boolean }[]; // admin_snapshot
  snapshotDms?: { channelId: string; members: string[]; label: string }[]; // admin_snapshot
  error?: string;
}
