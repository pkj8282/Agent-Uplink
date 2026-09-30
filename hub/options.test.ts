import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveOptions } from "./options.js";

test("기본값은 47800/47801과 ProgramData 경로를 쓴다", () => {
  const o = resolveOptions({ PROGRAMDATA: "C:\\ProgramData" } as any);
  assert.equal(o.tcpPort, 47800);
  assert.equal(o.httpPort, 47801);
  assert.match(o.dataDir, /AgentUplink/);
  assert.equal(o.idleShutdownMs, 10 * 60 * 1000);
});

test("환경변수로 포트와 유휴 종료를 오버라이드한다", () => {
  const o = resolveOptions({
    PROGRAMDATA: "C:\\ProgramData",
    UPLINK_TCP_PORT: "50000",
    UPLINK_HTTP_PORT: "50001",
    UPLINK_IDLE_MINUTES: "0",
  } as any);
  assert.equal(o.tcpPort, 50000);
  assert.equal(o.httpPort, 50001);
  assert.equal(o.idleShutdownMs, 0);
});
