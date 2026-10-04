// 렌더러 정적 파일(html/css)과 창 아이콘을 dist로 복사한다.
import fs from "node:fs";

const src = new URL("../src/renderer/", import.meta.url);
const out = new URL("../dist/renderer/", import.meta.url);
fs.mkdirSync(out, { recursive: true });
for (const f of fs.readdirSync(src)) {
  if (f.endsWith(".html") || f.endsWith(".css")) fs.copyFileSync(new URL(f, src), new URL(f, out));
}

// 창·작업 표시줄 아이콘(logo.svg에서 만든 build/icon.png → dist/icon.png).
fs.copyFileSync(new URL("../build/icon.png", import.meta.url), new URL("../dist/icon.png", import.meta.url));
