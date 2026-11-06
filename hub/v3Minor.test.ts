import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { startTestHub, TestClient } from "./testing.js";
import { MAX_READ_LIMIT } from "../shared/protocol.js";

test("read_limit_capped_by_hub: read limit은 Hub가 직접 500으로 자른다(v3 Minor ②)", async () => {
  const t = await startTestHub();
  try {
    const c = new TestClient(t.port);
    await c.ready();
    assert.equal((await c.req("login", { uuid: "reader" })).ok, true);
    for (let i = 1; i <= 600; i++) (t.hub as any).channels.append("lobby", "w", "w", `m${i}`);
    const r: any = await c.req("read", { channelId: "lobby", limit: 100000 });
    assert.equal(r.ok, true);
    assert.equal(MAX_READ_LIMIT, 500);
    assert.equal(r.messages.length, 500);
    assert.equal(r.messages.at(-1).text, "m600");
    c.close();
  } finally { t.hub.stop(); }
});

test("snapshot_reports_save_blocked: 저장을 멈춘 색인 파일을 관리 스냅샷에 알린다(v3 Minor ①)", async () => {
  const t = await startTestHub();
  try {
    const token = fs.readFileSync(path.join(t.dataDir, "admin.key"), "utf8").trim();
    const c = new TestClient(t.port);
    await c.ready();
    assert.deepEqual(((await c.req("admin_snapshot", { token })) as any).saveBlocked, []);
    (t.hub as any).servers.saveBlocked = true;
    assert.deepEqual(((await c.req("admin_snapshot", { token })) as any).saveBlocked, ["servers/index.json"]);
    (t.hub as any).dm.saveBlocked = true;
    assert.deepEqual(((await c.req("admin_snapshot", { token })) as any).saveBlocked, ["dm/index.json", "servers/index.json"]);
    c.close();
  } finally { t.hub.stop(); }
});
