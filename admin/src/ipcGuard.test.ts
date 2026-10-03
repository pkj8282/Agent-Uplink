import { test } from "node:test";
import assert from "node:assert/strict";
import { isTrustedFrame } from "./ipcGuard.js";

// Electron 객체 대신 동일성만 보는 가짜 객체(URL 문자열 정규화에 의존하지 않는다).
const webContents = {};
const mainFrame = { url: "file:///c:/research/100%done/renderer/index.html" };

test("isTrustedFrame은 우리 창의 주 프레임에서 온 호출만 신뢰한다(경로 표기와 무관)", () => {
  assert.equal(isTrustedFrame(webContents, mainFrame, { webContents, mainFrame }), true);
  // 드라이브 대소문자·% 포함 경로·8.3 이름이어도 같은 프레임이면 신뢰(문자열 비교 안 함)
  const odd = { url: "file:///C:/Users/USERNA~1/x/index.html" };
  assert.equal(isTrustedFrame(webContents, odd, { webContents, mainFrame: odd }), true);
});

test("isTrustedFrame은 다른 창·하위 프레임·프레임 없음·비 file URL을 거부한다", () => {
  assert.equal(isTrustedFrame({}, mainFrame, { webContents, mainFrame }), false); // 다른 webContents
  assert.equal(isTrustedFrame(webContents, { url: mainFrame.url }, { webContents, mainFrame }), false); // 다른 프레임 객체
  assert.equal(isTrustedFrame(webContents, null, { webContents, mainFrame }), false);
  assert.equal(isTrustedFrame(webContents, undefined, { webContents, mainFrame }), false);
  const remote = { url: "https://evil.example/index.html" };
  assert.equal(isTrustedFrame(webContents, remote, { webContents, mainFrame: remote }), false);
});
