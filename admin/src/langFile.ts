// main 전용: Hub가 꺼져 있어도 데이터 폴더 config.json의 언어를 읽고 쓴다(첫 실행 언어 선택).
// 오류 문구는 내부용 영어 — 화면에는 문구표(lang_save_failed)로 감싸 보인다.
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { parseLanguage, type Lang, type LangSetting } from "./i18n.js";

const MAX_CONFIG_BYTES = 64 * 1024;
const file = (dataDir: string) => path.join(dataDir, "config.json");

export function readLanguageFile(dataDir: string): LangSetting {
  try {
    const st = fs.statSync(file(dataDir));
    if (!st.isFile() || st.size > MAX_CONFIG_BYTES) return "N/A";
    return parseLanguage((JSON.parse(fs.readFileSync(file(dataDir), "utf8")) as { language?: unknown } | null)?.language);
  } catch {
    return "N/A";
  }
}

/** language만 바꿔 원자적으로 쓴다. 정규 파일이 아닌 config.json(디렉터리·링크)은 건드리지 않는다. */
export function writeLanguageFile(dataDir: string, lang: Lang): void {
  if (lang !== "ko" && lang !== "en") throw new Error("invalid language");
  const f = file(dataDir);
  fs.mkdirSync(dataDir, { recursive: true });
  // 데이터 폴더 자체가 정션·링크면 쓰지 않는다: 다른 Windows 사용자가 미리 만든 폴더가 다른 앱 폴더로 연결돼 있으면
  // 그 앱의 config.json을 고치게 된다(레드팀 RT23). Hub의 보안 준비도 이런 폴더는 거부한다.
  if (!fs.lstatSync(dataDir).isDirectory()) throw new Error("data folder is a link or not a directory");
  let obj: Record<string, unknown> = {};
  let st: fs.Stats | null = null;
  try { st = fs.lstatSync(f); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  if (st) {
    if (!st.isFile()) throw new Error("config.json is not a regular file");
    if (st.size <= MAX_CONFIG_BYTES) {
      try {
        const j = JSON.parse(fs.readFileSync(f, "utf8")) as unknown;
        if (j && typeof j === "object" && !Array.isArray(j)) obj = j as Record<string, unknown>;
      } catch { /* 깨진 파일은 language만 담아 교체(Hub도 기본값으로 다시 채운다) */ }
    }
  }
  obj.language = lang;
  // 무작위 이름 임시 파일을 배타 생성 — 미리 만들어 둔 고정 이름 임시 파일로 쓰기를 가로챌 수 없게.
  const tmp = `${f}.${randomBytes(8).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { flag: "wx" });
  try { fs.renameSync(tmp, f); } catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
}
