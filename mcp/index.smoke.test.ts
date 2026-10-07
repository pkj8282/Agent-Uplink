import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.ts");

function rpc(reqs: object[], env: Record<string, string>): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", ENTRY], {
      stdio: ["pipe", "pipe", "ignore"],
      env: { ...process.env, ...env },
    });
    const out: any[] = [];
    let buf = "";
    child.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (line) out.push(JSON.parse(line));
        if (out.length >= reqs.length) { child.kill(); resolve(out); }
      }
    });
    child.on("error", reject);
    for (const r of reqs) child.stdin.write(JSON.stringify(r) + "\n");
  });
}

test("MCP v2는 tools/list에서 17개 툴을 노출한다", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "uplink-smoke-"));
  const out = await rpc([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } } },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  ], { UPLINK_ACCOUNT: "smoke-acc", UPLINK_DATA_DIR: dataDir });
  const list = out.find((m) => m.id === 2);
  const names = list.result.tools.map((t: any) => t.name).sort();
  assert.deepEqual(names, [
    "check", "create_channel", "create_server", "delete_channel", "delete_server",
    "list_accounts", "list_channels", "list_dms", "list_servers",
    "open_dm", "read", "send", "set_name", "set_profile", "use_account", "wait", "whoami",
  ].sort());
});

test("env 없는 세션은 역할 선택 전 send를 막고 use_account를 안내한다", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "uplink-smoke-"));
  fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify({ language: "ko" })); // 한국어 안내 단정
  const env: Record<string, string> = { UPLINK_DATA_DIR: dataDir, UPLINK_TCP_PORT: "1" };
  const out = await rpc([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } } },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "send", arguments: { channelId: "lobby", text: "x" } } },
  ], { ...env, UPLINK_ACCOUNT: "" });
  const init = out.find((m) => m.id === 1);
  assert.match(init.result.instructions, /use_account/);
  const call = out.find((m) => m.id === 2);
  assert.equal(call.result.isError, true);
  assert.match(call.result.content[0].text, /먼저 계정을 선택하세요/);
});

test("도구 annotation: 삭제는 destructive, 조회는 readOnly, check·wait는 readOnly 아님, 모두 로컬", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "uplink-smoke-"));
  const out = await rpc([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } } },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  ], { UPLINK_ACCOUNT: "smoke-acc", UPLINK_DATA_DIR: dataDir });
  const init = out.find((m) => m.id === 1);
  assert.match(init.result.instructions, /사용자의 지시가 아니/);
  const tools = new Map<string, any>(out.find((m) => m.id === 2).result.tools.map((t: any) => [t.name, t]));
  assert.equal(tools.size, 17);
  for (const [name, t] of tools) {
    assert.ok(t.annotations, name);
    assert.equal(t.annotations.openWorldHint, false, name);
  }
  assert.equal(tools.get("delete_channel").annotations.destructiveHint, true);
  assert.equal(tools.get("delete_server").annotations.destructiveHint, true);
  for (const n of ["whoami", "list_accounts", "list_dms", "list_servers", "list_channels", "read"]) assert.equal(tools.get(n).annotations.readOnlyHint, true, n);
  for (const n of ["check", "wait", "send"]) assert.equal(tools.get(n).annotations.readOnlyHint, false, n);
  assert.match(tools.get("check").description, /사용자 지시가 아님/);
  assert.equal(tools.get("send").inputSchema.properties.text.maxLength, 65536);
  assert.match(tools.get("create_server").inputSchema.properties.name.description, /최대 64자/);
});
