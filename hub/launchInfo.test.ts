import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { freePort, tempDir } from "./testing.js";
import { launchInfo } from "./launchInfo.js";

const HUB_ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.ts");

test("launch_info_keeps_only_uplink_env: 실행 정보 env에는 UPLINK_로 시작하는 값만(토큰·PATH 제외)", () => {
  const li = launchInfo({ execPath: "C:\\node\\node.exe", execArgv: ["--import", "tsx"], entry: "C:\\a\\hub\\index.js", env: { PATH: "C:\\x", GH_TOKEN: "ghp_secret", UPLINK_DATA_DIR: "D:\\data", UPLINK_TCP_PORT: "47960", uplink_lower: "x" } });
  assert.deepEqual(li, { execPath: "C:\\node\\node.exe", execArgv: ["--import", "tsx"], entry: "C:\\a\\hub\\index.js", env: { UPLINK_DATA_DIR: "D:\\data", UPLINK_TCP_PORT: "47960" } });
});

test("launch_info_written_to_hub_json: 켜진 Hub가 hub.json에 자기 실행 정보를 적는다", async () => {
  const dir = tempDir("uplink-launch-");
  const port = await freePort();
  const env = { ...process.env, UPLINK_DATA_DIR: dir, UPLINK_TCP_PORT: String(port), UPLINK_HTTP_PORT: String(await freePort()), UPLINK_IDLE_MINUTES: "0.05" };
  const child = spawn(process.execPath, ["--import", "tsx", HUB_ENTRY], { env, stdio: "ignore", windowsHide: true });
  try {
    const info = path.join(dir, "hub.json");
    let j: any = null;
    for (let i = 0; i < 300 && !j?.launch; i++) {
      await new Promise((r) => setTimeout(r, 50));
      try { j = JSON.parse(fs.readFileSync(info, "utf8")); } catch { /* 아직 */ }
    }
    assert.ok(j?.launch, "hub.json에 launch가 있어야 함");
    assert.equal(j.pid, child.pid);
    assert.equal(j.launch.execPath, process.execPath);
    assert.equal(path.resolve(j.launch.entry), path.resolve(HUB_ENTRY));
    assert.ok(fs.existsSync(j.launch.entry));
    assert.deepEqual(j.launch.execArgv.slice(-2), ["--import", "tsx"]);
    assert.equal(j.launch.env.UPLINK_DATA_DIR, dir);
    assert.equal(j.launch.env.UPLINK_TCP_PORT, String(port));
    assert.equal("PATH" in j.launch.env, false);
  } finally {
    child.kill();
  }
});
