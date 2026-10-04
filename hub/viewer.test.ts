import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startTestHub, TestClient } from "./testing.js";
import { renderViewerHtml } from "./viewer.js";

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
  const { hub, port: tcpPort } = await startTestHub({ http: true });
  const httpPort = hub.httpAddress.port;

  const got = new Promise<string>((resolve) => {
    http.get({ host: "127.0.0.1", port: httpPort, path: "/events" }, (res) => {
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
  const sock = new TestClient(port); await sock.ready();
  await sock.req("login", { uuid: "u1", name: "A" });
  await sock.req("set_profile", { description: "설명" });
  const body = await new Promise<string>((resolve) => {
    http.get({ host: "127.0.0.1", port: hub.httpAddress.port, path: "/accounts" }, (res) => {
      assert.match(String(res.headers["content-type"]), /application\/json/);
      let b = ""; res.on("data", (d) => (b += d)); res.on("end", () => resolve(b));
    });
  });
  assert.deepEqual(JSON.parse(body), [{ uuid: "u1", name: "A", description: "설명", online: true }]);
  sock.close(); hub.stop();
});

test("SSE 실시간 메시지에 보낸 사람 uuid(fromUuid)가 포함된다", async () => {
  const { hub, port } = await startTestHub({ http: true });
  const got = new Promise<string>((resolve) => {
    http.get({ host: "127.0.0.1", port: hub.httpAddress.port, path: "/events" }, (res) => {
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
  const html = renderViewerHtml();
  assert.match(html, /id="people"/);
  assert.match(html, /fetch\("\/accounts"\)/);
  assert.match(html, /fromUuid/);
  assert.match(html, /\.title = /);
  assert.doesNotMatch(html, /innerHTML/);
});

test("뷰어 초기 기록과 실시간 메시지는 같은 채널 라벨과 보낸 사람 uuid를 쓴다(lobby가 두 이름으로 갈리지 않음)", async () => {
  const { hub, port } = await startTestHub({ http: true });
  const sock = new TestClient(port); await sock.ready();
  await sock.req("login", { uuid: "sender-1", name: "S" });
  await sock.req("send", { channelId: "lobby", text: "이전기록" });
  const events = new Promise<string>((resolve) => {
    http.get({ host: "127.0.0.1", port: hub.httpAddress.port, path: "/events" }, (res) => {
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
