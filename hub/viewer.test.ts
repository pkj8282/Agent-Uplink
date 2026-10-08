import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { Hub } from "./server.js";
import { startTestHub, TestClient, openViewerSession, registerTestHub, TEST_SECURE_DEPS, httpGet, hasHangul, tempDir } from "./testing.js";
import { renderViewerHtml } from "./viewer.js";

test("뷰어 HTML은 외부 CDN 없이 EventSource를 쓴다", () => {
  const html = renderViewerHtml("ko");
  assert.match(html, /<!doctype html>/i);
  assert.doesNotMatch(html, /https?:\/\//i);
  assert.match(html, /EventSource\(/);
});

test("뷰어에 채널 필터 셀렉트와 채널별 분류 로직이 있다", () => {
  const html = renderViewerHtml("ko");
  assert.match(html, /id="chan"/); // 채널 필터 select
  assert.match(html, /addEventListener\("change"/); // 필터 변경 핸들러
  assert.match(html, /dataset\.ch|data-ch|setAttribute\("data-ch"/); // 행별 채널 표식으로 필터
});

test("send하면 SSE로 채널 라벨과 함께 실시간 전달된다", async () => {
  const { hub, port: tcpPort } = await startTestHub({ http: true });
  const httpPort = hub.httpAddress.port;
  const session = await openViewerSession(tcpPort);

  const got = new Promise<string>((resolve) => {
    http.get({ host: "127.0.0.1", port: httpPort, path: `/events?s=${session}` }, (res) => {
      let buf = "";
      res.on("data", (d) => {
        buf += d;
        if (buf.includes("라이브테스트")) resolve(buf);
      });
    });
  });
  const c = new TestClient(tcpPort); await c.ready();
  await c.req("login", { uuid: "u1", name: "A" });
  await c.req("send", { channelId: "lobby", text: "라이브테스트" });

  const data = await got;
  assert.match(data, /main\/lobby/);
  c.close(); hub.stop();
});

test("GET /accounts는 이름·설명·접속 여부를 JSON으로 준다", async () => {
  const { hub, port } = await startTestHub({ http: true });
  const session = await openViewerSession(port);
  const sock = new TestClient(port); await sock.ready();
  await sock.req("login", { uuid: "u1", name: "A" });
  await sock.req("set_profile", { description: "설명" });
  const body = await new Promise<string>((resolve) => {
    http.get({ host: "127.0.0.1", port: hub.httpAddress.port, path: `/accounts?s=${session}` }, (res) => {
      assert.match(String(res.headers["content-type"]), /application\/json/);
      let b = ""; res.on("data", (d) => (b += d)); res.on("end", () => resolve(b));
    });
  });
  assert.deepEqual(JSON.parse(body), [{ uuid: "u1", name: "A", description: "설명", online: true }]);
  sock.close(); hub.stop();
});

test("SSE 실시간 메시지에 보낸 사람 uuid(fromUuid)가 포함된다", async () => {
  const { hub, port } = await startTestHub({ http: true });
  const session = await openViewerSession(port);
  const got = new Promise<string>((resolve) => {
    http.get({ host: "127.0.0.1", port: hub.httpAddress.port, path: `/events?s=${session}` }, (res) => {
      let buf = "";
      res.on("data", (d) => { buf += d; if (buf.includes("uuid확인")) resolve(buf); });
    });
  });
  await new Promise((r) => setTimeout(r, 100));
  const sock = new TestClient(port); await sock.ready();
  await sock.req("login", { uuid: "sender-1", name: "S" });
  await sock.req("send", { channelId: "lobby", text: "uuid확인" });
  const buf = await got;
  const line = buf.split("\n").find((l) => l.startsWith("data:") && l.includes("uuid확인"))!;
  assert.equal(JSON.parse(line.slice(5)).fromUuid, "sender-1");
  sock.close(); hub.stop();
});

test("뷰어는 /accounts로 참여자 목록을 그리고 발신자에 설명 툴팁을 단다", () => {
  const html = renderViewerHtml("ko");
  assert.match(html, /id="people"/);
  assert.match(html, /fetch\("\/accounts" \+ q\(\)\)/);
  assert.match(html, /fromUuid/);
  assert.match(html, /\.title = /);
  assert.doesNotMatch(html, /innerHTML/);
});

test("뷰어 초기 기록과 실시간 메시지는 같은 채널 라벨과 보낸 사람 uuid를 쓴다(lobby가 두 이름으로 갈리지 않음)", async () => {
  const { hub, port } = await startTestHub({ http: true });
  const session = await openViewerSession(port);
  const sock = new TestClient(port); await sock.ready();
  await sock.req("login", { uuid: "sender-1", name: "S" });
  await sock.req("send", { channelId: "lobby", text: "이전기록" });
  const events = new Promise<string>((resolve) => {
    http.get({ host: "127.0.0.1", port: hub.httpAddress.port, path: `/events?s=${session}` }, (res) => {
      let buf = "";
      res.on("data", (d) => { buf += d; if (buf.includes("실시간")) resolve(buf); });
    });
  });
  await new Promise((r) => setTimeout(r, 100));
  await sock.req("send", { channelId: "lobby", text: "실시간" });
  const buf = await events;
  const initLine = buf.split("\n").find((l, i, all) => l.startsWith("data:") && all[i - 1] === "event: init")!;
  const old = JSON.parse(initLine.slice(5)).find((m: any) => m.text === "이전기록");
  const liveLine = buf.split("\n").find((l) => l.startsWith("data:") && l.includes("실시간"))!;
  const live = JSON.parse(liveLine.slice(5));
  assert.equal(old.channelLabel, live.channelLabel);
  assert.equal(old.channelLabel, "main/lobby");
  assert.equal(old.fromUuid, "sender-1");
  sock.close(); hub.stop();
});

test("뷰어는 #t= 티켓을 /session으로 바꿔 sessionStorage에 두고 주소에서 지우며, 세션이 없거나 401이면 여는 법을 안내한다", () => {
  const html = renderViewerHtml("ko");
  assert.match(html, /location\.hash/);
  assert.match(html, /\/session\?t=/);
  assert.match(html, /sessionStorage/);
  assert.match(html, /history\.replaceState/);
  assert.match(html, /status === 401/);
  assert.match(html, /id="auth"/);
  assert.match(html, /agent-uplink-viewer/);
  assert.doesNotMatch(html, /document\.cookie/);
});

test("유휴 종료(stop) 뒤에는 열려 있던 뷰어 연결로도 요청이 처리되지 않는다(프로세스가 남지 않게)", async () => {
  const { hub, port } = await startTestHub({ http: true });
  const httpPort = hub.httpAddress.port;
  const session = await openViewerSession(port);
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const ended = new Promise<void>((resolve) => {
    http.get({ host: "127.0.0.1", port: httpPort, path: `/events?s=${session}`, agent }, (res) => { res.on("data", () => {}); res.on("end", () => resolve()); });
  });
  await new Promise((r) => setTimeout(r, 200));
  hub.stop();
  await ended;
  // EventSource 재접속·주기적 fetch처럼 같은 keep-alive 연결로 다시 요청한다.
  const status = await new Promise<number>((resolve) => {
    const req = http.get({ host: "127.0.0.1", port: httpPort, path: `/accounts?s=${session}`, agent }, (res) => { res.resume(); resolve(res.statusCode!); });
    req.on("error", () => resolve(-1));
  });
  agent.destroy();
  assert.equal(status, -1, "닫힌 Hub가 남은 연결로 응답했다");
});

test("열린 뷰어(실시간 연결)가 있으면 유휴 종료하지 않고, 뷰어를 닫으면 유휴 종료한다", async () => {
  const dataDir = tempDir("uplink-vw-idle-");
  const hub = new Hub({ tcpPort: 0, httpPort: 0, dataDir, idleShutdownMs: 300 });
  await hub.startTcp(); await hub.startHttp(); await hub.secure(TEST_SECURE_DEPS);
  registerTestHub(hub.tcpAddress.port, dataDir);
  const httpPort = hub.httpAddress.port;
  try {
    const session = await openViewerSession(hub.tcpAddress.port); // TCP는 닫힘 → 유휴 타이머 시작
    const sse = http.get({ host: "127.0.0.1", port: httpPort, path: `/events?s=${session}` });
    await new Promise((r) => sse.once("response", r));
    await new Promise((r) => setTimeout(r, 800)); // 유휴 시간(300ms)을 충분히 넘김
    assert.equal((await httpGet(httpPort, `/accounts?s=${session}`)).status, 200); // 뷰어가 Hub를 살려 둠
    sse.destroy(); // 뷰어 탭 닫음
    await new Promise((r) => setTimeout(r, 800));
    await assert.rejects(httpGet(httpPort, `/accounts?s=${session}`)); // 유휴 종료됨(연결 거부)
  } finally { hub.stop(); }
});

test("뷰어 HTML은 언어를 따른다(영어에는 한글이 없다)", () => {
  const en = renderViewerHtml("en");
  assert.match(en, /<html lang="en">/);
  assert.match(en, /All channels/);
  assert.equal(hasHangul(en), false);
  const ko = renderViewerHtml("ko");
  assert.match(ko, /<html lang="ko">/);
  assert.match(ko, /전체 채널/);
});

test("Hub는 현재 언어로 뷰어 HTML을 준다", async () => {
  const { hub } = await startTestHub({ http: true, language: "en" });
  const r = await httpGet(hub.httpAddress.port, "/");
  assert.equal(r.status, 200);
  assert.match(r.body, /<html lang="en">/);
  hub.stop();
});

test("뷰어 시각 표시는 UI 언어의 지역 형식을 쓴다", () => {
  assert.match(renderViewerHtml("en"), /toLocaleTimeString\("en-US"\)/);
  assert.match(renderViewerHtml("ko"), /toLocaleTimeString\("ko-KR"\)/);
});
