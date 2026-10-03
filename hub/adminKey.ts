import fs from "node:fs";
import path from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { writeFileAtomic } from "./fsutil.js";

export function loadOrCreateAdminKey(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "admin.key");
  if (fs.existsSync(file)) {
    const t = fs.readFileSync(file, "utf8").trim();
    if (t) return t;
  }
  const key = randomBytes(32).toString("hex");
  writeFileAtomic(file, key);
  return key;
}

export function verifyAdminToken(expected: string, got: unknown): boolean {
  if (typeof got !== "string") return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(got, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
