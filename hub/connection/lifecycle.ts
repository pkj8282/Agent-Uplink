// 가동 사건 기록(v3.0 3b, 사용자 설계 2026-11-06): Hub가 시작·정상 종료 사건을 connection/lifecycle.jsonl에 덧붙이고,
// 다음 가동 때 마지막 사건으로 지난 실행이 정상 종료였는지 판단한다(별도 관리 프로세스 없이 일어난 사건 자체를 본다).
// 정상 종료 보고는 마지막 업로드를 끝낸 뒤에 쓴다. 쓰다가 꺼져 줄이 깨지면 비정상으로 본다(안전한 쪽 — 확인을 한 번 더 할 뿐).
import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../fsutil.js";

const KEEP = 1000;

type Event = { e: "start"; ts: number } | { e: "clean_stop"; ts: number; nextIndex: number; lastHash: string };

export class Lifecycle {
  constructor(private readonly file: string) {}

  private lines(): string[] {
    try {
      return fs.readFileSync(this.file, "utf8").split("\n").filter((l) => l.length > 0);
    } catch {
      return [];
    }
  }

  /** 지난 실행이 정상 종료였나. 기록이 없으면 null(처음 가동). */
  lastRunClean(): boolean | null {
    const lines = this.lines();
    if (lines.length === 0) return null;
    try {
      return (JSON.parse(lines[lines.length - 1]) as Event).e === "clean_stop";
    } catch {
      return false; // 깨진 줄 = 보고를 끝내지 못함
    }
  }

  private append(ev: Event): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    let prefix = "";
    try {
      const raw = fs.readFileSync(this.file, "utf8");
      if (raw.length > 0 && !raw.endsWith("\n")) prefix = "\n"; // 깨진 줄 뒤에 붙지 않게
    } catch {
      // 처음
    }
    fs.appendFileSync(this.file, `${prefix}${JSON.stringify(ev)}\n`);
    const lines = this.lines();
    if (lines.length > KEEP) writeFileAtomic(this.file, `${lines.slice(-KEEP).join("\n")}\n`);
  }

  recordStart(ts: number): void {
    this.append({ e: "start", ts });
  }

  recordCleanStop(ts: number, info: { nextIndex: number; lastHash: string }): void {
    this.append({ e: "clean_stop", ts, nextIndex: info.nextIndex, lastHash: info.lastHash });
  }
}
