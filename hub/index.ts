#!/usr/bin/env node
import fs from "node:fs";
import { Hub } from "./server.js";
import { resolveOptions, explainStartupError } from "./options.js";
import { hubMsg } from "./messages.js";
import { currentLang } from "../shared/langConfig.js";

async function main(): Promise<void> {
  const opts = resolveOptions(process.env);
  let hub: Hub;
  try {
    fs.mkdirSync(opts.dataDir, { recursive: true });
    hub = new Hub(opts);
  } catch (e) {
    process.stderr.write(`${explainStartupError(e, opts.dataDir, currentLang(opts.dataDir))}\n`);
    process.exit(1);
  }
  try {
    await hub.startTcp();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EADDRINUSE") {
      // 다른 Hub가 이미 포트를 점유했다. 경쟁에서 졌으므로 조용히 종료.
      process.exit(0);
    }
    process.stderr.write(`${hubMsg(currentLang(opts.dataDir), "log_start_failed", { detail: (e as Error).message })}\n`);
    process.exit(1);
  }
  await hub.startHttp();

  // 포트는 먼저 열어 MCP 접속 재시도 한도를 지키고, hello는 보안 준비(권한 잠금·소유자 검사·키)가 끝난 뒤에만 답한다.
  try {
    await hub.secure();
  } catch (e) {
    process.stderr.write(`${hubMsg(currentLang(opts.dataDir), "log_secure_failed", { detail: (e as Error).message })}\n`);
    setTimeout(() => process.exit(1), 1000); // 대기 중인 hello에 사유를 보낼 시간
    return;
  }

  try {
    fs.writeFileSync(
      opts.infoPath,
      JSON.stringify({ tcpPort: opts.tcpPort, httpPort: opts.httpPort, pid: process.pid, startedAt: Date.now() }, null, 2),
    );
  } catch {
    // 정보 파일 실패는 치명적이지 않다
  }

  process.stderr.write(`${hubMsg(currentLang(opts.dataDir), "log_started", { tcp: opts.tcpPort, http: opts.httpPort })}\n`);
}

main().catch((e) => {
  // 옵션 해석 전 실패일 수도 있어 여기서 데이터 폴더를 다시 정한다.
  process.stderr.write(`${hubMsg(currentLang(resolveOptions(process.env).dataDir), "log_fatal", { detail: (e as Error).message })}\n`);
  process.exit(1);
});
