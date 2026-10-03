import { test } from "node:test";
import assert from "node:assert/strict";
import { isTrustedSender } from "./ipcGuard.js";

const INDEX = "file:///C:/App/resources/app.asar/dist/renderer/index.html";

test("isTrustedSender는 우리 index.html(쿼리·해시 무시)만 신뢰한다", () => {
  assert.equal(isTrustedSender(INDEX, INDEX), true);
  assert.equal(isTrustedSender(`${INDEX}#tab`, INDEX), true);
  assert.equal(isTrustedSender(`${INDEX}?a=1`, INDEX), true);
  assert.equal(isTrustedSender("file:///C:/App/resources/app.asar/dist/renderer/other.html", INDEX), false);
  assert.equal(isTrustedSender("https://evil.example/index.html", INDEX), false);
  assert.equal(isTrustedSender(undefined, INDEX), false);
  assert.equal(isTrustedSender("not a url", INDEX), false);
});

test("isTrustedSender는 같은 경로의 퍼센트 인코딩 차이(~ vs %7E)를 같은 파일로 본다", () => {
  // portable exe가 8.3 경로(DEVELO~1)에 풀릴 때: Node pathToFileURL은 %7E, Chromium은 ~ 그대로
  const node = "file:///C:/Users/DEVELO%7E1/AppData/Local/Temp/x/resources/app.asar/dist/renderer/index.html";
  const chromium = "file:///C:/Users/DEVELO~1/AppData/Local/Temp/x/resources/app.asar/dist/renderer/index.html";
  assert.equal(isTrustedSender(chromium, node), true);
  assert.equal(isTrustedSender(chromium.replace("index.html", "other.html"), node), false);
});
