import { app, BrowserWindow, ipcMain } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AdminClient, resolveAdminTarget, toResult } from "./adminClient.js";
import { isTrustedFrame } from "./ipcGuard.js";
import type { ConfigPatch, IpcResult } from "./types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const indexFile = path.join(here, "renderer", "index.html");
const client = new AdminClient(resolveAdminTarget(process.env));
let mainWindow: BrowserWindow | null = null;

function asId(v: unknown): string {
  if (typeof v !== "string" || v.length === 0) throw new Error("잘못된 대상 ID입니다.");
  return v;
}

/** 우리 창의 주 프레임(index.html)에서 온 호출만 처리한다. */
function handle(channel: string, fn: (arg: unknown) => Promise<IpcResult<unknown>>): void {
  ipcMain.handle(channel, (e, arg: unknown) => {
    const wc = mainWindow?.webContents;
    return wc && isTrustedFrame(e.sender, e.senderFrame, { webContents: wc, mainFrame: wc.mainFrame })
      ? fn(arg)
      : { ok: false, error: "허용되지 않은 호출입니다.", hubDown: false };
  });
}

// Hub가 값을 재검증하므로 patch는 그대로 전달한다.
handle("admin:snapshot", () => toResult(() => client.snapshot()));
handle("admin:setConfig", (patch) => toResult(() => client.setConfig(patch as ConfigPatch)));
handle("admin:deleteChannel", (id) => toResult(() => client.deleteChannel(asId(id))));
handle("admin:deleteServer", (id) => toResult(() => client.deleteServer(asId(id))));
handle("admin:deleteAccount", (uuid) => toResult(() => client.deleteAccount(asId(uuid))));

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
  mainWindow = win; // loadFile 전에 지정해야 첫 로드의 IPC도 신뢰된다
  win.on("closed", () => { mainWindow = null; });
  win.removeMenu();
  // 로컬 관리 UI 전용: 새 창·외부 탐색 차단
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  void win.loadFile(indexFile);
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
    let report: Record<string, unknown>;
    try {
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const state = await win.webContents.executeJavaScript("document.body.dataset.state");
        if (state !== "loading") break;
        await new Promise((r) => setTimeout(r, 200));
      }
      report = await win.webContents.executeJavaScript(`({
        state: document.body.dataset.state,
        banner: document.getElementById("banner").hidden ? "" : document.getElementById("banner").textContent,
        status: document.getElementById("status").textContent,
        mainInert: document.querySelector("main").inert,
        servers: document.querySelectorAll("[data-kind=server]").length,
        channels: document.querySelectorAll("[data-kind=channel]").length,
        accounts: [...document.querySelectorAll("[data-kind=account] .name")].map((e) => e.textContent),
        dms: document.querySelectorAll("[data-kind=dm]").length,
        injected: document.querySelectorAll("main img, main script, main iframe").length,
      })`);
    } catch (e) {
      report = { state: "smoke-error", error: (e as Error).message };
    }
    // 스모크가 실패해도 결과를 남기고 반드시 종료한다(검증이 멈춘 채 대기하지 않도록).
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
