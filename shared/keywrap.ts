// 열쇠 감싸기·봉함(v3.0 4단계, 설계 5.3 방식 1): 공간 세대 열쇠를 구성원 X25519 공개키로 감싼다(HPKE와 같은 구조 —
// 임시 X25519 + HKDF-SHA256 + AES-256-GCM). 봉함(seal)은 명부의 이름·채널 목록을 세대 열쇠로 감춘다.
// 표준 암호만(Node 내장). 실패는 null(예외로 Hub를 죽이지 않음).
import { createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, type CipherGCM, type DecipherGCM } from "node:crypto";

export interface WrappedKey { epk: string; nonce: string; ct: string }

export function generateWrapKeys(): { publicB64: string; privatePem: string } {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  return {
    publicB64: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    privatePem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

function gcmEncrypt(key: Buffer, aad: string, plain: Buffer): { nonce: string; ct: string } {
  const nonce = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, nonce) as CipherGCM;
  c.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
  return { nonce: nonce.toString("base64"), ct: ct.toString("base64") };
}

function gcmDecrypt(key: Buffer, aad: string, nonceB64: string, ctB64: string): Buffer | null {
  try {
    const nonce = Buffer.from(nonceB64, "base64");
    const ct = Buffer.from(ctB64, "base64");
    if (nonce.length !== 12 || ct.length < 16) return null;
    const d = createDecipheriv("aes-256-gcm", key, nonce) as DecipherGCM;
    d.setAAD(Buffer.from(aad, "utf8"));
    d.setAuthTag(ct.subarray(ct.length - 16));
    return Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  } catch {
    return null;
  }
}

function wrapKeyMaterial(shared: Buffer, epkDer: Buffer, recipientDer: Buffer, aad: string): Buffer {
  return Buffer.from(hkdfSync("sha256", shared, Buffer.concat([epkDer, recipientDer]), `agent-uplink/v3/wrap|${aad}`, 32));
}

/** key를 받는이 공개키로 감싼다. aad는 문맥(공간·세대·받는이)을 묶는다. */
export function wrapKey(key: Buffer, recipientPubB64: string, aad: string): WrappedKey {
  const recipientDer = Buffer.from(recipientPubB64, "base64");
  const recipient = createPublicKey({ key: recipientDer, format: "der", type: "spki" });
  const eph = generateKeyPairSync("x25519");
  const epkDer = eph.publicKey.export({ type: "spki", format: "der" });
  const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: recipient });
  const k = wrapKeyMaterial(shared, epkDer, recipientDer, aad);
  return { epk: epkDer.toString("base64"), ...gcmEncrypt(k, aad, key) };
}

/** 내 개인키로 푼다. 받는이가 아니거나 aad·내용이 다르면 null. */
export function unwrapKey(w: WrappedKey, privatePem: string, aad: string): Buffer | null {
  try {
    if (!w || typeof w.epk !== "string" || typeof w.nonce !== "string" || typeof w.ct !== "string") return null;
    const priv = createPrivateKey(privatePem);
    const myDer = createPublicKey(priv).export({ type: "spki", format: "der" });
    const epkDer = Buffer.from(w.epk, "base64");
    const epk = createPublicKey({ key: epkDer, format: "der", type: "spki" });
    const shared = diffieHellman({ privateKey: priv, publicKey: epk });
    return gcmDecrypt(wrapKeyMaterial(shared, epkDer, myDer, aad), aad, w.nonce, w.ct);
  } catch {
    return null;
  }
}

function sealKey(key: Buffer, aad: string): Buffer {
  return Buffer.from(hkdfSync("sha256", key, "agent-uplink/v3/seal", aad, 32));
}

/** 객체를 열쇠로 봉함(이름·채널 목록 감추기). */
export function seal(key: Buffer, aad: string, obj: unknown): { nonce: string; ct: string } {
  return gcmEncrypt(sealKey(key, aad), aad, Buffer.from(JSON.stringify(obj), "utf8"));
}

export function unseal(key: Buffer, aad: string, sealed: { nonce?: unknown; ct?: unknown }): unknown | null {
  if (!sealed || typeof sealed.nonce !== "string" || typeof sealed.ct !== "string") return null;
  const plain = gcmDecrypt(sealKey(key, aad), aad, sealed.nonce, sealed.ct);
  if (!plain) return null;
  try {
    return JSON.parse(plain.toString("utf8"));
  } catch {
    return null;
  }
}
