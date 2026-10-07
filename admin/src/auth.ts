// 사본: shared/auth.ts + shared/viewerUrl.ts(관리 앱은 별도 패키지라 루트 모듈을 번들하지 않는다). 바꾸면 원본과 함께 바꾸고 auth.test.ts를 돌린다.
import fs from "node:fs";
import type { Lang } from "./i18n.js";
import { adminMsg } from "./messages.js";
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

/** 뷰어 티켓 URL 검사: Hub가 주는 형식(http://127.0.0.1:<포트>/#t=<64 hex>)만 브라우저로 연다. */
export function isViewerUrl(u: unknown): u is string {
  if (typeof u !== "string" || !u.startsWith("http://127.0.0.1:")) return false;
  let url: URL;
  try {
    url = new URL(u);
  } catch {
    return false;
  }
  return (
    url.protocol === "http:" &&
    url.hostname === "127.0.0.1" &&
    url.port !== "" &&
    url.username === "" &&
    url.password === "" &&
    url.pathname === "/" &&
    url.search === "" &&
    /^#t=[0-9a-f]{64}$/.test(url.hash)
  );
}

export function readClientKeyFile(file: string, lang: Lang): string {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    throw new Error(adminMsg(lang, "client_key_unreadable", { file }));
  }
  const key = raw.trim();
  if (!isKeyText(key)) throw new Error(adminMsg(lang, "client_key_malformed", { file }));
  return key;
}
