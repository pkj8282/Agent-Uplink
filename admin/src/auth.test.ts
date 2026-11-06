// 사본 일치: admin/src/auth.ts는 shared/auth.ts·shared/viewerUrl.ts의 사본이다.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as copy from "./auth.js";
import * as orig from "../../shared/auth.js";
import { isViewerUrl as origIsViewerUrl } from "../../shared/viewerUrl.js";

const KEY = "a".repeat(64); const H = "1".repeat(64); const C = "2".repeat(64);

test("HMAC 증명이 원본과 같다(고정 벡터 포함)", () => {
  assert.equal(copy.clientProof(KEY, H, C), orig.clientProof(KEY, H, C));
  assert.equal(copy.hubProof(KEY, H, C), orig.hubProof(KEY, H, C));
  assert.equal(copy.clientProof(KEY, H, C), "2f58e25f4bd0947226ed246c64cc20659df6c660b692f095692c46e1caef48d0");
  const p = orig.hubProof(KEY, H, C);
  assert.equal(copy.proofEquals(p, p), true);
  assert.equal(copy.proofEquals(p, "x"), false);
  assert.ok(copy.isNonce(copy.newNonce()));
});

test("뷰어 URL 검사가 원본과 같다", () => {
  const T = "b".repeat(64);
  for (const u of [`http://127.0.0.1:47801/#t=${T}`, `http://127.0.0.1:47801/?t=${T}`, `http://localhost:47801/#t=${T}`, `http://127.0.0.1:1@evil.example/#t=${T}`, `http://127.0.0.1:47801/#t=${T}&x=1`, "javascript:1"]) {
    assert.equal(copy.isViewerUrl(u), origIsViewerUrl(u), u);
  }
});

test("isGoogleAuthUrl: Google OAuth 인증 주소(https·accounts.google.com·/o/oauth2/v2/auth)만", async () => {
  const { isGoogleAuthUrl } = await import("./auth.js");
  assert.equal(isGoogleAuthUrl("https://accounts.google.com/o/oauth2/v2/auth?client_id=x&redirect_uri=http%3A%2F%2F127.0.0.1%3A5000"), true);
  for (const bad of [
    "http://accounts.google.com/o/oauth2/v2/auth?x=1",
    "https://accounts.google.com.evil.com/o/oauth2/v2/auth?x=1",
    "https://evil.com/o/oauth2/v2/auth?x=1",
    "https://user@accounts.google.com/o/oauth2/v2/auth?x=1",
    "https://accounts.google.com/o/oauth2/v2/other?x=1",
    "https://accounts.google.com:444/o/oauth2/v2/auth?x=1",
    "file:///c:/x", "", 5, null,
  ]) assert.equal(isGoogleAuthUrl(bad), false, String(bad));
});
