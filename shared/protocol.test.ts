import { test } from "node:test";
import assert from "node:assert/strict";
import { MAGIC, PROTOCOL_VERSION, DEFAULT_TCP_PORT, DEFAULT_HTTP_PORT, LOBBY_CHANNEL_ID } from "./protocol.js";

test("v2 프로토콜 상수", () => {
  assert.equal(MAGIC, "agent-uplink");
  assert.equal(PROTOCOL_VERSION, 2);
  assert.equal(DEFAULT_TCP_PORT, 47800);
  assert.equal(DEFAULT_HTTP_PORT, 47801);
  assert.equal(LOBBY_CHANNEL_ID, "lobby");
});
