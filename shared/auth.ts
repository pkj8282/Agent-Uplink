// Hub 연결 인증(프로토콜 v3): 키를 보내지 않는 상호 HMAC challenge-response.
// 관리 앱은 별도 패키지라 admin/src/auth.ts에 사본이 있다 — 바꾸면 사본도 같이 바꾸고 일치 테스트를 돌린다.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const HEX64 = /^[0-9a-f]{64}$/;

export function newNonce(): string {
  return randomBytes(32).toString("hex");
}

export function isNonce(x: unknown): x is string {
  return typeof x === "string" && HEX64.test(x);
}

/** client.key 내용 형식(64자 소문자 hex). */
export function isKeyText(x: unknown): x is string {
  return typeof x === "string" && HEX64.test(x);
}

function mac(key: string, msg: string): string {
  return createHmac("sha256", Buffer.from(key, "hex")).update(msg, "utf8").digest("hex");
}

/** 클라이언트가 키를 안다는 증명(Hub nonce에 묶임 → 다른 연결에 재전송 불가). */
export function clientProof(key: string, hubNonce: string, clientNonce: string): string {
  return mac(key, `uplink-v3-client|${hubNonce}|${clientNonce}`);
}

/** Hub가 키를 안다는 증명(클라이언트 nonce에 묶임 → 가짜 Hub가 만들 수 없음). */
export function hubProof(key: string, hubNonce: string, clientNonce: string): string {
  return mac(key, `uplink-v3-hub|${clientNonce}|${hubNonce}`);
}

export function proofEquals(expected: string, got: unknown): boolean {
  if (typeof got !== "string" || !HEX64.test(got) || !HEX64.test(expected)) return false;
  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(got, "hex"));
}
