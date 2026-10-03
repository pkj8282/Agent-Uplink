import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hub } from "../hub/server.js";
import { HubClient } from "./hubClient.js";
import { RoleStore } from "./roles.js";
import { AccountSession } from "./session.js";

function tmp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), "uplink-sess-")); }

async function startHub(tcpPort = 0, dataDir = tmp()) {
  const hub = new Hub({ tcpPort, httpPort: 0, dataDir, idleShutdownMs: 0 });
  await hub.startTcp();
  return { hub, port: hub.tcpAddress.port, dataDir };
}

/** 역할 세션 하나(= MCP 프로세스 하나). Hub는 이미 떠 있으므로 spawn하지 않는다. */
function session(port: number, roleDir: string, cwd = "C:\\Proj", env?: string) {
  const client = new HubClient({ port, hubEntry: "nonexistent-should-not-spawn.js" });
  return { client, s: new AccountSession(client, new RoleStore({ dataDir: roleDir, cwd, env })) };
}

async function until(cond: () => Promise<boolean>, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await cond()) return; await new Promise((r) => setTimeout(r, 20)); }
  throw new Error("조건 시간 초과");
}

test("선택 전에는 guard가 안내·목록을 주고, use 후에는 통과한다", async () => {
  const { hub, port } = await startHub();
  const { client, s } = session(port, tmp());
  const g = await s.guard();
  assert.match(g!, /use_account/);
  assert.match(g!, /아직 역할이 없습니다/);
  const r = await s.use("기획", "게임 기획 담당");
  assert.equal(r.ok, true);
  assert.match(r.text, /역할 '기획' 선택됨/);
  assert.match(r.text, /UPLINK_ACCOUNTS에 "기획=/);
  assert.equal(await s.guard(), null);
  const who = await client.whoami();
  assert.equal(who.name, "기획");
  assert.equal(who.description, "게임 기획 담당");
  client.close(); hub.stop();
});

test("재시작한 세션은 같은 역할로 같은 UUID에 복귀한다", async () => {
  const { hub, port } = await startHub();
  const roleDir = tmp();
  const one = session(port, roleDir);
  await one.s.use("구현");
  const uuid = one.s.selection!.uuid;
  one.client.close();
  const two = session(port, roleDir);
  await until(async () => (await two.s.use("구현")).ok);
  assert.equal(two.s.selection!.uuid, uuid);
  two.client.close(); hub.stop();
});

test("두 세션이 같은 역할을 고르면 뒤 세션은 거부되고 미선택으로 남는다", async () => {
  const { hub, port } = await startHub();
  const roleDir = tmp();
  const a = session(port, roleDir);
  const b = session(port, roleDir);
  assert.equal((await a.s.use("기획")).ok, true);
  const rb = await b.s.use("기획");
  assert.equal(rb.ok, false);
  assert.match(rb.text, /이미 다른 세션이 사용 중/);
  assert.match(rb.text, /기획 \[사용 중\]/);
  assert.equal(b.s.selection, null);
  a.client.close(); b.client.close(); hub.stop();
});

test("역할 전환 시 이전 역할이 비고, 전환 실패 시 기존 역할을 유지한다", async () => {
  const { hub, port } = await startHub();
  const roleDir = tmp();
  const a = session(port, roleDir);
  const holder = session(port, roleDir);
  await holder.s.use("검수");
  await a.s.use("기획");
  await a.s.use("구현"); // 전환
  assert.match(await a.s.listText(), /기획 \[비어 있음\]/);
  const fail = await a.s.use("검수"); // 사용 중 → 실패
  assert.equal(fail.ok, false);
  assert.equal(a.s.selection!.role, "구현");
  assert.equal((await a.client.whoami()).name, "구현");
  a.client.close(); holder.client.close(); hub.stop();
});

test("잘못된 역할 이름은 거부되고 env 고정 역할은 env UUID를 쓴다", async () => {
  const { hub, port } = await startHub();
  const { client, s } = session(port, tmp(), "C:\\Proj", "리드=lead-uuid-1");
  assert.equal((await s.use("a=b")).ok, false);
  const r = await s.use("리드");
  assert.equal(r.ok, true);
  assert.equal(s.selection!.uuid, "lead-uuid-1");
  assert.doesNotMatch(r.text, /UPLINK_ACCOUNTS에/); // 이미 env 고정
  assert.match(await s.listText(), /리드 \[사용 중\] \(env 고정\)/);
  client.close(); hub.stop();
});

test("UPLINK_ACCOUNT 고정 세션은 guard 없이 동작하고 역할 전환을 거부한다", async () => {
  const { hub, port } = await startHub();
  const client = new HubClient({ port, accountUuid: "pinned-1", accountName: "P", hubEntry: "nonexistent.js" });
  const s = new AccountSession(client, null, "pinned-1");
  assert.equal(await s.guard(), null);
  assert.equal(s.pinned, true);
  assert.equal((await client.whoami()).uuid, "pinned-1");
  assert.equal((await s.use("기획")).ok, false);
  client.close(); hub.stop();
});

test("Hub 재시작 후 다음 호출에서 같은 역할 계정으로 재로그인한다", async () => {
  const first = await startHub();
  const { client, s } = session(first.port, tmp());
  await s.use("기획");
  const uuid = s.selection!.uuid;
  first.hub.stop();
  const second = await startHub(first.port, first.dataDir); // 같은 포트·데이터로 재기동
  await until(async () => { try { return (await client.whoami()).uuid === uuid; } catch { return false; } });
  client.close(); second.hub.stop();
});

/** P1이 기획을 쓰던 중 Hub가 재시작되고, 그 사이 P2가 기획을 가져간 상황. */
async function takeover() {
  const first = await startHub();
  const roleDir = tmp();
  const p1 = session(first.port, roleDir);
  await p1.s.use("기획");
  first.hub.stop();
  const second = await startHub(first.port, first.dataDir);
  const p2 = session(first.port, roleDir);
  await until(async () => (await p2.s.use("기획")).ok);
  return { p1, p2, hub: second.hub };
}

test("Hub 재시작 사이 역할을 빼앗기면 다음 호출에서 선택이 해제되고 안내 후 다른 역할을 고를 수 있다", async () => {
  const { p1, p2, hub } = await takeover();
  await assert.rejects(p1.client.check(), /선택이 해제/);
  assert.equal(p1.s.selection, null);
  assert.match((await p1.s.guard())!, /'기획' 선택이 해제/);
  assert.equal((await p1.s.use("구현")).ok, true);
  p1.client.close(); p2.client.close(); hub.stop();
});

test("Hub 재시작 사이 역할을 빼앗겨도 곧바로 다른 역할을 고르는 use_account는 막히지 않는다", async () => {
  const { p1, p2, hub } = await takeover();
  const r = await p1.s.use("구현");
  assert.equal(r.ok, true);
  assert.equal((await p1.client.whoami()).name, "구현");
  p1.client.close(); p2.client.close(); hub.stop();
});
