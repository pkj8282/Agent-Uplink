import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// 관리 앱 아이콘: logo.svg에서 만든 build/icon.ico를 exe와 창(작업 표시줄)에 쓴다.
const root = new URL("../", import.meta.url);
const read = (p: string) => fs.readFileSync(new URL(p, root));

test("build/icon.ico는 16~256px PNG 이미지를 담은 올바른 ICO다", () => {
  const ico = read("build/icon.ico");
  assert.equal(ico.readUInt16LE(0), 0); // reserved
  assert.equal(ico.readUInt16LE(2), 1); // type: icon
  const count = ico.readUInt16LE(4);
  const sizes: number[] = [];
  for (let i = 0; i < count; i++) {
    const e = 6 + i * 16;
    const w = ico[e] || 256; // 0은 256
    const h = ico[e + 1] || 256;
    assert.equal(w, h);
    const len = ico.readUInt32LE(e + 8);
    const off = ico.readUInt32LE(e + 12);
    assert.ok(off + len <= ico.length, `엔트리 ${w}px 범위`);
    assert.equal(ico.subarray(off, off + 4).toString("latin1"), String.fromCharCode(0x89) + "PNG", `엔트리 ${w}px는 PNG`);
    assert.equal(ico.readUInt32BE(off + 16), w, `엔트리 ${w}px PNG 폭`); // IHDR width
    sizes.push(w);
  }
  for (const s of [16, 24, 32, 48, 64, 128, 256]) assert.ok(sizes.includes(s), `${s}px 포함`);
});

test("electron-builder가 exe 아이콘으로 build/icon.ico를 쓴다(서명 설정은 그대로)", () => {
  const pkg = JSON.parse(read("package.json").toString("utf8"));
  assert.equal(pkg.build.win.icon, "build/icon.ico");
  assert.equal(pkg.build.win.signAndEditExecutable, true);
  assert.ok(fs.existsSync(new URL("build/icon.ico", root)));
});

test("창은 로고 아이콘을 쓰고, 작업 표시줄이 앱으로 묶이도록 AppUserModelId를 지정한다", () => {
  const main = read("src/main.ts").toString("utf8");
  assert.match(main, /icon:\s*windowIcon/);
  assert.match(main, /setAppUserModelId\("dev\.agentuplink\.admin"\)/);
  const copy = read("scripts/copy-static.mjs").toString("utf8");
  assert.match(copy, /icon\.png/); // 창 아이콘 PNG를 dist로 복사
  assert.ok(fs.existsSync(new URL("build/icon.png", root)));
});
