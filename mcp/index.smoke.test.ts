import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { startTestHub } from "../hub/testing.js";

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
  assert.match(init.result.instructions, /not the user's instructions/); // 언어 미선택(N/A) = 영어
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
  assert.match(tools.get("check").description, /not user instructions/); // N/A = 영어
  assert.equal(tools.get("send").inputSchema.properties.text.maxLength, 65536);
  assert.match(tools.get("create_server").inputSchema.properties.name.description, /max 64 characters/);
});

test("언어 미선택(N/A)이면 instructions·도구 설명·안내가 영어이고 버전은 package.json과 같다", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "uplink-smoke-"));
  const out = await rpc([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } } },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "send", arguments: { channelId: "lobby", text: "x" } } },
  ], { UPLINK_DATA_DIR: dataDir, UPLINK_TCP_PORT: "1", UPLINK_ACCOUNT: "" });
  const init = out.find((m) => m.id === 1);
  assert.equal(init.result.serverInfo.version, JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
  const hangul = (t: string) => [...t].some((ch) => { const c = ch.codePointAt(0)!; return c >= 0xac00 && c <= 0xd7a3; });
  assert.equal(hangul(init.result.instructions), false);
  assert.equal(hangul(JSON.stringify(out.find((m) => m.id === 2).result.tools)), false);
  const call = out.find((m) => m.id === 3);
  assert.equal(call.result.isError, true);
  assert.match(call.result.content[0].text, /Select an account first/);
});

test("호스트가 입력(stdin)을 닫으면 MCP 프로세스가 스스로 끝난다(고아 프로세스가 Hub 연결·역할을 붙잡지 않게)", async () => {
  const { hub, port, dataDir } = await startTestHub();
  const child = spawn(process.execPath, ["--import", "tsx", ENTRY], {
    stdio: ["pipe", "pipe", "ignore"],
    env: { ...process.env, UPLINK_DATA_DIR: dataDir, UPLINK_TCP_PORT: String(port), UPLINK_ACCOUNT: "", UPLINK_PROJECT_DIR: dataDir },
  });
  const exited = new Promise<number | null>((r) => child.once("exit", (code) => r(code)));
  let buf = "";
  const replies = new Map<number, (m: any) => void>();
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf(String.fromCharCode(10))) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (l) { const m = JSON.parse(l); replies.get(m.id)?.(m); } }
  });
  const rpc = (id: number, method: string, params: object) => new Promise<any>((r) => { replies.set(id, r); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + String.fromCharCode(10)); });
  await rpc(1, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } });
  const r = await rpc(2, "tools/call", { name: "use_account", arguments: { role: "planner" } }); // Hub에 연결·로그인(연결이 이벤트 루프를 붙잡는다)
  assert.equal(r.result.isError, false);
  child.stdin.end();
  const code = await Promise.race([exited, new Promise<"timeout">((res) => setTimeout(() => res("timeout"), 5000))]);
  if (code === "timeout") child.kill();
  hub.stop();
  assert.notEqual(code, "timeout", "stdin을 닫은 뒤 5초 안에 끝나야 한다");
});
