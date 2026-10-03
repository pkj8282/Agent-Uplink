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

test("explainStartupError: 데이터 폴더 접근 거부는 다른 Windows 사용자 전용일 가능성과 UPLINK_DATA_DIR 해결책을 안내", async () => {
  const { explainStartupError } = await import("./options.js");
  const e = Object.assign(new Error("EPERM: operation not permitted, scandir 'X'"), { code: "EPERM" });
  const msg = explainStartupError(e, "C:/ProgramData/AgentUplink");
  assert.match(msg, /C:\/ProgramData\/AgentUplink/);
  assert.match(msg, /다른 Windows 사용자/);
  assert.match(msg, /UPLINK_DATA_DIR/);
  assert.match(explainStartupError(Object.assign(new Error("x"), { code: "EACCES" }), "D"), /UPLINK_DATA_DIR/);
  assert.equal(explainStartupError(new Error("다른 오류"), "D"), "Hub 시작 실패: 다른 오류");
});
