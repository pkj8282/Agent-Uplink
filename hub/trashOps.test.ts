import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { encodeFrame, FrameDecoder } from "../shared/framing.js";
import { Hub } from "./server.js";
import { Response } from "../shared/protocol.js";

function tmp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), "uplink-tops-")); }

class Client {
  private sock: net.Socket;
  private dec = new FrameDecoder();
  private waiters = new Map<number, (r: Response) => void>();
  private id = 0;
  constructor(port: number) {
    this.sock = net.connect(port, "127.0.0.1");
    this.sock.on("data", (d) => this.dec.push(d, (r: Response) => this.waiters.get(r.id)?.(r)));
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

function trashMetas(dataDir: string): any[] {
  const d = path.join(dataDir, "trash");
  return fs.readdirSync(d).map((id) => JSON.parse(fs.readFileSync(path.join(d, id, "meta.json"), "utf8")));
}

/** 서버 1·채널 2(메시지 있음/없음) + 계정 A·B와 DM(메시지 있음)을 심는다. */
async function seed(port: number) {
  const a = new Client(port); await a.ready(); await a.req("login", { uuid: "aaaaaaaa-0000-4000-8000-000000000001", name: "A" });
  const b = new Client(port); await b.ready(); await b.req("login", { uuid: "bbbbbbbb-0000-4000-8000-000000000002", name: "B" });
  const srv = (await a.req("create_server", { name: "Main" })).serverId!;
  const ch1 = (await a.req("create_channel", { serverId: srv, name: "일반" })).channelId!;
  const ch2 = (await a.req("create_channel", { serverId: srv, name: "빈채널" })).channelId!;
  await a.req("send", { channelId: ch1, text: "채널 메시지" });
  const dm = (await a.req("open_dm", { peer: "B" })).channelId!;
  await a.req("send", { channelId: dm, text: "DM 메시지" });
  return { a, b, srv, ch1, ch2, dm, A: "aaaaaaaa-0000-4000-8000-000000000001", B: "bbbbbbbb-0000-4000-8000-000000000002" };
}

test("채널 삭제: 로그가 휴지통으로 이동, meta는 done·소속 서버 기록, 이후 send는 오류", async () => {
  const { hub, port, dataDir } = await startHub();
  const s = await seed(port);
  assert.equal((await s.a.req("delete_channel", { channelId: s.ch1 })).ok, true);
  assert.equal(fs.existsSync(path.join(dataDir, "servers", `${s.ch1}.jsonl`)), false);
  const [m] = trashMetas(dataDir);
  assert.equal(m.kind, "channel"); assert.equal(m.state, "done"); assert.equal(m.deletedBy, "mcp");
  assert.equal(m.serverId, s.srv); assert.equal(m.serverName, "Main");
  assert.deepEqual(m.files, [`${s.ch1}.jsonl`]);
  const r = await s.a.req("send", { channelId: s.ch1, text: "삭제 후" });
  assert.equal(r.ok, false); assert.match(r.error!, /채널이 없습니다/);
  assert.equal(fs.existsSync(path.join(dataDir, "servers", `${s.ch1}.jsonl`)), false); // 로그 재생성 없음
  s.a.close(); s.b.close(); hub.stop();
});

test("서버 삭제: 소속 채널 로그 전부가 항목 1개로(빈 채널 로그는 files에 없음)", async () => {
  const { hub, port, dataDir, token } = await startHub();
  const s = await seed(port);
  const admin = new Client(port); await admin.ready();
  assert.equal((await admin.req("admin_delete_server", { token, serverId: s.srv })).ok, true);
  const ms = trashMetas(dataDir);
  assert.equal(ms.length, 1);
  assert.equal(ms[0].kind, "server"); assert.equal(ms[0].deletedBy, "admin");
  assert.deepEqual(ms[0].channels.map((c: any) => c.name), ["일반", "빈채널"]);
  assert.deepEqual(ms[0].files, [`${s.ch1}.jsonl`]);
  admin.close(); s.a.close(); s.b.close(); hub.stop();
});

test("계정 삭제: account.json·DM 로그는 휴지통, 인박스는 영구 삭제, 상대 역색인 정리", async () => {
  const { hub, port, dataDir, token } = await startHub();
  const s = await seed(port);
  const admin = new Client(port); await admin.ready();
  assert.equal((await admin.req("admin_delete_account", { token, uuid: s.A })).ok, true);
  const [m] = trashMetas(dataDir);
  assert.equal(m.kind, "account"); assert.equal(m.account.uuid, s.A); assert.equal(m.name, "A");
  assert.deepEqual(m.dms, [{ channelId: s.dm, peer: s.B, label: "A-B" }]);
  assert.deepEqual([...m.files].sort(), [`${s.dm}.jsonl`, "account.json"].sort());
  assert.equal(fs.existsSync(path.join(dataDir, "notifications", `${s.A}.jsonl`)), false);
  assert.deepEqual((await s.b.req("list_dms")).dms, []);
  admin.close(); s.a.close(); s.b.close(); hub.stop();
});

test("시작 복구: state=deleting 항목은 재기동 시 마저 삭제되고, 삭제 중이던 계정은 되살아나지 않는다", async () => {
  const dataDir = tmp();
  {
    const { hub, port } = await startHub(dataDir);
    const s = await seed(port);
    s.a.close(); s.b.close(); hub.stop();
    // 크래시 흉내: 계정 삭제 저널만 쓰고 실제 삭제 전 중단
    const id = "1759500000000-account-0000abcd";
    fs.mkdirSync(path.join(dataDir, "trash", id), { recursive: true });
    fs.writeFileSync(path.join(dataDir, "trash", id, "meta.json"), JSON.stringify({
      v: 1, id, kind: "account", state: "deleting", deletedAt: 1759500000000, deletedBy: "admin", name: "A",
      account: { uuid: s.A }, dms: [{ channelId: s.dm, peer: s.B, label: "A-B" }], files: [],
    }));
  }
  const { hub, port, token } = await startHub(dataDir);
  const admin = new Client(port); await admin.ready();
  const snap = await admin.req("admin_snapshot", { token });
  assert.deepEqual(snap.snapshotAccounts!.map((a) => a.name), ["B"]);
  assert.deepEqual(snap.snapshotDms, []);
  const m = trashMetas(dataDir)[0];
  assert.equal(m.state, "done");
  assert.equal(m.files.includes("account.json"), true);
  admin.close(); hub.stop();
});
