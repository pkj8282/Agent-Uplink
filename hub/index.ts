import fs from "node:fs";
import { Hub } from "./server.js";
import { resolveOptions, explainStartupError } from "./options.js";
import { restrictDataDirAcl } from "./acl.js";

async function main(): Promise<void> {
  const opts = resolveOptions(process.env);
  let hub: Hub;
  try {
    hub = new Hub(opts);
  } catch (e) {
    process.stderr.write(`${explainStartupError(e, opts.dataDir)}\n`);
    process.exit(1);
  }
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

  // 같은 PC의 다른 Windows 사용자가 admin.key·대화 로그를 읽지 못하게 데이터 폴더를 현재 사용자 전용으로(멱등).
  // 포트를 연 뒤 비동기로 실행해 MCP의 접속 재시도 한도 안에 기동이 끝나게 한다.
  void restrictDataDirAcl(opts.dataDir).then((acl) => {
    if (!acl.ok) process.stderr.write(`경고: 데이터 폴더 권한을 제한하지 못했습니다: ${acl.error}\n`);
  });

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
