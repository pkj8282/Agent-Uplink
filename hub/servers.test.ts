import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ServerStore } from "./servers.js";
import { tempDir } from "./testing.js";

function tmp(): string { return tempDir("uplink-srv-"); }

test("createServer/addChannel이 ID를 부여하고 조회된다", () => {
  const s = new ServerStore({ dir: tmp() });
  const srv = s.createServer("A서버");
  assert.ok(srv.id.length > 0);
  const ch = s.addChannel(srv.id, "논의방");
  assert.ok(ch.id.length > 0);
  assert.equal(s.channelCount(srv.id), 1);
  assert.equal(s.findChannel(ch.id)!.channel.name, "논의방");
  assert.equal(s.findChannel(ch.id)!.server.name, "A서버");
});

test("없는 서버에 addChannel은 throw", () => {
  const s = new ServerStore({ dir: tmp() });
  assert.throws(() => s.addChannel("nope", "x"), /Server not found/);
});

test("removeChannel/removeServer는 제거하고 boolean을 반환한다", () => {
  const s = new ServerStore({ dir: tmp() });
  const srv = s.createServer("A");
  const ch = s.addChannel(srv.id, "c");
  assert.equal(s.removeChannel(ch.id), true);
  assert.equal(s.findChannel(ch.id), undefined);
  assert.equal(s.removeChannel(ch.id), false); // 이미 없음
  assert.equal(s.removeServer(srv.id), true);
  assert.equal(s.getServer(srv.id), undefined);
});

test("재시작 후 servers/index.json에서 복원되고 allChannels를 준다", () => {
  const dir = tmp();
  const s1 = new ServerStore({ dir });
  const srv = s1.createServer("A서버");
  const ch = s1.addChannel(srv.id, "인수인계");
  const s2 = new ServerStore({ dir });
  assert.equal(s2.getServer(srv.id)!.name, "A서버");
  assert.equal(s2.channelCount(srv.id), 1);
  assert.deepEqual(
    s2.allChannels().map((c) => ({ id: c.channelId, s: c.serverName, c: c.channelName })),
    [{ id: ch.id, s: "A서버", c: "인수인계" }],
  );
});
