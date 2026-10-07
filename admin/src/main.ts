import { app, BrowserWindow, ipcMain, shell } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AdminClient, HubNotRunningError, resolveAdminTarget, toResult } from "./adminClient.js";
import { isTrustedFrame } from "./ipcGuard.js";
import { isViewerUrl } from "./auth.js";
import type { ConfigPatch, IpcResult } from "./types.js";
import { effectiveLang, type Lang } from "./i18n.js";
import { readLanguageFile, writeLanguageFile } from "./langFile.js";
import { adminMsg, type AdminKey } from "./messages.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const indexFile = path.join(here, "renderer", "index.html");
// 창·작업 표시줄 아이콘(logo.svg → build/icon.png, 빌드 때 dist로 복사됨). exe 아이콘은 electron-builder의 win.icon.
const windowIcon = path.join(here, "icon.png");
const target = resolveAdminTarget(process.env);
const dataDir = target.dataDir!;
const client = new AdminClient(target);
let mainWindow: BrowserWindow | null = null;

/** main 쪽 문구: 매번 데이터 폴더의 언어를 읽는다(설정에서 바꾸면 바로 반영). */
const mainLang = (): Lang => effectiveLang(readLanguageFile(dataDir));
const msg = (key: AdminKey, params?: object) => adminMsg(mainLang(), key, params);

function asId(v: unknown): string {
  if (typeof v !== "string" || v.length === 0) throw new Error(msg("invalid_target"));
  return v;
}

/** 우리 창의 주 프레임(index.html)에서 온 호출만 처리한다. */
function handle(channel: string, fn: (arg: unknown) => Promise<IpcResult<unknown>>): void {
  ipcMain.handle(channel, (e, arg: unknown) => {
    const wc = mainWindow?.webContents;
    return wc && isTrustedFrame(e.sender, e.senderFrame, { webContents: wc, mainFrame: wc.mainFrame })
      ? fn(arg)
      : { ok: false, error: msg("untrusted_call"), hubDown: false };
  });
}

// Hub가 값을 재검증하므로 patch는 그대로 전달한다.
// 스모크 전용: 새로고침 응답을 늦춰 inert 중 포커스 소실·복원을 재현한다(UPLINK_ADMIN_SMOKE와 함께일 때만).
const smokeSnapshotDelay = process.env.UPLINK_ADMIN_SMOKE ? Number(process.env.UPLINK_ADMIN_SMOKE_SNAPSHOT_DELAY_MS ?? 0) : 0;
handle("admin:snapshot", async () => {
  if (smokeSnapshotDelay > 0) await new Promise((r) => setTimeout(r, smokeSnapshotDelay));
  return toResult(() => client.snapshot());
});
handle("admin:setConfig", (patch) => toResult(() => client.setConfig(patch as ConfigPatch)));
handle("admin:deleteChannel", (id) => toResult(() => client.deleteChannel(asId(id))));
handle("admin:deleteServer", (id) => toResult(() => client.deleteServer(asId(id))));
handle("admin:deleteAccount", (uuid) => toResult(() => client.deleteAccount(asId(uuid))));
handle("admin:restoreTrash", (arg) => {
  const a = (arg ?? {}) as { id?: unknown; confirmRename?: unknown };
  return toResult(() => client.restoreTrash(asId(a.id), a.confirmRename === true));
});
handle("admin:emptyTrash", () => toResult(() => client.emptyTrash()));
// 뷰어는 같은 Windows 사용자만 열 수 있다: 인증된 Hub에서 1회용 티켓을 받아 기본 브라우저로 연다(형식 검사 후).
handle("admin:openViewer", () => toResult(async () => {
  const url = await client.viewerTicket();
  if (!isViewerUrl(url)) throw new Error(msg("bad_viewer_url"));
  await shell.openExternal(url);
}));
// 언어: Hub가 꺼져 있어도 동작해야 한다(첫 실행 언어 선택) — 읽기는 파일, 쓰기는 Hub가 켜져 있으면 Hub로(기록자는 Hub), 꺼져 있으면 파일에 직접.
handle("admin:getLanguage", async () => ({ ok: true, data: readLanguageFile(dataDir) }));
handle("admin:setLanguage", (arg) => toResult(async () => {
  if (arg !== "ko" && arg !== "en") throw new Error(msg("lang_invalid"));
  const lang: Lang = arg;
  try {
    const cfg = await client.setConfig({ language: lang });
    if (cfg.language !== lang) {
      // 구버전 Hub는 language를 모르고 무시한다 → 파일에라도 남기고 알린다.
      writeLanguageFile(dataDir, lang);
      throw new Error(adminMsg(lang, "lang_old_hub"));
    }
    return { via: "hub" as const };
  } catch (e) {
    if (!(e instanceof HubNotRunningError)) throw e;
    try {
      writeLanguageFile(dataDir, lang);
    } catch (w) {
      throw new Error(adminMsg(lang, "lang_save_failed", { detail: (w as Error).message }));
    }
    return { via: "file" as const };
  }
}));

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    icon: windowIcon,
    width: 980,
    height: 700,
    minWidth: 720,
    minHeight: 480,
    title: msg("window_title"),
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

/** 화면이 loading을 벗어날 때까지 기다린다(ready·hubdown·error·lang). */
async function settled(win: BrowserWindow): Promise<void> {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const state = await win.webContents.executeJavaScript("document.body.dataset.state");
    if (state !== "loading") return;
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** 첫 로드가 끝난 화면 상태를 모은다(스모크 리포트 본문). */
async function collectReport(win: BrowserWindow): Promise<Record<string, unknown>> {
  await settled(win);
  // 스모크 전용: UPLINK_ADMIN_SMOKE_PICK=ko|en이면 언어 선택 화면에서 그 버튼을 눌러 저장 → Hub 확인까지 진행한다.
  const pick = process.env.UPLINK_ADMIN_SMOKE_PICK;
  if ((pick === "ko" || pick === "en") && (await win.webContents.executeJavaScript("document.body.dataset.state")) === "lang") {
    await win.webContents.executeJavaScript(`document.getElementById("lang-${pick}").click()`);
    for (let i = 0; i < 50 && (await win.webContents.executeJavaScript("document.body.dataset.state")) === "lang"; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    await settled(win);
  }
  // bodyHasHangul: 화면 전체(모든 탭)에 한글이 보이는지 — 영어 화면 확인용. 언어 이름(언어 선택 화면·언어 선택 상자)은
  // 두 언어 공통이라 뺀다. 사용자 데이터가 한글이면 true일 수 있다.
  const report: Record<string, unknown> = await win.webContents.executeJavaScript(`({
    state: document.body.dataset.state,
    banner: document.getElementById("banner").hidden ? "" : document.getElementById("banner").textContent,
    status: document.getElementById("status").textContent,
    mainInert: document.querySelector("main").inert,
    servers: document.querySelectorAll("[data-kind=server]").length,
    channels: document.querySelectorAll("[data-kind=channel]").length,
    accounts: [...document.querySelectorAll("[data-kind=account] .name")].map((e) => e.textContent),
    descriptions: [...document.querySelectorAll("[data-kind=account] .desc")].map((e) => e.textContent),
    dms: document.querySelectorAll("[data-kind=dm]").length,
    injected: document.querySelectorAll("main img, main script, main iframe").length,
    trash: document.querySelectorAll("[data-kind=trash]").length,
    trashSummary: document.getElementById("trash-summary").textContent,
    opMsgHidden: document.getElementById("op-msg").hidden,
    lang: document.documentElement.lang,
    langPicker: !document.getElementById("lang-picker").hidden,
    title: document.title,
    langSelectUsable: !document.getElementById("cfg-lang").closest("[inert]") && !document.getElementById("cfg-lang").closest("[hidden]"),
    bodyHasHangul: (() => {
      const b = document.body.cloneNode(true);
      for (const e of b.querySelectorAll("#lang-picker, #cfg-lang")) e.remove();
      return [...b.textContent].some((c) => { const x = c.codePointAt(0); return x >= 0xac00 && x <= 0xd7a3; });
    })(),
  })`);
  if (report.state === "lang") return report; // 언어 선택 화면에는 설정 입력이 보이지 않는다
  // inert 전환 뒤 포커스 복원 확인: 설정 입력에 포커스 → 새로고침 → 끝난 뒤 포커스 위치
  report.focusAfterRefresh = await win.webContents.executeJavaScript(`(async () => {
    document.getElementById("cfg-max").focus();
    document.getElementById("refresh").click();
    for (let i = 0; i < 50 && document.body.dataset.state === "loading"; i++) await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 100));
    return document.activeElement ? document.activeElement.id : "";
  })()`);
  return report;
}

/**
 * UPLINK_ADMIN_SMOKE=<파일>: 첫 로드가 끝난 화면 상태를 JSON으로 쓰고 종료(빌드 검증용).
 * 정상 화면(ready/hubdown/error/lang)은 exit 0, 시간 초과·로드 실패·렌더러 종료·스모크 오류는 exit 1.
 * 어느 경로든 결과 파일을 남기고 반드시 종료한다(검증이 멈춘 채 대기하지 않도록).
 */
function runSmoke(win: BrowserWindow, outFile: string): void {
  const consoleErrors: string[] = [];
  let done = false;
  const limit = Number(process.env.UPLINK_ADMIN_SMOKE_TIMEOUT_MS ?? 30000);
  const finish = (report: Record<string, unknown>, code: number) => {
    if (done) return;
    done = true;
    clearTimeout(watchdog);
    try {
      fs.writeFileSync(outFile, JSON.stringify({ ...report, consoleErrors }, null, 2));
    } finally {
      app.exit(code);
    }
  };
  const watchdog = setTimeout(() => finish({ state: "smoke-timeout", limitMs: limit }, 1), limit);
  win.webContents.on("console-message", (...args: unknown[]) => {
    const ev = args[0] as { message?: string; level?: unknown };
    const message = ev?.message ?? String(args[2] ?? "");
    const level = ev?.level ?? args[1];
    if (level === "error" || level === 3) consoleErrors.push(message);
  });
  win.webContents.once("did-fail-load", (_e, code: number, desc: string) => finish({ state: "load-failed", error: `${code} ${desc}` }, 1));
  win.webContents.once("render-process-gone", (_e, d: { reason: string }) => finish({ state: "renderer-gone", error: d.reason }, 1));
  win.webContents.once("did-finish-load", async () => {
    try {
      finish(await collectReport(win), 0);
    } catch (e) {
      finish({ state: "smoke-error", error: (e as Error).message }, 1);
    }
  });
}

// 작업 표시줄이 이 앱 창을 같은 앱(같은 아이콘)으로 묶도록 appId와 같은 값을 쓴다.
app.setAppUserModelId("dev.agentuplink.admin");

void app.whenReady().then(() => {
  const win = createWindow();
  const smokeOut = process.env.UPLINK_ADMIN_SMOKE;
  if (smokeOut) runSmoke(win, smokeOut);
});

app.on("window-all-closed", () => app.quit());
