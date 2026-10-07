import path from "node:path";
import { resolveDataDir } from "../shared/clientKey.js";
import { HubOptions } from "./server.js";
import { hubMsg } from "./messages.js";
import type { Lang } from "../shared/i18n.js";

export function resolveOptions(env: NodeJS.ProcessEnv): HubOptions & { infoPath: string } {
  const base = resolveDataDir(env);
  const idleMin = env.UPLINK_IDLE_MINUTES !== undefined ? Number(env.UPLINK_IDLE_MINUTES) : 10;
  return {
    tcpPort: Number(env.UPLINK_TCP_PORT ?? 47800),
    httpPort: Number(env.UPLINK_HTTP_PORT ?? 47801),
    dataDir: base,
    idleShutdownMs: (Number.isFinite(idleMin) ? idleMin : 10) * 60 * 1000,
    infoPath: path.join(base, "hub.json"),
  };
}

/**
 * Hub 시작 실패를 사람이 읽을 문구로. 데이터 폴더 접근 거부는 보통 같은 PC의 다른 Windows 사용자가
 * Hub를 먼저 실행해 폴더가 그 사용자 전용(ACL)이 된 경우다 → 사용자별 UPLINK_DATA_DIR를 안내한다.
 */
export function explainStartupError(e: unknown, dataDir: string, lang: Lang): string {
  const code = (e as NodeJS.ErrnoException)?.code;
  const message = (e as Error)?.message ?? String(e);
  if (code === "EPERM" || code === "EACCES") return hubMsg(lang, "startup_denied", { dir: dataDir, code });
  return hubMsg(lang, "log_start_failed", { detail: message });
}
