// 데이터 폴더 결정(Hub·MCP·CLI·관리 앱 공통 규칙)과 client.key 읽기.
import fs from "node:fs";
import path from "node:path";
import { isKeyText } from "./auth.js";

export const CLIENT_KEY_FILE = "client.key";

export function resolveDataDir(env: NodeJS.ProcessEnv): string {
  return env.UPLINK_DATA_DIR ?? path.join(env.PROGRAMDATA ?? ".", "AgentUplink");
}

export function clientKeyPath(dataDir: string): string {
  return path.join(dataDir, CLIENT_KEY_FILE);
}

/** 연결할 때마다 읽는다(Hub가 방금 만들었을 수 있음). 실패는 사용자가 할 행동을 담아 던진다. */
export function readClientKey(dataDir: string): string {
  const file = clientKeyPath(dataDir);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    const why = (e as NodeJS.ErrnoException).code ?? (e as Error).message;
    throw new Error(`client.key를 읽을 수 없습니다(${why}): ${file}. Hub를 재시작해 보세요. MCP와 Hub의 UPLINK_DATA_DIR가 같은지도 확인하세요.`);
  }
  const key = raw.trim();
  if (!isKeyText(key)) throw new Error(`client.key를 읽을 수 없습니다(형식 오류): ${file}. Hub를 재시작해 보세요.`);
  return key;
}
