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
