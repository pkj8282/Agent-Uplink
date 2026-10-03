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

test("MCP v2는 tools/list에서 9개 툴을 노출한다", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "uplink-smoke-"));
  const out = await rpc([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } } },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  ], { UPLINK_ACCOUNT: "smoke-acc", UPLINK_DATA_DIR: dataDir });
  const list = out.find((m) => m.id === 2);
  const names = list.result.tools.map((t: any) => t.name).sort();
  assert.deepEqual(names, ["check", "list_accounts", "list_dms", "open_dm", "read", "send", "set_name", "wait", "whoami"].sort());
});
