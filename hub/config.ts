import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "./fsutil.js";
import { parseLanguage, type LangSetting } from "../shared/i18n.js";

export interface Config {
  maxChannelsPerServer: number;
  allowDevDelete: boolean;
  inboxMaxBatch: number;
  /** UI 언어(관리 앱이 첫 실행 때 정함). N/A = 아직 안 정함 → 영어. */
  language: LangSetting;
}

const DEFAULTS: Config = { maxChannelsPerServer: 30, allowDevDelete: false, inboxMaxBatch: 200, language: "N/A" };

export function loadConfig(dir: string): Config {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "config.json");
  let parsed: Partial<Config> = {};
  if (fs.existsSync(file)) {
    try {
      parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<Config>;
    } catch {
      parsed = {};
    }
  }
  const cfg: Config = { ...DEFAULTS, ...parsed };
  cfg.language = parseLanguage(cfg.language);
  try {
    writeFileAtomic(file, JSON.stringify(cfg, null, 2));
  } catch {
    // 쓰기 실패해도 메모리 설정은 유효
  }
  return cfg;
}

export function saveConfig(dir: string, cfg: Config): void {
  fs.mkdirSync(dir, { recursive: true });
  writeFileAtomic(path.join(dir, "config.json"), JSON.stringify(cfg, null, 2));
}
