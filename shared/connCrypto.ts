// 통신(v3.0) 암호 기초: Ed25519 서명, SPKI 지문, HKDF 조각 유도, base32. 표준 암호만 쓴다(node:crypto).
import { createPrivateKey, createPublicKey, generateKeyPairSync, hkdfSync, randomBytes, sign, verify, createHash } from "node:crypto";

export interface SigningKeys {
  /** Ed25519 공개키 SPKI DER의 base64. */
  publicKeyB64: string;
  /** Ed25519 개인키 PKCS#8 PEM. */
  privateKeyPem: string;
}

export function generateSigningKeys(): SigningKeys {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKeyB64: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

export function signB64(privateKeyPem: string, data: Buffer): string {
  return sign(null, data, createPrivateKey(privateKeyPem)).toString("base64");
}

/** 잘못된 키·서명 형식은 throw하지 않고 false. */
export function verifyB64(publicKeyB64: string, data: Buffer, sigB64: string): boolean {
  try {
    if (typeof publicKeyB64 !== "string" || typeof sigB64 !== "string") return false;
    const key = createPublicKey({ key: Buffer.from(publicKeyB64, "base64"), format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "ed25519") return false;
    return verify(null, data, key, Buffer.from(sigB64, "base64"));
  } catch {
    return false;
  }
}

/** SPKI DER의 SHA-256 소문자 hex(공개키 고정에 쓴다). */
export function spkiFingerprint(publicKeyB64: string): string {
  return createHash("sha256").update(Buffer.from(publicKeyB64, "base64")).digest("hex");
}

const HKDF_SALT = "agent-uplink/v3";

/** 원문 계획의 "조각별 변형 후 재조합"을 HKDF로: 조각 i마다 info=`${label}/${i}`로 유도해 순서대로 이어 붙인다. */
export function derivePieces(master: Buffer, pieceCount: number, pieceLen: number, label: string): Buffer {
  const parts: Buffer[] = [];
  for (let i = 0; i < pieceCount; i++) {
    parts.push(Buffer.from(hkdfSync("sha256", master, HKDF_SALT, `${label}/${i}`, pieceLen)));
  }
  return Buffer.concat(parts);
}

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 base32(대문자, 패딩 없음). */
export function toBase32(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/** 대소문자·`-`·공백 무시. 알파벳 밖 문자가 있으면 null. */
export function fromBase32(s: string): Buffer | null {
  const clean = s.replace(/[-\s]/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const v = B32.indexOf(ch);
    if (v < 0) return null;
    value = ((value << 5) | v) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** 1회용 참여 토큰: OS 난수 32바이트에서 5바이트 조각 4개를 유도(20바이트) → base32 4글자 묶음. */
export function newJoinToken(): string {
  const raw = toBase32(derivePieces(randomBytes(32), 4, 5, "join-token"));
  return raw.match(/.{4}/g)!.join("-");
}
