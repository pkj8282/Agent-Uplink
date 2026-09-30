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
