// 받은편지함 격리(2026-11-20): 채널이 목록에서 빠지면 그 채널의 안 읽은 항목에 격리 태그를 붙인다.
// AI에게 줄 때만 거르고, 커서·압축·해제는 원본(격리 포함) 기준. 채널이 돌아오면 원래 순서로 나온다.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { startTestHub, TestClient, tempDir } from "./testing.js";

async function login(port: number, uuid: string, name = uuid) {
  const c = new TestClient(port);
  await c.ready();
  assert.equal((await c.req("login", { uuid, name })).ok, true);
  return c;
}
const texts = (r: any) => (r.items ?? []).map((i: any) => i.text);
async function admin(t: { port: number; dataDir: string }) {
  const token = fs.readFileSync(path.join(t.dataDir, "admin.key"), "utf8").trim();
  const c = new TestClient(t.port); await c.ready();
  return { c, req: (op: string, p: object = {}) => c.req(op, { token, ...p }) as Promise<any> };
}
const quarantine = async (adm: Awaited<ReturnType<typeof admin>>) => (await adm.req("admin_snapshot")).quarantine;

/** a·b 두 계정, b의 서버(sb)에 a도 참가, 채널 cb. */
async function setup(dataDir?: string) {
  const t = await startTestHub(dataDir ? { dataDir } : {});
  const a = await login(t.port, "a"), b = await login(t.port, "b");
  const sb = (await b.req("create_server", { name: "비서버" })).serverId as string;
  const cb = (await b.req("create_channel", { serverId: sb, name: "일반" })).channelId as string;
  await a.req("join_server", { serverId: sb });
  await a.req("check"); await b.req("check");
  const adm = await admin(t);
  return { t, a, b, sb, cb, adm };
}
const close = (s: { a: TestClient; b: TestClient; adm: { c: TestClient } }) => { s.a.close(); s.b.close(); s.adm.c.close(); };

test("deleted_channel_quarantined_then_restored_in_order: 지운 채널의 안 읽은 글은 격리 → 되살리면 원래 순서로 한 번만 나온다", async () => {
  const s = await setup();
  try {
    await s.b.req("send", { channelId: s.cb, text: "x1" });
    await s.b.req("send", { channelId: s.cb, text: "x2" });
    await s.b.req("send", { channelId: "lobby", text: "L1" });
    assert.equal((await s.adm.req("admin_delete_channel", { channelId: s.cb })).ok, true);
    const r1: any = await s.a.req("check");
    assert.deepEqual(texts(r1), ["L1"], "격리된 x1·x2는 안 보이고 뒤의 로비 글은 나온다");
    for (const it of r1.items) {
      assert.equal("quarantined" in it, false, "내부 표시는 AI에게 보내지 않는다");
      assert.equal("delivered" in it, false);
    }
    const q = await quarantine(s.adm);
    assert.equal(q.totalCount, 2);
    assert.ok(q.totalBytes > 0);
    assert.deepEqual(q.accounts.map((x: any) => x.account), ["a"], "영향받은 계정만");
    assert.deepEqual(q.accounts[0].items.map((i: any) => [i.preview, i.reason]), [["x1", "channel_removed"], ["x2", "channel_removed"]]);

    const item = (await s.adm.req("admin_snapshot")).trash.find((x: any) => x.kind === "channel");
    assert.equal((await s.adm.req("admin_restore_trash", { trashId: item.id })).ok, true);
    assert.deepEqual(texts(await s.a.req("check")), ["x1", "x2"], "되살리면 원래 순서로");
    assert.equal((await quarantine(s.adm)).totalCount, 0, "해제되면 격리에서 빠진다");
    await s.b.req("send", { channelId: "lobby", text: "L2" });
    assert.deepEqual(texts(await s.a.req("check")), ["L2"], "이미 준 L1·x1·x2는 다시 안 나온다");
    close(s);
  } finally { s.t.hub.stop(); }
});

test("wait_wakes_on_release: 기다리는 중에 채널이 돌아오면 격리 해제된 글로 깨운다", async () => {
  const s = await setup();
  try {
    await s.b.req("send", { channelId: s.cb, text: "w1" });
    await s.adm.req("admin_delete_channel", { channelId: s.cb });
    assert.deepEqual(texts(await s.a.req("check")), []);
    const waiting = s.a.req("wait", { timeoutMs: 10000 });
    const item = (await s.adm.req("admin_snapshot")).trash.find((x: any) => x.kind === "channel");
    await s.adm.req("admin_restore_trash", { trashId: item.id });
    assert.deepEqual(texts(await waiting), ["w1"]);
    close(s);
  } finally { s.t.hub.stop(); }
});

test("quarantine_survives_restart: 격리는 Hub를 다시 켜도 남고, 그 뒤 되살리면 나온다", async () => {
  const dir = tempDir("uplink-q-");
  const s = await setup(dir);
  await s.b.req("send", { channelId: s.cb, text: "r1" });
  await s.adm.req("admin_delete_channel", { channelId: s.cb });
  await s.b.req("send", { channelId: "lobby", text: "L1" });
  assert.deepEqual(texts(await s.a.req("check")), ["L1"]);
  close(s);
  s.t.hub.stop();
  const t2 = await startTestHub({ dataDir: dir });
  try {
    const a = await login(t2.port, "a"), adm = await admin(t2);
    assert.deepEqual(texts(await a.req("check")), [], "다시 켜도 L1을 또 주지 않고 격리도 그대로");
    assert.equal((await quarantine(adm)).totalCount, 1);
    const item = (await adm.req("admin_snapshot")).trash.find((x: any) => x.kind === "channel");
    await adm.req("admin_restore_trash", { trashId: item.id });
    assert.deepEqual(texts(await a.req("check")), ["r1"]);
    a.close(); adm.c.close();
  } finally { t2.hub.stop(); }
});

test("empty_trash_drops_quarantined: 휴지통을 비우면 되살릴 길이 없으므로 그 격리 항목은 지운다", async () => {
  const s = await setup();
  try {
    await s.b.req("send", { channelId: s.cb, text: "e1" });
    await s.adm.req("admin_delete_channel", { channelId: s.cb });
    assert.equal((await quarantine(s.adm)).totalCount, 1);
    await s.adm.req("admin_empty_trash");
    const q = await quarantine(s.adm);
    assert.equal(q.totalCount, 0);
    assert.deepEqual(q.accounts, [], "비면 그 계정 줄도 없다");
    await s.b.req("send", { channelId: "lobby", text: "L1" });
    assert.deepEqual(texts(await s.a.req("check")), ["L1"]);
    close(s);
  } finally { s.t.hub.stop(); }
});

test("admin_delete_partial_and_all: 관리 앱에서 일부·전체 삭제 — 지운 것은 되살려도 안 나온다", async () => {
  const s = await setup();
  try {
    for (const t of ["d1", "d2", "d3"]) await s.b.req("send", { channelId: s.cb, text: t });
    await s.adm.req("admin_delete_channel", { channelId: s.cb });
    const q1 = await quarantine(s.adm);
    const d2 = q1.accounts[0].items.find((i: any) => i.preview === "d2");
    const r1 = await s.adm.req("admin_quarantine_delete", { items: [{ account: "a", seq: d2.seq }] });
    assert.equal(r1.removed, 1);
    const q2 = await quarantine(s.adm);
    assert.deepEqual(q2.accounts[0].items.map((i: any) => i.preview), ["d1", "d3"]);
    assert.ok(q2.totalBytes < q1.totalBytes);
    assert.equal((await s.adm.req("admin_quarantine_delete", { all: true })).removed, 2);
    assert.equal((await quarantine(s.adm)).totalCount, 0);
    const item = (await s.adm.req("admin_snapshot")).trash.find((x: any) => x.kind === "channel");
    await s.adm.req("admin_restore_trash", { trashId: item.id });
    assert.deepEqual(texts(await s.a.req("check")), []);
    assert.equal((await s.adm.req("admin_quarantine_delete", {})).code, "quarantine_target_invalid", "대상 없는 요청은 거부");
    close(s);
  } finally { s.t.hub.stop(); }
});

test("startup_backlog: 시작 때 목록에 없는 채널 — 확실히 지워진 이 PC 채널은 버리고, 다른 PC 쪽은 격리", async () => {
  const dir = tempDir("uplink-q-");
  const t1 = await startTestHub({ dataDir: dir });
  const a1 = await login(t1.port, "a");
  await a1.req("check");
  a1.close();
  t1.hub.stop();
  const file = path.join(dir, "notifications", "a.jsonl");
  const base = { ts: Date.now(), channelKind: "server", from: "x", fromName: "x" };
  const lines = [
    { ...base, seq: 1, channelId: "11111111-2222-4333-8444-555555555555", channelLabel: "옛서버/지운채널", text: "gone" },
    { ...base, seq: 2, channelId: "r:space:chan", channelLabel: "원격/채널", text: "remote" },
    { ...base, seq: 3, channelId: "lobby", channelLabel: "main/lobby", text: "lobby" },
  ];
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const t2 = await startTestHub({ dataDir: dir });
  try {
    const a = await login(t2.port, "a"), adm = await admin(t2);
    assert.deepEqual(texts(await a.req("check")), ["lobby"]);
    const q = await quarantine(adm);
    assert.deepEqual(q.accounts[0].items.map((i: any) => [i.preview, i.reason]), [["remote", "startup_missing"]]);
    a.close(); adm.c.close();
  } finally { t2.hub.stop(); }
});

test("check_missing_fallback: check 때 채널이 없는 다른 PC 쪽 항목은 격리(마지막 안전장치)", async () => {
  const s = await setup();
  try {
    const hub = s.t.hub as any;
    hub.inbox.append("a", { ts: Date.now(), channelId: "m.peer.chan", channelKind: "server", channelLabel: "망/채널", from: "x", fromName: "x", text: "mesh" });
    hub.inbox.append("a", { ts: Date.now(), channelId: "lobby", channelKind: "server", channelLabel: "main/lobby", from: "x", fromName: "x", text: "L" });
    assert.deepEqual(texts(await s.a.req("check")), ["L"]);
    const q = await quarantine(s.adm);
    assert.deepEqual(q.accounts[0].items.map((i: any) => [i.preview, i.reason]), [["mesh", "check_missing"]]);
    close(s);
  } finally { s.t.hub.stop(); }
});

test("non_member_dropped_not_quarantined: 채널이 빠질 때 참가 안 한 계정의 쌓인 항목은 격리하지 않고 버린다", async () => {
  const s = await setup();
  try {
    const c = await login(s.t.port, "c");
    await c.req("check");
    const hub = s.t.hub as any;
    // 3.1.1 이전처럼 참가 안 한 c에게 쌓인 항목
    hub.inbox.append("c", { ts: Date.now(), channelId: s.cb, channelKind: "server", channelLabel: "비서버/일반", from: "b", fromName: "b", text: "old" });
    await s.adm.req("admin_delete_channel", { channelId: s.cb });
    const q = await quarantine(s.adm);
    assert.equal(q.accounts.some((x: any) => x.account === "c"), false);
    assert.deepEqual(texts(await c.req("check")), []);
    c.close(); close(s);
  } finally { s.t.hub.stop(); }
});

test("compact_keeps_quarantined: 압축은 원본 관점 — 격리 항목은 커서 뒤에 남아 지워지지 않는다", async () => {
  const s = await setup();
  try {
    await s.adm.req("admin_set_config", { patch: { inboxMaxBatch: 500 } });
    await s.b.req("send", { channelId: s.cb, text: "keep" });
    await s.adm.req("admin_delete_channel", { channelId: s.cb });
    for (let i = 0; i < 1100; i++) await s.b.req("send", { channelId: "lobby", text: `n${i}` });
    for (let i = 0; i < 4; i++) await s.a.req("check");
    assert.ok((s.t.hub as any).inbox.size("a") < 1000, "커서가 격리 항목 앞에 멈춰 있어도 전달된 항목은 압축된다");
    assert.equal((await quarantine(s.adm)).totalCount, 1);
    const item = (await s.adm.req("admin_snapshot")).trash.find((x: any) => x.kind === "channel");
    await s.adm.req("admin_restore_trash", { trashId: item.id });
    assert.deepEqual(texts(await s.a.req("check")), ["keep"]);
    close(s);
  } finally { s.t.hub.stop(); }
});

test("server_restore_wakes_waiter_after_members_back: 서버째 되살릴 때 기다리던 참가자도 받는다(참가자 명단이 돌아온 뒤 깨움)", async () => {
  const s = await setup();
  try {
    await s.b.req("send", { channelId: s.cb, text: "s1" });
    assert.equal((await s.adm.req("admin_delete_server", { serverId: s.sb })).ok, true);
    assert.deepEqual(texts(await s.a.req("check")), []);
    const waiting = s.a.req("wait", { timeoutMs: 10000 });
    const item = (await s.adm.req("admin_snapshot")).trash.find((x: any) => x.kind === "server");
    assert.equal((await s.adm.req("admin_restore_trash", { trashId: item.id })).ok, true);
    assert.deepEqual(texts(await waiting), ["s1"]);
    close(s);
  } finally { s.t.hub.stop(); }
});
