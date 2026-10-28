import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { encodeFrame, FrameDecoder } from "../shared/framing.js";
import { startTestHub, TestClient, tempDir } from "./testing.js";
import { DmStore } from "./dm.js";
import { ServerStore } from "./servers.js";

function tmp(): string { return tempDir("uplink-rec-"); }

async function client(port: number): Promise<(op: string, p?: object) => Promise<any>> {
  const c = new TestClient(port); await c.ready();
  return (op, p = {}) => c.req(op, p);
}

async function boot(dataDir: string) {
  const { hub, port } = await startTestHub({ dataDir });
  return { hub, port };
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

// ── v2.1.3 RT43: 손상 index.json의 백업이 실패하면 그 실행 동안 덮어쓰지 않는다(설계 ⑨) ──
test("RT43: dm/index.json 손상 + 백업 실패 → DM을 새로 만들어도 원본 바이트가 그대로", () => {
  const dir = tempDir("uplink-rt43-");
  fs.mkdirSync(path.join(dir, "dm"), { recursive: true });
  const f = path.join(dir, "dm", "index.json");
  fs.writeFileSync(f, "{손상된 원본");
  const dm = new DmStore({ dir, backup: () => null });
  assert.equal(dm.corrupt, true);
  assert.equal(dm.saveBlocked, true);
  const rec = dm.create("u1", "u2", "A↔B");
  assert.equal(dm.get(rec.channelId)?.label, "A↔B"); // 메모리로는 동작
  assert.equal(fs.readFileSync(f, "utf8"), "{손상된 원본");
});

test("RT43: servers/index.json 손상 + 백업 실패 → 서버를 만들어도 원본 바이트가 그대로", () => {
  const dir = tempDir("uplink-rt43-");
  fs.mkdirSync(path.join(dir, "servers"), { recursive: true });
  const f = path.join(dir, "servers", "index.json");
  fs.writeFileSync(f, "{손상된 원본");
  const s = new ServerStore({ dir, backup: () => null });
  assert.equal(s.saveBlocked, true);
  assert.equal(s.sweepBlocked, true);
  s.createServer("Main");
  assert.equal(fs.readFileSync(f, "utf8"), "{손상된 원본");
});

test("RT43: 백업이 되면 지금처럼 저장한다(saveBlocked false)", () => {
  const dir = tempDir("uplink-rt43-");
  fs.mkdirSync(path.join(dir, "dm"), { recursive: true });
  fs.writeFileSync(path.join(dir, "dm", "index.json"), "{x");
  const dm = new DmStore({ dir });
  assert.equal(dm.saveBlocked, false);
  dm.create("u1", "u2", "L");
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(path.join(dir, "dm", "index.json"), "utf8"))).length, 1);
});

test("RT43 재공격: 백업 rename이 막혀도(다른 프로그램이 잡음 등) 손상 원본 내용이 어딘가(.corrupt-* 또는 원래 파일)에 남는다", () => {
  const dir = tempDir("uplink-rt43-");
  fs.mkdirSync(path.join(dir, "dm"), { recursive: true });
  const f = path.join(dir, "dm", "index.json");
  fs.writeFileSync(f, "{손상된 원본");
  const orig = fs.renameSync;
  fs.renameSync = ((a: fs.PathLike, b: fs.PathLike) => {
    if (String(b).includes(".corrupt-")) throw Object.assign(new Error("EBUSY"), { code: "EBUSY" });
    return orig(a, b);
  }) as typeof fs.renameSync;
  try {
    new DmStore({ dir }).create("u1", "u2", "L");
  } finally {
    fs.renameSync = orig;
  }
  const kept = fs.readdirSync(path.join(dir, "dm")).filter((n) => n.startsWith("index.json"))
    .some((n) => fs.readFileSync(path.join(dir, "dm", n), "utf8") === "{손상된 원본");
  assert.equal(kept, true);
});
