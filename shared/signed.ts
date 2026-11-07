// 서명 봉투(v3.0 4단계): 저장소에 올리는 명부·열쇠·요청 파일을 Ed25519로 서명한다.
// 형식 {body, signer, sig}. 서명 대상 = "agent-uplink/v3/envelope\n" + 정규화 JSON(키 정렬) — 키 순서가 달라도 같은 본문.
import { signB64, verifyB64 } from "./connCrypto.js";

export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

const data = (body: unknown, signer: string) => Buffer.from(`agent-uplink/v3/envelope\n${signer}\n${canonical(body)}`, "utf8");

export function signEnvelope(body: object, privateKeyPem: string, signerKeyB64: string): string {
  return JSON.stringify({ body, signer: signerKeyB64, sig: signB64(privateKeyPem, data(body, signerKeyB64)) });
}

/** 서명 확인. expectSigner를 주면 그 키로 서명한 것만. */
export function openEnvelope(raw: string, expectSigner?: string): { ok: true; body: Record<string, unknown>; signer: string } | { ok: false } {
  try {
    const j = JSON.parse(raw) as { body?: unknown; signer?: unknown; sig?: unknown };
    if (!j || typeof j.body !== "object" || j.body === null || Array.isArray(j.body) || typeof j.signer !== "string" || typeof j.sig !== "string") return { ok: false };
    if (expectSigner !== undefined && j.signer !== expectSigner) return { ok: false };
    if (!verifyB64(j.signer, data(j.body, j.signer), j.sig)) return { ok: false };
    return { ok: true, body: j.body as Record<string, unknown>, signer: j.signer };
  } catch {
    return { ok: false };
  }
}
