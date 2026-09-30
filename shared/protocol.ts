// 프로토콜 상수와 요청/응답/메시지 타입 정의.
export const MAGIC = "agent-uplink";
export const PROTOCOL_VERSION = 1;
export const DEFAULT_TCP_PORT = 47800;
export const DEFAULT_HTTP_PORT = 47801;

export interface Message {
  seq: number; // Hub의 단조 증가 정수
  ts: number; // epoch ms
  from: string; // 보낸 세션 이름
  to: string | null; // 대상 세션 이름, 전체면 null
  text: string;
}

export type Request =
  | { op: "hello"; id: number }
  | { op: "register"; id: number; name?: string; clientId?: string }
  | { op: "send"; id: number; text: string; to?: string | null }
  | { op: "check"; id: number }
  | { op: "wait"; id: number; timeoutMs?: number }
  | { op: "who"; id: number };

export interface Response {
  ok: boolean;
  id: number;
  magic?: string; // hello
  version?: number; // hello
  sessionId?: string; // register
  name?: string; // register
  seq?: number; // send
  messages?: Message[]; // check/wait
  sessions?: { name: string; since: number }[]; // who
  error?: string;
}
