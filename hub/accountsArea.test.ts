import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { startTestHub, TestClient } from "./testing.js";

async function client(port: number): Promise<TestClient> {
  const c = new TestClient(port);
  await c.ready();
  return c;
}

test("connection_login_requires_live_connection: 통신 연결이 없으면 새 연결 계정 로그인 거부, 재로그인(resume)은 허용", async () => {
  const { hub, port } = await startTestHub();
  try {
    const c = await client(port);
    assert.equal((await c.req("login", { uuid: "conn-1", area: "connection" })).code, "connection_unavailable");
    hub.setConnStatusSource({ hasLiveConnection: () => true });
    assert.equal((await c.req("login", { uuid: "conn-1", area: "connection" })).ok, true);
    const list = await c.req("list_accounts");
    assert.equal(list.accounts?.find((a) => a.uuid === "conn-1")?.area, "connection");
    hub.setConnStatusSource({ hasLiveConnection: () => false });
    const c2 = await client(port);
    assert.equal((await c2.req("login", { uuid: "conn-1", area: "connection", resume: true })).ok, true);
    const st = await c2.req("account_status", { uuids: ["conn-1"] });
    assert.equal(st.statuses?.[0].area, "connection");
    c.close(); c2.close();
  } finally { hub.stop(); }
});

test("area_mismatch_both_ways: 다른 영역 계정으로는 로그인할 수 없다", async () => {
  const { hub, port } = await startTestHub();
  try {
    hub.setConnStatusSource({ hasLiveConnection: () => true });
    const c = await client(port);
    assert.equal((await c.req("login", { uuid: "local-1" })).ok, true);
    assert.equal((await c.req("login", { uuid: "conn-1", area: "connection" })).ok, true);
    const d = await client(port);
    assert.equal((await d.req("login", { uuid: "local-1", area: "connection" })).code, "area_mismatch");
    assert.equal((await d.req("login", { uuid: "conn-1" })).code, "area_mismatch");
    c.close(); d.close();
  } finally { hub.stop(); }
});

test("local_account_file_unchanged: 로컬 계정 파일에는 area 필드가 생기지 않는다", async () => {
  const { hub, port, dataDir } = await startTestHub();
  try {
    hub.setConnStatusSource({ hasLiveConnection: () => true });
    const c = await client(port);
    await c.req("login", { uuid: "local-2" });
    const d = await client(port);
    await d.req("login", { uuid: "conn-2", area: "connection" });
    const local = JSON.parse(fs.readFileSync(path.join(dataDir, "accounts", "local-2.json"), "utf8"));
    assert.equal("area" in local, false);
    const conn = JSON.parse(fs.readFileSync(path.join(dataDir, "accounts", "conn-2.json"), "utf8"));
    assert.equal(conn.area, "connection");
    c.close(); d.close();
  } finally { hub.stop(); }
});

test("local_and_connection_dm_both_ways: 로컬 계정 ↔ 연결 계정 DM은 양쪽에서 된다", async () => {
  const { hub, port } = await startTestHub();
  try {
    hub.setConnStatusSource({ hasLiveConnection: () => true });
    const l = await client(port);
    await l.req("login", { uuid: "loc" });
    const k = await client(port);
    await k.req("login", { uuid: "con", area: "connection" });
    const dm = await l.req("open_dm", { peer: "con" });
    assert.equal(dm.ok, true);
    assert.equal((await l.req("send", { channelId: dm.channelId, text: "로컬→연결" })).ok, true);
    assert.equal((await k.req("check")).items?.[0].text, "로컬→연결");
    const back = await k.req("open_dm", { peer: "loc" });
    assert.equal(back.channelId, dm.channelId);
    assert.equal((await k.req("send", { channelId: back.channelId, text: "연결→로컬" })).ok, true);
    assert.equal((await l.req("check")).items?.[0].text, "연결→로컬");
    l.close(); k.close();
  } finally { hub.stop(); }
});
