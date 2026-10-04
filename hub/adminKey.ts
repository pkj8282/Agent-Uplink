import { timingSafeEqual } from "node:crypto";

// admin.key 생성은 secure.ts(보안 준비)가 맡는다. 여기서는 토큰 비교만.
export function verifyAdminToken(expected: string, got: unknown): boolean {
  if (typeof got !== "string") return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(got, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
