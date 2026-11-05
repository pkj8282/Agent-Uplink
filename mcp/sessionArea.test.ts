import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { Hub } from "../hub/server.js";
import { TEST_SECURE_DEPS, registerTestHub, seedLanguage, tempDir } from "../hub/testing.js";
import { HubClient } from "./hubClient.js";
import { RoleStore } from "./roles.js";
import { AccountSession } from "./session.js";

async function startHub() {
  const dataDir = tempDir("uplink-area-");
  seedLanguage(dataDir, "ko");
  const hub = new Hub({ tcpPort: 0, httpPort: 0, dataDir, idleShutdownMs: 0 });
  await hub.startTcp();
  await hub.secure(TEST_SECURE_DEPS);
  registerTestHub(hub.tcpAddress.port, dataDir);
  return { hub, port: hub.tcpAddress.port, dataDir };
}

function session(port: number, dataDir: string, roleDir: string) {
  const client = new HubClient({ port, dataDir, hubEntry: "nonexistent-should-not-spawn.js" });
  return { client, s: new AccountSession(client, new RoleStore({ dataDir: roleDir, cwd: "C:\\Proj" })) };
}

test("session_area_locked: 한 세션은 처음 고른 영역만 쓴다", async () => {
  const { hub, port, dataDir } = await startHub();
  hub.setConnStatusSource({ hasLiveConnection: () => true });
  const roleDir = tempDir("uplink-roles-");
  try {
    const a = session(port, dataDir, roleDir);
    assert.equal((await a.s.use("통신기획", undefined, "connection")).ok, true);
    const r = await a.s.use("기획");
    assert.equal(r.ok, false);
    assert.match(r.text, /한 세션은 한 영역만/);
    const b = session(port, dataDir, roleDir);
    assert.equal((await b.s.use("기획")).ok, true);
    const r2 = await b.s.use("통신구현", undefined, "connection");
    assert.equal(r2.ok, false);
    a.client.close(); b.client.close();
  } finally { hub.stop(); }
});

test("connection_role_needs_live_connection: 통신 연결이 없으면 연결 역할 선택 실패 문구", async () => {
  const { hub, port, dataDir } = await startHub();
  const roleDir = tempDir("uplink-roles-");
  try {
    const a = session(port, dataDir, roleDir);
    const r = await a.s.use("통신기획", undefined, "connection");
    assert.equal(r.ok, false);
    assert.match(r.text, /통신 서버에 연결돼 있지 않아/);
    assert.equal(a.s.selection, null);
    // 실패한 시도는 영역을 고정하지 않는다
    assert.equal((await a.s.use("기획")).ok, true);
    a.client.close();
  } finally { hub.stop(); }
});

test("local_only_listing_unchanged: 연결 역할이 없으면 목록에 연결 절이 없다", async () => {
  const { hub, port, dataDir } = await startHub();
  const roleDir = tempDir("uplink-roles-");
  try {
    const a = session(port, dataDir, roleDir);
    await a.s.use("기획");
    const text = await a.s.listText();
    assert.equal(text.includes("연결 계정"), false);
    assert.deepEqual(text.split("\n").length, 2);
    a.client.close();
  } finally { hub.stop(); }
});

test("roles_file_backward_compatible: 연결 역할은 하위 폴더에 — 기존 목록(로컬)은 그대로", async () => {
  const roleDir = tempDir("uplink-roles-");
  const store = new RoleStore({ dataDir: roleDir, cwd: "C:\\Proj" });
  store.resolve("기획");
  const conn = store.resolve("통신기획", "connection");
  assert.deepEqual(store.list().map((e) => e.role), ["기획"]);
  assert.deepEqual(store.list().map((e) => e.area), ["local"]);
  assert.deepEqual(store.list("connection").map((e) => [e.role, e.uuid, e.area]), [["통신기획", conn.uuid, "connection"]]);
  // 같은 이름이라도 영역이 다르면 다른 계정
  assert.notEqual(store.resolve("기획", "connection").uuid, store.resolve("기획").uuid);
  // 구버전 MCP가 읽는 최상위 폴더에는 로컬 역할 파일만 .json으로 남는다
  const fresh = new RoleStore({ dataDir: roleDir, cwd: "C:\\Proj" });
  assert.deepEqual(fresh.list().map((e) => e.role), ["기획"]);
  void fs;
});

test("connection_roles_listed_in_own_section: 연결 역할이 있으면 '연결 계정' 절로 따로", async () => {
  const { hub, port, dataDir } = await startHub();
  hub.setConnStatusSource({ hasLiveConnection: () => true });
  const roleDir = tempDir("uplink-roles-");
  try {
    const a = session(port, dataDir, roleDir);
    await a.s.use("통신기획", "원격 협업", "connection");
    const text = await a.s.listText();
    const idx = text.indexOf("연결 계정");
    assert.ok(idx > 0, text);
    assert.match(text.slice(idx), /- 통신기획 \[/);
    a.client.close();
  } finally { hub.stop(); }
});

test("remote_accounts_tagged_in_listing: 연결 계정의 계정 목록에서 원격 계정은 출처가 붙는다", async () => {
  const { startHubPair } = await import("../hub/testing.js");
  const p = await startHubPair();
  try {
    const a = session(p.A.port, p.A.dataDir, tempDir("uplink-roles-"));
    assert.equal((await a.s.use("통신기획", undefined, "connection")).ok, true);
    const b = session(p.B.port, p.B.dataDir, tempDir("uplink-roles-"));
    assert.equal((await b.s.use("통신구현", undefined, "connection")).ok, true);
    let text = "";
    for (let i = 0; i < 150 && !text.includes("[원격 · 팀 · 에이]"); i++) {
      text = (await b.s.accountsText()).text;
      if (!text.includes("[원격")) await new Promise((r) => setTimeout(r, 20));
    }
    assert.match(text, /\[원격 · 팀 · 에이\] /);
    a.client.close(); b.client.close();
  } finally { p.A.hub.stop(); p.B.hub.stop(); }
});
