import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { encodeFrame, FrameDecoder } from "../shared/framing.js";
import { Hub } from "./server.js";
import { renderViewerHtml } from "./viewer.js";
import { Response } from "../shared/protocol.js";

function tmp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), "uplink-vw-")); }

test("뷰어 HTML은 외부 CDN 없이 EventSource를 쓴다", () => {
  const html = renderViewerHtml();
  assert.match(html, /<!doctype html>/i);
  assert.doesNotMatch(html, /https?:\/\//i);
  assert.match(html, /EventSource\(/);
});

test("뷰어에 채널 필터 셀렉트와 채널별 분류 로직이 있다", () => {
  const html = renderViewerHtml();
  assert.match(html, /id="chan"/); // 채널 필터 select
  assert.match(html, /addEventListener\("change"/); // 필터 변경 핸들러
  assert.match(html, /dataset\.ch|data-ch|setAttribute\("data-ch"/); // 행별 채널 표식으로 필터
});

test("send하면 SSE로 채널 라벨과 함께 실시간 전달된다", async () => {
  const hub = new Hub({ tcpPort: 0, httpPort: 0, dataDir: tmp(), idleShutdownMs: 0 });
  await hub.startTcp(); await hub.startHttp();
  const httpPort = hub.httpAddress.port; const tcpPort = hub.tcpAddress.port;

  const got = new Promise<string>((resolve) => {
    http.get({ host: "127.0.0.1", port: httpPort, path: "/events" }, (res) => {
      let buf = "";
      res.on("data", (d) => {
        buf += d;
        if (buf.includes("라이브테스트")) resolve(buf);
      });
    });
  });
  const sock = net.connect(tcpPort, "127.0.0.1");
  const dec = new FrameDecoder(); let id = 0;
  const waiters = new Map<number, (r: Response) => void>();
  sock.on("data", (d) => dec.push(d, (r: Response) => waiters.get(r.id)?.(r)));
  const req = (op: string, p: object = {}) => new Promise<Response>((resolve) => { const i = ++id; waiters.set(i, resolve); sock.write(encodeFrame({ op, id: i, ...p })); });
  await new Promise<void>((res) => sock.once("connect", () => res()));
  await req("login", { uuid: "u1", name: "A" });
  await req("send", { channelId: "lobby", text: "라이브테스트" });

  const data = await got;
  assert.match(data, /main\/lobby/);
  sock.destroy(); hub.stop();
});
