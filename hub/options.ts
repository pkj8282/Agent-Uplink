import path from "node:path";
import { HubOptions } from "./server.js";

export function resolveOptions(env: NodeJS.ProcessEnv): HubOptions & { infoPath: string } {
  const base = env.UPLINK_DATA_DIR ?? path.join(env.PROGRAMDATA ?? ".", "AgentUplink");
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
export function explainStartupError(e: unknown, dataDir: string): string {
  const code = (e as NodeJS.ErrnoException)?.code;
  const message = (e as Error)?.message ?? String(e);
  if (code === "EPERM" || code === "EACCES") {
    return [
      `Hub 시작 실패: 데이터 폴더(${dataDir})에 접근할 수 없습니다(${code}).`,
      "같은 PC의 다른 Windows 사용자가 먼저 Hub를 실행해 이 폴더가 그 사용자 전용이 됐을 수 있습니다.",
      "Windows 사용자마다 MCP 설정의 env에 UPLINK_DATA_DIR를 서로 다른 폴더로 지정하세요.",
    ].join(" ");
  }
  return `Hub 시작 실패: ${message}`;
}
