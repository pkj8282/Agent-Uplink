import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// admin/src/framing.ts는 독립 빌드를 위한 shared/framing.ts 복제본이다 — 원본과 어긋나면 실패한다.
test("admin framing 복제본은 shared/framing.ts와 같다(첫 줄 헤더 주석 제외)", () => {
  const norm = (s: string) => s.replace(/\r\n/g, "\n");
  const original = norm(fs.readFileSync(new URL("../../shared/framing.ts", import.meta.url), "utf8"));
  const copy = norm(fs.readFileSync(new URL("./framing.ts", import.meta.url), "utf8"));
  assert.equal(copy.split("\n").slice(1).join("\n"), original);
});
