import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "./fsutil.js";

export interface Config {
  maxChannelsPerServer: number;
  allowDevDelete: boolean;
  inboxMaxBatch: number;
}

const DEFAULTS: Config = { maxChannelsPerServer: 30, allowDevDelete: false, inboxMaxBatch: 200 };

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
