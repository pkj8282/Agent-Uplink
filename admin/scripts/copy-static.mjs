// 렌더러 정적 파일(html/css)을 dist/renderer로 복사한다.
import fs from "node:fs";

const src = new URL("../src/renderer/", import.meta.url);
const out = new URL("../dist/renderer/", import.meta.url);
fs.mkdirSync(out, { recursive: true });
for (const f of fs.readdirSync(src)) {
  if (f.endsWith(".html") || f.endsWith(".css")) fs.copyFileSync(new URL(f, src), new URL(f, out));
}
