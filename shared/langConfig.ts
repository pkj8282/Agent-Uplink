// 데이터 폴더 config.json에서 언어 설정을 읽는다(Hub·MCP·CLI 공통). 매번 읽는다 — 파일이 작고, 관리 앱이 바꾸면 다음 호출부터 반영돼야 한다.
import fs from "node:fs";
import path from "node:path";
import { effectiveLang, parseLanguage, type Lang, type LangSetting } from "./i18n.js";

const MAX_CONFIG_BYTES = 64 * 1024;

export function configFile(dataDir: string): string {
  return path.join(dataDir, "config.json");
}

/** 없음·정규 파일 아님·너무 큼·깨짐·이상한 값은 모두 N/A(신뢰할 수 없는 폴더에서도 ko/en 선택 외 영향 없음). */
export function readLanguage(dataDir: string): LangSetting {
  const file = configFile(dataDir);
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_CONFIG_BYTES) return "N/A";
    const j = JSON.parse(fs.readFileSync(file, "utf8")) as { language?: unknown } | null;
    return parseLanguage(j?.language);
  } catch {
    return "N/A";
  }
}

export function currentLang(dataDir: string): Lang {
  return effectiveLang(readLanguage(dataDir));
}
