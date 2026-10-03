import { test } from "node:test";
import assert from "node:assert/strict";
import { MAGIC, PROTOCOL_VERSION, DEFAULT_TCP_PORT, DEFAULT_HTTP_PORT, LOBBY_CHANNEL_ID } from "./protocol.js";
import type { Request, Response } from "./protocol.js";

test("v2 프로토콜 상수", () => {
  assert.equal(MAGIC, "agent-uplink");
  assert.equal(PROTOCOL_VERSION, 2);
  assert.equal(DEFAULT_TCP_PORT, 47800);
  assert.equal(DEFAULT_HTTP_PORT, 47801);
  assert.equal(LOBBY_CHANNEL_ID, "lobby");
});

test("open_dm/list_dms 요청 타입과 dms/channelId 응답 필드가 존재한다(컴파일+형태)", () => {
  const a: Request = { op: "open_dm", id: 1, peer: "u2" };
  const b: Request = { op: "list_dms", id: 2 };
  const r: Response = { ok: true, id: 1, channelId: "c", dms: [{ peer: "u2", peerName: "B", channelId: "c" }] };
  assert.equal(a.op, "open_dm");
  assert.equal(b.op, "list_dms");
  assert.equal(r.dms![0].peerName, "B");
});
