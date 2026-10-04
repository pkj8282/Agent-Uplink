import fs from "node:fs";
import { randomBytes } from "node:crypto";

/**
 * 파일 전체 교체를 원자적으로 수행한다(임시 파일에 쓴 뒤 rename).
 * 크래시가 나도 대상 파일은 교체 전 상태 또는 교체 후 상태 중 하나로만 남아,
 * 잘려-쓰여 손상된 중간 상태가 생기지 않는다(같은 볼륨에서 rename은 원자적).
 */
export function writeFileAtomic(file: string, data: string): void {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

/**
 * 비밀 파일(키·표식) 교체: 무작위 이름 임시 파일을 배타 생성(wx)해 쓰고 rename한다.
 * 고정 이름 임시 파일은 다른 사용자가 미리 만들어 둘 수 있어(권한 잠금 전) 쓰지 않는다.
 */
export function writeSecretFile(file: string, data: string): void {
  const tmp = `${file}.${randomBytes(8).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, data, { flag: "wx", mode: 0o600 });
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

/** 읽을 수 없는 파일을 같은 폴더의 '<이름>.corrupt-<ms>'로 옮겨 보존한다(실패 시 null). */
export function backupCorrupt(file: string, now: number = Date.now()): string | null {
  const dest = `${file}.corrupt-${now}`;
  try {
    fs.renameSync(file, dest);
    return dest;
  } catch {
    return null;
  }
}
