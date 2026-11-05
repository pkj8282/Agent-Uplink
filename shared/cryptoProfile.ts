// 통신 암호 프로필 허용 목록(v3.0). 원문 계획의 "원하는 형태로 구성하는 암호 체계"를 검증된 묶음 중 선택으로 반영한다.
// 호스트가 고른 값은 초대 코드 서명에 들어가 참여자가 낮출 수 없다. 임의 공식 입력은 받지 않는다.
export const PROFILES = {
  "tls13-aes256gcm": { tlsCipher: "TLS_AES_256_GCM_SHA384", aead: "aes-256-gcm" },
  "tls13-chacha20": { tlsCipher: "TLS_CHACHA20_POLY1305_SHA256", aead: "chacha20-poly1305" },
} as const;

export type ProfileId = keyof typeof PROFILES;

export const DEFAULT_PROFILE: ProfileId = "tls13-aes256gcm";

export function isProfileId(x: unknown): x is ProfileId {
  return typeof x === "string" && Object.prototype.hasOwnProperty.call(PROFILES, x);
}
