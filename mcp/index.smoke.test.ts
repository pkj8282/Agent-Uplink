import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.ts");

// 자식 MCP에 JSON-RPC 한 줄을 보내고 응답 한 건을 받는다(개행 구분 stdio).
function rpc(reqs: object[]): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", ENTRY], { stdio: ["pipe", "pipe", "ignore"] });
    const out: any[] = [];
    let buf = "";
    child.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) out.push(JSON.parse(line));
        if (out.length >= reqs.length) {
          child.kill();
          resolve(out);
        }
      }
    });
    child.on("error", reject);
    for (const r of reqs) child.stdin.write(JSON.stringify(r) + "\n");
  });
}

test("MCP는 tools/list에서 5개 툴을 노출한다", async () => {
  const out = await rpc([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } } },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  ]);
  const list = out.find((m) => m.id === 2);
  const names = list.result.tools.map((t: any) => t.name).sort();
  assert.deepEqual(names, ["check", "register", "send", "wait", "who"]);
});
