// docs/assets/logo.svg → admin/build/icon.ico(16~256px PNG 묶음) + icon.png(256px).
// 사용(admin 폴더에서): npx electron scripts/make-icon.mjs
// 크기마다 따로 렌더링해 작은 아이콘도 선명하게 만든다. 배경은 투명.
import { app, BrowserWindow } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SIZES = [16, 24, 32, 48, 64, 128, 256];
const svg = fs.readFileSync(new URL("../../docs/assets/logo.svg", import.meta.url));
const outDir = new URL("../build/", import.meta.url);

app.commandLine.appendSwitch("force-device-scale-factor", "1");
app.disableHardwareAcceleration();
app.on("window-all-closed", () => { /* 크기 사이에 창을 닫아도 종료하지 않는다 */ });

async function render(size) {
  const win = new BrowserWindow({
    show: false, width: 300, height: 300, useContentSize: true, frame: false, transparent: true,
    backgroundColor: "#00000000", webPreferences: { offscreen: true },
  });
  const src = `data:image/svg+xml;base64,${svg.toString("base64")}`;
  const html = `<!doctype html><html><body style="margin:0;background:transparent">`
    + `<img src="${src}" width="${size}" height="${size}" style="display:block"></body></html>`;
  // data: URL 최상위 로드는 간헐적으로 ERR_FAILED가 나서 임시 파일로 연다(실패 시 1회 재시도).
  const page = path.join(os.tmpdir(), `uplink-icon-${process.pid}-${size}.html`);
  fs.writeFileSync(page, html);
  try {
    await win.loadFile(page);
  } catch {
    await new Promise((r) => setTimeout(r, 300));
    await win.loadFile(page);
  } finally {
    fs.rmSync(page, { force: true });
  }
  await new Promise((r) => setTimeout(r, 300));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
  win.destroy();
  const png = img.toPNG();
  if (img.getSize().width !== size) throw new Error(`${size}px 렌더링 크기 불일치: ${img.getSize().width}`);
  return png;
}

/** PNG들을 ICO 컨테이너로 묶는다(Windows Vista+ 는 PNG 엔트리를 지원). */
function toIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  const dir = Buffer.alloc(16 * entries.length);
  let offset = 6 + dir.length;
  entries.forEach(({ size, png }, i) => {
    const e = i * 16;
    dir[e] = size >= 256 ? 0 : size;
    dir[e + 1] = size >= 256 ? 0 : size;
    dir[e + 2] = 0; // 팔레트 없음
    dir[e + 3] = 0;
    dir.writeUInt16LE(1, e + 4); // planes
    dir.writeUInt16LE(32, e + 6); // bpp
    dir.writeUInt32LE(png.length, e + 8);
    dir.writeUInt32LE(offset, e + 12);
    offset += png.length;
  });
  return Buffer.concat([header, dir, ...entries.map((x) => x.png)]);
}

app.whenReady().then(async () => {
  try {
    const entries = [];
    for (const size of SIZES) entries.push({ size, png: await render(size) });
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(new URL("icon.ico", outDir), toIco(entries));
    fs.writeFileSync(new URL("icon.png", outDir), entries[entries.length - 1].png);
    console.log(`icon.ico (${SIZES.join(", ")}px), icon.png (256px) 생성`);
    app.exit(0);
  } catch (e) {
    console.error(e);
    app.exit(1);
  }
});
