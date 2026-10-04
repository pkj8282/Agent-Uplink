#!/usr/bin/env node
// agent-uplink-viewer: 로그 뷰어를 기본 브라우저로 연다. 인증된 Hub에서 1회용 티켓을 받아 열고, 티켓 URL은 출력하지 않는다.
import { spawn } from "node:child_process";
import { HubClient } from "../mcp/hubClient.js";
import { resolveDataDir } from "../shared/clientKey.js";
import { openViewer, browserCommand } from "./viewerCore.js";

const client = new HubClient({ port: Number(process.env.UPLINK_TCP_PORT ?? 47800), dataDir: resolveDataDir(process.env) });

function launch(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const { cmd, args } = browserCommand(process.platform, url);
    const child = spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}

try {
  await openViewer({ ticket: () => client.viewerTicket(), open: launch });
  process.stdout.write("브라우저에서 뷰어를 열었습니다.\n");
  client.close();
  process.exit(0);
} catch (e) {
  process.stderr.write(`뷰어를 열지 못했습니다: ${(e as Error).message}\n`);
  client.close();
  process.exit(1);
}
