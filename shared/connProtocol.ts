// 통신(v3.0) 프로토콜: 통신 서버(TLS 리스너)와 참여자 Hub 사이의 요청·응답·이벤트.
// 로컬 프로토콜(shared/protocol.ts)과 분리된다 — 통신 리스너는 여기 있는 op만 처리한다.
import type { MessageOrigin } from "./protocol.js";

export const CONN_MAGIC = "agent-uplink-conn";
export const CONN_VERSION = 1;
/** TLS exportKeyingMaterial 라벨(context는 빈 버퍼) — 서명을 이 TLS 세션에 묶는다. */
export const CONN_EKM_LABEL = "agent-uplink-conn-v1";

export function joinSigData(challengeB64: string, ekmB64: string, token: string, hubKey: string): Buffer {
  return Buffer.from(`uplink-join\n${challengeB64}\n${ekmB64}\n${token}\n${hubKey}`, "utf8");
}

export function authSigData(challengeB64: string, ekmB64: string, memberId: string): Buffer {
  return Buffer.from(`uplink-auth\n${challengeB64}\n${ekmB64}\n${memberId}`, "utf8");
}

/** 서버 연결(방식 3) 참여 서명: 붙는 서버 C의 서버 키·공간 ID를 이 TLS 세션에 묶는다. */
export function linkJoinSigData(challengeB64: string, ekmB64: string, token: string, serverKey: string, spaceId: string): Buffer {
  return Buffer.from(`uplink-link-join\n${challengeB64}\n${ekmB64}\n${token}\n${serverKey}\n${spaceId}`, "utf8");
}

export function linkAuthSigData(challengeB64: string, ekmB64: string, spaceId: string): Buffer {
  return Buffer.from(`uplink-link-auth\n${challengeB64}\n${ekmB64}\n${spaceId}`, "utf8");
}

/** 서버 연결로 인증된 연결에서만 받는 요청(이벤트는 망 엔진이 이름으로 거른다). */
export const LINK_OPS_AFTER_AUTH = ["l_heads", "l_pull", "l_backup_head"] as const;

export const CONN_OPS_AFTER_AUTH = ["c_list", "c_send", "c_read", "c_accounts"] as const;

export type ConnRequest =
  | { op: "c_hello"; id: number }
  | { op: "c_join"; id: number; token: string; hubKey: string; userName: string; sig: string }
  | { op: "c_auth"; id: number; memberId: string; sig: string }
  | { op: "c_list"; id: number }
  | { op: "c_send"; id: number; channelId: string; from: { uuid: string; name: string }; text: string }
  | { op: "c_read"; id: number; channelId: string; limit?: number }
  | { op: "c_accounts"; id: number; accounts: { uuid: string; name: string; description: string }[] }
  | { op: "l_join"; id: number; token: string; serverKey: string; spaceId: string; spaceName: string; sig: string }
  | { op: "l_auth"; id: number; spaceId: string; sig: string };

/** id를 뺀 요청 본문(유니온 각 갈래별로 — 보내는 쪽이 id를 붙인다). */
export type ConnRequestBody = ConnRequest extends unknown ? (ConnRequest extends infer R ? (R extends ConnRequest ? Omit<R, "id"> : never) : never) : never;

export interface SharedServer {
  serverId: string;
  name: string;
  channels: { channelId: string; name: string }[];
}

/** 다른 Hub의 연결 계정. uuid는 서버가 이름공간을 붙인 값(`${memberId}:${원래 uuid}`, 통신 서버 자신의 계정은 `host:${uuid}`). */
export interface RemoteAccount {
  uuid: string;
  name: string;
  description: string;
  hubUser: string;
  memberId: string;
}

export type ConnEvent =
  | { event: "msg"; channelId: string; seq: number; ts: number; from: string; fromName: string; text: string; origin: MessageOrigin }
  | { event: "shared"; servers: SharedServer[] }
  | { event: "accounts"; accounts: RemoteAccount[] };
