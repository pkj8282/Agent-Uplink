import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hub } from "./server.js";
import { renderViewerHtml } from "./viewer.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "uplink-viewer-"));
}

test("renderViewerHtml은 외부 CDN을 참조하지 않는 HTML을 만든다", () => {
  const html = renderViewerHtml();
  assert.match(html, /<!doctype html>/i);
  assert.doesNotMatch(html, /https?:\/\//i); // 외부 링크 없음(로컬 전용)
  assert.match(html, /EventSource\(/); // SSE 연결 코드 포함
});

test("루트 경로는 HTML을, /events는 SSE 초기 스냅샷을 준다", async () => {
  const hub = new Hub({ tcpPort: 0, httpPort: 0, dataDir: tmpDir(), idleShutdownMs: 0 });
  await hub.startTcp();
  await hub.startHttp();
  const port = hub.httpAddress.port;

  const html = await new Promise<string>((resolve) => {
    http.get({ host: "127.0.0.1", port, path: "/" }, (res) => {
      let b = ""; res.on("data", (d) => (b += d)); res.on("end", () => resolve(b));
    });
  });
  assert.match(html, /<!doctype html>/i);

  const initEvent = await new Promise<string>((resolve) => {
    http.get({ host: "127.0.0.1", port, path: "/events" }, (res) => {
      res.on("data", (d) => resolve(String(d))); // 첫 이벤트(init)만 확인
    });
  });
  assert.match(initEvent, /event: init/);
  hub.stop();
});
