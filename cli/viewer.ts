#!/usr/bin/env node
// agent-uplink-viewer: 로그 뷰어를 기본 브라우저로 연다. 인증된 Hub에서 1회용 티켓을 받아 열고, 티켓 URL은 출력하지 않는다.
import { spawn } from "node:child_process";
import { HubClient } from "../mcp/hubClient.js";
import { resolveDataDir } from "../shared/clientKey.js";
import { openViewer, browserCommand } from "./viewerCore.js";
import { currentLang } from "../shared/langConfig.js";
import { cliMsg } from "./messages.js";

const dataDir = resolveDataDir(process.env);
const client = new HubClient({ port: Number(process.env.UPLINK_TCP_PORT ?? 47800), dataDir });
const lang = currentLang(dataDir);

function launch(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const { cmd, args } = browserCommand(process.platform, url);
    const child = spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}

try {
  await openViewer({ lang, ticket: () => client.viewerTicket(), open: launch });
  process.stdout.write(`${cliMsg(lang, "opened")}\n`);
  client.close();
  process.exit(0);
} catch (e) {
  process.stderr.write(`${cliMsg(lang, "open_failed", { detail: (e as Error).message })}\n`);
  client.close();
  process.exit(1);
}
