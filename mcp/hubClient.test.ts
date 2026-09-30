import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encodeFrame, FrameDecoder } from "../shared/framing.js";
import { HubClient } from "./hubClient.js";

const HUB_ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "hub", "index.ts");
const NODE_ARGS = ["--import", "tsx"];
let portSeq = 49200;
function freshPort(): number { return portSeq++; }
function tmpDir(): string { return fs.mkdtempSync(path.join(os.tmpdir(), "uplink-client-")); }

function makeClient(port: number): HubClient {
  process.env.UPLINK_DATA_DIR = tmpDir();
  // 0.1분(6초) 후 세션이 모두 떠나면 Hub가 스스로 종료 → 테스트 후 detached Hub 누수 방지.
  process.env.UPLINK_IDLE_MINUTES = "0.1";
  process.env.UPLINK_TCP_PORT = String(port);
  process.env.UPLINK_HTTP_PORT = String(port + 1000);
  return new HubClient({ port, hubEntry: HUB_ENTRY, nodeArgs: NODE_ARGS });
}

test("Hub가 없으면 자동으로 spawn해 연결한다", async () => {
  const port = freshPort();
  const c = makeClient(port);
  const r = await c.register("A");
  assert.equal(r.ok, true);
  assert.equal(r.name, "A");
  c.close();
  await new Promise((r) => setTimeout(r, 300));
});

test("두 클라이언트가 동시에 붙어도 Hub는 하나만 살아 서로 메시지를 주고받는다", async () => {
  const port = freshPort();
  const a = makeClient(port);
  const b = makeClient(port);
  const [ra, rb] = await Promise.all([a.register("A"), b.register("B")]); // 동시 spawn 경합
  assert.equal(ra.ok, true);
  assert.equal(rb.ok, true);
  await a.send("안녕 B", "B");
  const got = await b.wait(3000);
  assert.deepEqual(got.messages!.map((m) => m.text), ["안녕 B"]);
  a.close(); b.close();
  await new Promise((r) => setTimeout(r, 300));
});

test("포트를 Hub가 아닌 프로세스가 점유하면 명확히 실패한다", async () => {
  const port = freshPort();
  // 연결은 받아주되 매직/버전이 틀린 유효 프레임으로 응답하는 가짜 서버 →
  // handshake가 불일치를 감지해 5초 타임아웃이 아니라 즉시 명확히 실패해야 한다.
  const squatter = net.createServer((s) => {
    const dec = new FrameDecoder();
    s.on("data", (d) =>
      dec.push(d, (req: any) => s.write(encodeFrame({ ok: true, id: req.id, magic: "other", version: 0 }))),
    );
  });
  await new Promise<void>((res) => squatter.listen(port, "127.0.0.1", () => res()));
  const c = new HubClient({ port, hubEntry: HUB_ENTRY, nodeArgs: NODE_ARGS });
  await assert.rejects(() => c.register("A"), /Hub가 아닙|Agent-Uplink/);
  c.close();
  squatter.close();
});

test("연결이 끊겨도 다음 호출에서 재연결하고 이름을 유지한다", async () => {
  const port = freshPort();
  const c = makeClient(port);
  await c.register("A");
  c.dropConnectionForTest(); // 소켓 강제 종료
  const r = await c.who(); // 재연결 유발
  assert.ok(r.sessions!.some((s) => s.name === "A")); // 재등록으로 A 유지
  c.close();
  await new Promise((r) => setTimeout(r, 300));
});
