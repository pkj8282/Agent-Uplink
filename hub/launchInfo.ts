/**
 * Hub 수동 시작용 실행 정보(v3.1). Hub가 켜질 때 hub.json에 적고, 관리 앱이 같은 방식으로 다시 띄운다.
 * env는 UPLINK_로 시작하는 값만 — 토큰·PATH 같은 다른 환경 변수는 적지 않는다.
 */
export interface LaunchInfo { execPath: string; execArgv: string[]; entry: string; env: Record<string, string> }

export function launchInfo(p: { execPath: string; execArgv: string[]; entry: string; env: NodeJS.ProcessEnv }): LaunchInfo {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(p.env)) if (k.startsWith("UPLINK_") && typeof v === "string") env[k] = v;
  return { execPath: p.execPath, execArgv: [...p.execArgv], entry: p.entry, env };
}
