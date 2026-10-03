import fs from "node:fs";

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
