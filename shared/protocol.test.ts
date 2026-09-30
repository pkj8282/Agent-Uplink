import { test } from "node:test";
import assert from "node:assert/strict";
import { MAGIC, PROTOCOL_VERSION, DEFAULT_TCP_PORT, DEFAULT_HTTP_PORT } from "./protocol.js";

test("프로토콜 상수가 스펙과 일치한다", () => {
  assert.equal(MAGIC, "agent-uplink");
  assert.equal(PROTOCOL_VERSION, 1);
  assert.equal(DEFAULT_TCP_PORT, 47800);
  assert.equal(DEFAULT_HTTP_PORT, 47801);
});
