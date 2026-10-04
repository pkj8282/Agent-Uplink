import { test } from "node:test";
import assert from "node:assert/strict";
import { isViewerUrl } from "./viewerUrl.js";

const T = "a".repeat(64);

test("Hub가 주는 형식(티켓은 URL 조각)만 통과", () => {
  assert.equal(isViewerUrl(`http://127.0.0.1:47801/#t=${T}`), true);
});

test("다른 호스트·스킴·경로·쿼리·사용자 정보·형식은 거부", () => {
  for (const bad of [
    `http://127.0.0.1:47801/?t=${T}`,
    `https://127.0.0.1:47801/#t=${T}`,
    `http://localhost:47801/#t=${T}`,
    `http://127.0.0.1.evil.example:47801/#t=${T}`,
    `http://127.0.0.1:1@evil.example/#t=${T}`,
    `http://127.0.0.1/#t=${T}`,
    `http://127.0.0.1:47801/x#t=${T}`,
    `http://127.0.0.1:47801/?u=1#t=${T}`,
    `http://127.0.0.1:47801/#t=${T}&u=1`,
    `http://127.0.0.1:47801/#t=short`,
    `javascript:alert(1)`,
    "",
    42,
    null,
  ]) assert.equal(isViewerUrl(bad), false, String(bad));
});
