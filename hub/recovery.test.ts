import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { encodeFrame, FrameDecoder } from "../shared/framing.js";
import { Hub } from "./server.js";

function tmp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), "uplink-rec-")); }

function client(port: number): Promise<(op: string, p?: object) => Promise<any>> {
  return new Promise((resolve) => {
    const sock = net.connect(port, "127.0.0.1");
    const dec = new FrameDecoder(); const waiters = new Map<number, (r: any) => void>(); let id = 0;
    sock.on("data", (d) => dec.push(d, (r: any) => waiters.get(r.id)?.(r)));
    sock.once("connect", () => resolve((op, p = {}) => new Promise((res) => { const i = ++id; waiters.set(i, res); sock.write(encodeFrame({ op, id: i, ...p })); })));
  });
}

async function boot(dataDir: string) {
  const hub = new Hub({ tcpPort: 0, httpPort: 0, dataDir, idleShutdownMs: 0 });
  await hub.startTcp();
  return { hub, port: hub.tcpAddress.port };
}

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";

test("dm/index.json이 손상되면 원본을 .corrupt-로 보존하고 계정 역색인으로 재구성해 이전 대화가 이어진다", async () => {
  const dataDir = tmp();
  let dm = "";
  {
    const { hub, port } = await boot(dataDir);
    const a = await client(port); await a("login", { uuid: A, name: "A" });
    const b = await client(port); await b("login", { uuid: B, name: "B" });
    dm = (await a("open_dm", { peer: "B" })).channelId;
    await a("send", { channelId: dm, text: "이전 대화" });
    hub.stop();
  }
  fs.writeFileSync(path.join(dataDir, "dm", "index.json"), "{손상");
  const { hub, port } = await boot(dataDir);
  const a = await client(port); await a("login", { uuid: A });
  assert.deepEqual((await a("list_dms")).dms.map((d: any) => d.channelId), [dm]);
  assert.deepEqual((await a("read", { channelId: dm })).messages.map((m: any) => m.text), ["이전 대화"]);
  assert.equal((await a("open_dm", { peer: "B" })).channelId, dm); // 새 채널을 만들지 않음
  assert.equal(fs.readdirSync(path.join(dataDir, "dm")).some((f) => f.startsWith("index.json.corrupt-")), true);
  hub.stop();
});

test("v2.0.0에서 남은 고아 로그는 첫 기동 때 orphan 항목으로 옮겨지고 정상 로그는 그대로", async () => {
  const dataDir = tmp();
  let ch = "";
  {
    const { hub, port } = await boot(dataDir);
    const a = await client(port); await a("login", { uuid: A, name: "A" });
    const srv = (await a("create_server", { name: "S" })).serverId;
    ch = (await a("create_channel", { serverId: srv, name: "c" })).channelId;
    await a("send", { channelId: ch, text: "살아있음" });
    hub.stop();
  }
  const ghost = "cccccccc-0000-4000-8000-000000000003";
  fs.writeFileSync(path.join(dataDir, "servers", `${ghost}.jsonl`), "{}\n");
  fs.writeFileSync(path.join(dataDir, "dm", `${ghost}.jsonl`), "{}\n");
  fs.writeFileSync(path.join(dataDir, "servers", "notes.jsonl"), "x"); // uuid 형식 아님 → 건드리지 않음
  const { hub } = await boot(dataDir);
  const items = fs.readdirSync(path.join(dataDir, "trash")).map((id) => JSON.parse(fs.readFileSync(path.join(dataDir, "trash", id, "meta.json"), "utf8")));
  assert.deepEqual(items.map((m) => [m.kind, m.name, m.state]).sort(), [["orphan", `dm/${ghost}.jsonl`, "done"], ["orphan", `servers/${ghost}.jsonl`, "done"]]);
  assert.equal(fs.existsSync(path.join(dataDir, "servers", `${ch}.jsonl`)), true);
  assert.equal(fs.existsSync(path.join(dataDir, "servers", "notes.jsonl")), true);
  hub.stop();
});

test("servers/index.json이 손상되면 .corrupt-로 보존하고 서버 로그 고아 정리는 건너뛴다", async () => {
  const dataDir = tmp();
  let ch = "";
  {
    const { hub, port } = await boot(dataDir);
    const a = await client(port); await a("login", { uuid: A, name: "A" });
    const srv = (await a("create_server", { name: "S" })).serverId;
    ch = (await a("create_channel", { serverId: srv, name: "c" })).channelId;
    await a("send", { channelId: ch, text: "m" });
    hub.stop();
  }
  fs.writeFileSync(path.join(dataDir, "servers", "index.json"), "{손상");
  const { hub } = await boot(dataDir);
  assert.equal(fs.existsSync(path.join(dataDir, "servers", `${ch}.jsonl`)), true);
  assert.equal(fs.readdirSync(path.join(dataDir, "servers")).some((f) => f.startsWith("index.json.corrupt-")), true);
  assert.deepEqual(fs.readdirSync(path.join(dataDir, "trash")), []);
  hub.stop();
});
