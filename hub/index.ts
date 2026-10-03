import fs from "node:fs";
import { Hub } from "./server.js";
import { resolveOptions } from "./options.js";

async function main(): Promise<void> {
  const opts = resolveOptions(process.env);
  const hub = new Hub(opts);
  try {
    await hub.startTcp();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EADDRINUSE") {
      // 다른 Hub가 이미 포트를 점유했다. 경쟁에서 졌으므로 조용히 종료.
      process.exit(0);
    }
    process.stderr.write(`Hub 시작 실패: ${(e as Error).message}\n`);
    process.exit(1);
  }
  await hub.startHttp();

  try {
    fs.mkdirSync(opts.dataDir, { recursive: true });
    fs.writeFileSync(
      opts.infoPath,
      JSON.stringify(
        { tcpPort: opts.tcpPort, httpPort: opts.httpPort, pid: process.pid, startedAt: Date.now() },
        null,
        2,
      ),
    );
  } catch {
    // 정보 파일 실패는 치명적이지 않다
  }

  process.stderr.write(
    `Agent-Uplink Hub(v2) 시작: tcp=127.0.0.1:${opts.tcpPort} viewer=http://127.0.0.1:${opts.httpPort}\n`,
  );
}

main().catch((e) => {
  process.stderr.write(`치명적 오류: ${(e as Error).message}\n`);
  process.exit(1);
});
