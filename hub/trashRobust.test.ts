// 최종 리뷰 지적(C1·I1·I2·I3) 회귀 테스트: 휴지통 파일 손상·잠김·조작에도 Hub가 죽지 않고 데이터가 보존된다.
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { encodeFrame, FrameDecoder } from "../shared/framing.js";
import { Hub } from "./server.js";
import { Response } from "../shared/protocol.js";

function tmp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), "uplink-robust-")); }
const win = process.platform === "win32";
const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";

class Client {
  private sock: net.Socket;
  private dec = new FrameDecoder();
  private waiters = new Map<number, (r: Response) => void>();
  private id = 0;
  constructor(port: number) {
    this.sock = net.connect(port, "127.0.0.1");
    this.sock.on("data", (d) => this.dec.push(d, (r: Response) => this.waiters.get(r.id)?.(r)));
    this.sock.on("error", () => {});
  }
  ready(): Promise<void> { return new Promise((res) => this.sock.once("connect", () => res())); }
  req(op: string, params: object = {}): Promise<Response> {
    const id = ++this.id;
    return new Promise((resolve) => { this.waiters.set(id, resolve); this.sock.write(encodeFrame({ op, id, ...params })); });
  }
  close(): void { this.sock.destroy(); }
}

async function startHub(dataDir = tmp()) {
  const hub = new Hub({ tcpPort: 0, httpPort: 0, dataDir, idleShutdownMs: 0 });
  await hub.startTcp();
  return { hub, port: hub.tcpAddress.port, dataDir, token: fs.readFileSync(path.join(dataDir, "admin.key"), "utf8").trim() };
}

function trashIds(dataDir: string): string[] {
  return fs.readdirSync(path.join(dataDir, "trash"));
}
function readMeta(dataDir: string, id: string): any {
  return JSON.parse(fs.readFileSync(path.join(dataDir, "trash", id, "meta.json"), "utf8"));
}
function writeMeta(dataDir: string, id: string, m: object): void {
  fs.writeFileSync(path.join(dataDir, "trash", id, "meta.json"), JSON.stringify(m));
}

/** 다른 프로세스가 파일을 삭제 공유 없이 열어 둔다(백신·백업 도구 흉내). 반환된 함수로 해제. */
async function lockFile(file: string, seconds: number): Promise<() => Promise<void>> {
  const ps = spawn("powershell.exe", ["-NoProfile", "-Command",
    `$f=[System.IO.File]::Open('${file}','Open','Read','Read'); Write-Output locked; Start-Sleep ${seconds}; $f.Close()`]);
  await new Promise<void>((r) => ps.stdout.once("data", () => r()));
  return () => new Promise<void>((r) => { if (ps.exitCode !== null) r(); else { ps.once("exit", () => r()); ps.kill(); } });
}

async function seedChannel(port: number) {
  const a = new Client(port); await a.ready(); await a.req("login", { uuid: A, name: "Alice" });
  const srv = (await a.req("create_server", { name: "Main" })).serverId!;
  const ch = (await a.req("create_channel", { serverId: srv, name: "x" })).channelId!;
  await a.req("send", { channelId: ch, text: "hi" });
  return { a, srv, ch };
}

test("C1: account.json이 손상된 항목은 복원 시 trash_missing·손상 표시, Hub는 살아 있고 재시작도 된다", async () => {
  const { hub, port, dataDir, token } = await startHub();
  const a = new Client(port); await a.ready(); await a.req("login", { uuid: A, name: "Alice" });
  const admin = new Client(port); await admin.ready();
  await admin.req("admin_delete_account", { token, uuid: A });
  const id = trashIds(dataDir)[0];
  fs.writeFileSync(path.join(dataDir, "trash", id, "account.json"), "{ broken");
  const r = await admin.req("admin_restore_trash", { token, trashId: id });
  assert.equal(r.code, "trash_missing");
  assert.equal((await admin.req("hello")).ok, true);
  assert.equal((await admin.req("admin_snapshot", { token })).trash![0].intact, false);
  assert.equal(readMeta(dataDir, id).state, "done"); // restoring으로 남지 않음
  a.close(); admin.close(); hub.stop();
  const again = await startHub(dataDir); // 재시작 가능
  again.hub.stop();
});

test("C1: meta 일부(serverName)가 지워진 항목은 trash_missing, Hub는 죽지 않는다", async () => {
  const { hub, port, dataDir, token } = await startHub();
  const s = await seedChannel(port);
  const admin = new Client(port); await admin.ready();
  await admin.req("admin_delete_channel", { token, channelId: s.ch });
  const id = trashIds(dataDir)[0];
  const m = readMeta(dataDir, id); delete m.serverName; writeMeta(dataDir, id, m);
  assert.equal((await admin.req("admin_restore_trash", { token, trashId: id })).code, "trash_missing");
  assert.equal((await admin.req("hello")).ok, true);
  s.a.close(); admin.close(); hub.stop();
});

test("I2: meta의 채널 id에 경로 조작이 있으면 거부하고 데이터 폴더 밖에 파일을 만들지 않는다", async () => {
  const { hub, port, dataDir, token } = await startHub();
  const s = await seedChannel(port);
  const admin = new Client(port); await admin.ready();
  await admin.req("admin_delete_channel", { token, channelId: s.ch });
  const id = trashIds(dataDir)[0];
  const m = readMeta(dataDir, id); m.channels = [{ id: "../../escaped", name: "x" }]; m.files = []; writeMeta(dataDir, id, m);
  assert.equal((await admin.req("admin_restore_trash", { token, trashId: id })).code, "trash_missing");
  await s.a.req("send", { channelId: "../../escaped", text: "x" });
  assert.equal(fs.existsSync(path.join(dataDir, "..", "escaped.jsonl")), false);
  const m2 = readMeta(dataDir, id); m2.channels = [{ id: s.ch, name: "x" }]; m2.account = { uuid: "../evil" }; m2.kind = "account"; writeMeta(dataDir, id, m2);
  assert.equal((await admin.req("admin_restore_trash", { token, trashId: id })).code, "trash_missing");
  s.a.close(); admin.close(); hub.stop();
});

test("C1: 로그 파일이 잠겨 있으면 삭제는 io_error로 실패하고 Hub는 살아 있으며, 잠금이 풀린 뒤 다시 삭제하면 항목 1개로 끝난다", { skip: !win }, async () => {
  const { hub, port, dataDir, token } = await startHub();
  const s = await seedChannel(port);
  const admin = new Client(port); await admin.ready();
  const release = await lockFile(path.join(dataDir, "servers", `${s.ch}.jsonl`), 20);
  const r = await admin.req("admin_delete_channel", { token, channelId: s.ch });
  assert.equal(r.ok, false);
  assert.equal(r.code, "io_error");
  assert.equal((await admin.req("hello")).ok, true);
  await release();
  const r2 = await admin.req("admin_delete_channel", { token, channelId: s.ch });
  assert.equal(r2.ok, true, r2.error);
  const ids = trashIds(dataDir);
  assert.equal(ids.length, 1);
  assert.equal(readMeta(dataDir, ids[0]).state, "done");
  assert.equal(fs.existsSync(path.join(dataDir, "servers", `${s.ch}.jsonl`)), false);
  s.a.close(); admin.close(); hub.stop();
});

test("C1: 시작 복구 중 파일이 잠겨 있어도 Hub는 켜지고, 그 항목만 다음 기회로 미룬다", { skip: !win }, async () => {
  const dataDir = tmp();
  let ch = "";
  {
    const { hub, port } = await startHub(dataDir);
    const s = await seedChannel(port); ch = s.ch;
    s.a.close(); hub.stop();
  }
  const id = "1759500000000-channel-0000c0de";
  fs.mkdirSync(path.join(dataDir, "trash", id));
  writeMeta(dataDir, id, { v: 1, id, kind: "channel", state: "deleting", deletedAt: 1759500000000, deletedBy: "admin", name: "x",
    serverId: JSON.parse(fs.readFileSync(path.join(dataDir, "servers", "index.json"), "utf8")) && Object.keys(JSON.parse(fs.readFileSync(path.join(dataDir, "servers", "index.json"), "utf8")))[0],
    serverName: "Main", channels: [{ id: ch, name: "x" }], files: [] });
  const release = await lockFile(path.join(dataDir, "servers", `${ch}.jsonl`), 20);
  let started: Awaited<ReturnType<typeof startHub>> | null = null;
  try {
    started = await startHub(dataDir); // 던지면 실패
  } finally {
    await release();
  }
  started!.hub.stop();
  const after = await startHub(dataDir); // 잠금 해제 뒤 재시작하면 마무리된다
  assert.equal(readMeta(dataDir, id).state, "done");
  assert.equal(fs.existsSync(path.join(dataDir, "servers", `${ch}.jsonl`)), false);
  after.hub.stop();
});

test("C1: 실행 중 복원이 restoring 상태로 남은 항목은 다시 복원하면 이어서 마무리된다", async () => {
  const { hub, port, dataDir, token } = await startHub();
  const s = await seedChannel(port);
  const admin = new Client(port); await admin.ready();
  await admin.req("admin_delete_channel", { token, channelId: s.ch });
  const id = trashIds(dataDir)[0];
  const m = readMeta(dataDir, id); m.state = "restoring"; m.plan = { serverName: "Main", channelNames: { [s.ch]: "x" } }; writeMeta(dataDir, id, m);
  const r = await admin.req("admin_restore_trash", { token, trashId: id });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual((await s.a.req("read", { channelId: s.ch })).messages!.map((x) => x.text), ["hi"]);
  s.a.close(); admin.close(); hub.stop();
});

test("I1: 일부만 복원된 계정이 다시 삭제된 뒤 그 항목을 복원해도 유령 계정이 생기지 않고 원래 이름이 돌아온다", async () => {
  const { hub, port, dataDir, token } = await startHub();
  const a = new Client(port); await a.ready(); await a.req("login", { uuid: A, name: "Alice" });
  const b = new Client(port); await b.ready(); await b.req("login", { uuid: B, name: "Bob" });
  await a.req("open_dm", { peer: "Bob" }); await a.req("send", { channelId: (await a.req("open_dm", { peer: "Bob" })).channelId!, text: "옛 DM" });
  const admin = new Client(port); await admin.ready();
  await admin.req("admin_delete_account", { token, uuid: A }); // T1: 옛 DM 포함
  const t1 = trashIds(dataDir)[0];
  const a2 = new Client(port); await a2.ready(); await a2.req("login", { uuid: A, name: "Alice" });
  await a2.req("send", { channelId: (await a2.req("open_dm", { peer: "Bob" })).channelId!, text: "새 DM" });
  const r1 = await admin.req("admin_restore_trash", { token, trashId: t1 });
  assert.equal(r1.restored!.dmsLeft, 1); // 같은 쌍에 새 DM이 있어 옛 DM은 남는다
  a2.close();
  await admin.req("admin_delete_account", { token, uuid: A }); // T2
  const r2 = await admin.req("admin_restore_trash", { token, trashId: t1 });
  assert.equal(r2.ok, true, r2.error);
  const names = (await admin.req("admin_snapshot", { token })).snapshotAccounts!.map((x) => x.name).sort();
  assert.deepEqual(names, ["Alice", "Bob"]); // uuid 앞 8자 유령 계정 없음
  a.close(); b.close(); admin.close(); hub.stop();
});

test("I3: servers/index.json 손상 뒤 두 번째 기동에서도 서버 로그를 고아로 옮기지 않는다", async () => {
  const dataDir = tmp();
  let ch = "";
  {
    const { hub, port } = await startHub(dataDir);
    const s = await seedChannel(port); ch = s.ch;
    s.a.close(); hub.stop();
  }
  fs.writeFileSync(path.join(dataDir, "servers", "index.json"), "{손상");
  (await startHub(dataDir)).hub.stop(); // 1회차: 백업 후 빈 상태
  (await startHub(dataDir)).hub.stop(); // 2회차: 백업 파일이 남아 있는 한 정리 건너뜀
  assert.equal(fs.existsSync(path.join(dataDir, "servers", `${ch}.jsonl`)), true);
  assert.deepEqual(trashIds(dataDir), []);
});
