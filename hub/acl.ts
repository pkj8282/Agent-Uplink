// 데이터 폴더 권한(Windows): %ProgramData% 아래는 기본으로 Users 그룹이 읽을 수 있어,
// 같은 PC의 다른 Windows 사용자가 admin.key·대화 로그를 읽을 수 있다 → 현재 사용자 전용으로 바꾼다.
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

// PATH에 Git Bash 등의 같은 이름 도구(whoami)가 먼저 있을 수 있어 System32 절대 경로로 호출한다.
const SYS32 = path.join(process.env.SystemRoot ?? "C:/Windows", "System32");
const WHOAMI = path.join(SYS32, "whoami.exe");
const ICACLS = path.join(SYS32, "icacls.exe");

const SYSTEM_SID = "*S-1-5-18";
const ADMINS_SID = "*S-1-5-32-544";
// 명시적으로 남아 있을 수 있는 넓은 그룹: Users, Authenticated Users, Everyone
const BROAD_SIDS = ["*S-1-5-32-545", "*S-1-5-11", "*S-1-1-0"];

async function currentUserSid(): Promise<string> {
  // "도메인\사용자","S-1-5-21-..." 형태(CSV, 머리글 없음)
  const { stdout } = await run(WHOAMI, ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", timeout: 10000, windowsHide: true });
  const m = stdout.match(/"(S-1-[0-9-]+)"/);
  if (!m) throw new Error(`현재 사용자 SID를 알 수 없습니다: ${stdout.trim()}`);
  return `*${m[1]}`;
}

/**
 * dir의 상속을 끊고 현재 사용자·SYSTEM·Administrators에게만 전체 권한을 준다(하위 항목은 상속으로 따라옴).
 * win32가 아니면 아무것도 하지 않는다. 실패해도 던지지 않고 결과로 알린다(Hub 동작을 막지 않음). 멱등.
 * 비동기: Hub가 포트를 연 뒤에 실행해 기동 시간(MCP 접속 재시도 한도)에 영향을 주지 않는다.
 */
export async function restrictDataDirAcl(dir: string): Promise<{ ok: boolean; error?: string }> {
  if (process.platform !== "win32") return { ok: true };
  try {
    if (!fs.statSync(dir).isDirectory()) return { ok: false, error: `폴더가 아닙니다: ${dir}` };
    const user = await currentUserSid();
    await run(
      ICACLS,
      [
        dir,
        "/inheritance:r",
        "/grant:r", `${user}:(OI)(CI)F`, `${SYSTEM_SID}:(OI)(CI)F`, `${ADMINS_SID}:(OI)(CI)F`,
        "/remove:g", ...BROAD_SIDS,
        "/Q",
      ],
      { encoding: "utf8", timeout: 10000, windowsHide: true },
    );
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
