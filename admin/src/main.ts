import { app, BrowserWindow, ipcMain } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AdminClient, resolveAdminTarget, toResult } from "./adminClient.js";
import type { ConfigPatch } from "./types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const client = new AdminClient(resolveAdminTarget(process.env));

function asId(v: unknown): string {
  if (typeof v !== "string" || v.length === 0) throw new Error("잘못된 대상 ID입니다.");
  return v;
}

// Hub가 값을 재검증하므로 patch는 그대로 전달한다.
ipcMain.handle("admin:snapshot", () => toResult(() => client.snapshot()));
ipcMain.handle("admin:setConfig", (_e, patch: ConfigPatch) => toResult(() => client.setConfig(patch)));
ipcMain.handle("admin:deleteChannel", (_e, id: unknown) => toResult(() => client.deleteChannel(asId(id))));
ipcMain.handle("admin:deleteServer", (_e, id: unknown) => toResult(() => client.deleteServer(asId(id))));
ipcMain.handle("admin:deleteAccount", (_e, uuid: unknown) => toResult(() => client.deleteAccount(asId(uuid))));

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 980,
    height: 700,
    minWidth: 720,
    minHeight: 480,
    title: "Agent-Uplink 관리",
    webPreferences: {
      preload: path.join(here, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.removeMenu();
  // 로컬 관리 UI 전용: 새 창·외부 탐색 차단
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  void win.loadFile(path.join(here, "renderer", "index.html"));
  return win;
}

/** UPLINK_ADMIN_SMOKE=<파일>: 첫 로드가 끝난 화면 상태를 JSON으로 쓰고 종료(빌드 검증용). */
function runSmoke(win: BrowserWindow, outFile: string): void {
  const consoleErrors: string[] = [];
  win.webContents.on("console-message", (...args: unknown[]) => {
    const ev = args[0] as { message?: string; level?: unknown };
    const message = ev?.message ?? String(args[2] ?? "");
    const level = ev?.level ?? args[1];
    if (level === "error" || level === 3) consoleErrors.push(message);
  });
  win.webContents.once("did-finish-load", async () => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const state = await win.webContents.executeJavaScript("document.body.dataset.state");
      if (state !== "loading") break;
      await new Promise((r) => setTimeout(r, 200));
    }
    const report = await win.webContents.executeJavaScript(`({
      state: document.body.dataset.state,
      banner: document.getElementById("banner").hidden ? "" : document.getElementById("banner").textContent,
      servers: document.querySelectorAll("[data-kind=server]").length,
      channels: document.querySelectorAll("[data-kind=channel]").length,
      accounts: [...document.querySelectorAll("[data-kind=account] .name")].map((e) => e.textContent),
      dms: document.querySelectorAll("[data-kind=dm]").length,
      injected: document.querySelectorAll("main img, main script, main iframe").length,
    })`);
    fs.writeFileSync(outFile, JSON.stringify({ ...report, consoleErrors }, null, 2));
    app.exit(0);
  });
}

void app.whenReady().then(() => {
  const win = createWindow();
  const smokeOut = process.env.UPLINK_ADMIN_SMOKE;
  if (smokeOut) runSmoke(win, smokeOut);
});

app.on("window-all-closed", () => app.quit());
