import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HubClient } from "./hubClient.js";

const HUB_ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "hub", "index.ts");
const NODE_ARGS = ["--import", "tsx"];
let portSeq = 49400;
function freshPort(): number { return portSeq++; }
function tmp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), "uplink-v2c-")); }

function makeClient(port: number, uuid: string, name: string): HubClient {
  process.env.UPLINK_DATA_DIR = tmp();
  process.env.UPLINK_IDLE_MINUTES = "0.1";
  process.env.UPLINK_TCP_PORT = String(port);
  process.env.UPLINK_HTTP_PORT = String(port + 1000);
  return new HubClient({ port, accountUuid: uuid, accountName: name, hubEntry: HUB_ENTRY, nodeArgs: NODE_ARGS });
}

test("Hub 자동 spawn 후 login되고 whoami가 내 계정을 준다", async () => {
  const port = freshPort();
  const c = makeClient(port, "acc-A", "A");
  const r = await c.whoami();
  assert.equal(r.uuid, "acc-A");
  assert.equal(r.name, "A");
  c.close();
  await new Promise((r) => setTimeout(r, 300));
});

test("두 계정이 lobby로 메시지를 주고받는다(fan-out)", async () => {
  const port = freshPort();
  const a = makeClient(port, "acc-A", "A");
  const b = makeClient(port, "acc-B", "B");
  await Promise.all([a.whoami(), b.whoami()]); // 둘 다 login
  await a.send("lobby", "안녕 B");
  const got = await b.wait(3000);
  assert.deepEqual(got.items!.map((i) => i.text), ["안녕 B"]);
  a.close(); b.close();
  await new Promise((r) => setTimeout(r, 300));
});

test("재연결 후에도 같은 계정으로 커서가 유지된다", async () => {
  const port = freshPort();
  const a = makeClient(port, "acc-A", "A");
  const b = makeClient(port, "acc-B", "B");
  await Promise.all([a.whoami(), b.whoami()]);
  await a.send("lobby", "첫메시지");
  assert.equal((await b.check()).items!.length, 1); // 커서 전진
  b.dropConnectionForTest();
  assert.equal((await b.check()).items!.length, 0); // 재연결 후, 이미 읽은 건 재수신 안 함
  a.close(); b.close();
  await new Promise((r) => setTimeout(r, 300));
});

test("open_dm으로 연 채널로 두 계정이 DM을 주고받는다", async () => {
  const port = freshPort();
  const a = makeClient(port, "acc-A", "A");
  const b = makeClient(port, "acc-B", "B");
  await Promise.all([a.whoami(), b.whoami()]);
  const dm = await a.openDm("acc-B");
  assert.equal(dm.ok, true);
  await a.send(dm.channelId!, "디엠 테스트");
  const got = await b.wait(3000);
  assert.deepEqual(got.items!.map((i) => i.text), ["디엠 테스트"]);
  assert.equal(got.items![0].channelKind, "dm");
  assert.equal((await a.listDms()).dms!.find((d) => d.peer === "acc-B")!.channelId, dm.channelId);
  a.close(); b.close();
  await new Promise((r) => setTimeout(r, 300));
});

test("서버·채널을 만들고 전체 공개 채널로 메시지를 주고받는다", async () => {
  const port = freshPort();
  const a = makeClient(port, "acc-A", "A");
  const b = makeClient(port, "acc-B", "B");
  await Promise.all([a.whoami(), b.whoami()]);
  const srv = await a.createServer("A서버");
  assert.equal(srv.ok, true);
  const ch = await a.createChannel(srv.serverId!, "논의방");
  assert.equal(ch.ok, true);
  assert.equal((await b.listServers()).servers!.find((s) => s.serverId === srv.serverId)!.name, "A서버");
  assert.equal((await b.listChannels(srv.serverId!)).channels![0].channelId, ch.channelId);
  await a.send(ch.channelId!, "서버글");
  const got = await b.wait(3000);
  assert.deepEqual(got.items!.map((i) => i.text), ["서버글"]);
  assert.equal(got.items![0].channelKind, "server");
  a.close(); b.close();
  await new Promise((r) => setTimeout(r, 300));
});
