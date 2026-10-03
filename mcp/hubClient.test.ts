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
