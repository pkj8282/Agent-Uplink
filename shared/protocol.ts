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
}

export type Request =
  | { op: "hello"; id: number }
  | { op: "login"; id: number; uuid: string; name?: string }
  | { op: "whoami"; id: number }
  | { op: "set_name"; id: number; name: string }
  | { op: "list_accounts"; id: number }
  | { op: "send"; id: number; channelId: string; text: string }
  | { op: "read"; id: number; channelId: string; limit?: number }
  | { op: "check"; id: number }
  | { op: "wait"; id: number; timeoutMs?: number }
  | { op: "open_dm"; id: number; peer: string }
  | { op: "list_dms"; id: number };

export interface Response {
  ok: boolean;
  id: number;
  magic?: string;
  version?: number;
  uuid?: string;
  name?: string;
  accounts?: AccountInfo[];
  seq?: number;
  messages?: Message[];
  items?: InboxItem[];
  channelId?: string; // open_dm
  dms?: { peer: string; peerName: string; channelId: string }[]; // list_dms
  error?: string;
}
