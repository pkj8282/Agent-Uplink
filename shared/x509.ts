// 통신 TLS용 Ed25519 자체 서명 X.509 인증서(v3.0). 의존성 없이 필요한 DER만 만든다.
// 인증서는 CA 체인으로 믿는 것이 아니라 초대 코드의 공개키 지문으로 고정(pinning)해 확인한다(shared/connCrypto.spkiFingerprint).
import { createPrivateKey, randomBytes, sign } from "node:crypto";
import type { SigningKeys } from "./connCrypto.js";

function derLen(n: number): Buffer {
  if (n < 128) return Buffer.from([n]);
  if (n < 256) return Buffer.from([0x81, n]);
  return Buffer.from([0x82, (n >> 8) & 255, n & 255]);
}

function tlv(tag: number, ...body: Buffer[]): Buffer {
  const content = Buffer.concat(body);
  return Buffer.concat([Buffer.from([tag]), derLen(content.length), content]);
}

const seq = (...b: Buffer[]) => tlv(0x30, ...b);
const integer = (b: Buffer) => tlv(0x02, b);
const oid = (hex: string) => tlv(0x06, Buffer.from(hex, "hex"));
const utf8 = (s: string) => tlv(0x0c, Buffer.from(s, "utf8"));

/** UTCTime YYMMDDHHMMSSZ */
function utcTime(d: Date): Buffer {
  return tlv(0x17, Buffer.from(d.toISOString().replace(/[-:T]/g, "").slice(2, 14) + "Z"));
}

/** GeneralizedTime YYYYMMDDHHMMSSZ */
function generalizedTime(d: Date): Buffer {
  return tlv(0x18, Buffer.from(d.toISOString().replace(/[-:T]/g, "").slice(0, 14) + "Z"));
}

const ED25519_ALG = seq(oid("2b6570")); // 1.3.101.112
const CN_OID = "550403"; // 2.5.4.3

export function selfSignedCertPem(keys: SigningKeys, commonName: string, nowMs: number): string {
  const name = seq(tlv(0x31, seq(oid(CN_OID), utf8(commonName))));
  const serial = randomBytes(16);
  serial[0] &= 0x7f; // 양수
  if (serial[0] === 0) serial[0] = 1; // 앞자리 0 바이트로 인한 비정규 INTEGER 방지
  const tbs = seq(
    tlv(0xa0, integer(Buffer.from([2]))), // v3
    integer(serial),
    ED25519_ALG,
    name,
    seq(utcTime(new Date(nowMs - 3600_000)), generalizedTime(new Date(Date.UTC(2099, 0, 1)))),
    name,
    Buffer.from(keys.publicKeyB64, "base64"), // SubjectPublicKeyInfo DER 그대로
  );
  const signature = sign(null, tbs, createPrivateKey(keys.privateKeyPem));
  const der = seq(tbs, ED25519_ALG, tlv(0x03, Buffer.concat([Buffer.from([0]), signature])));
  const b64 = der.toString("base64").match(/.{1,64}/g)!.join("\n");
  return `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`;
}
