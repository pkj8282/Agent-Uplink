// 뷰어 열기 핵심(테스트 가능하게 브라우저 실행을 주입받는다).
import path from "node:path";
import { Response } from "../shared/protocol.js";
import { isViewerUrl } from "../shared/viewerUrl.js";

export interface ViewerDeps {
  ticket(): Promise<Response>;
  open(url: string): Promise<void>;
}

export async function openViewer(deps: ViewerDeps): Promise<void> {
  const r = await deps.ticket();
  if (!r.ok) throw new Error(r.code === "viewer_unavailable" ? (r.error ?? "뷰어가 꺼져 있습니다.") : `뷰어 주소를 받지 못했습니다: ${r.error}`);
  if (!isViewerUrl(r.url)) throw new Error("Hub가 잘못된 뷰어 주소를 보냈습니다.");
  await deps.open(r.url);
}

export function browserCommand(platform: NodeJS.Platform, url: string): { cmd: string; args: string[] } {
  // explorer.exe는 #조각이 든 URL을 기본 브라우저에 넘기지 못한다(실측: 브라우저 요청 없음) → url.dll의 프로토콜 처리기로 연다.
  if (platform === "win32") return { cmd: path.join(process.env.SystemRoot ?? "C:/Windows", "System32", "rundll32.exe"), args: ["url.dll,FileProtocolHandler", url] };
  if (platform === "darwin") return { cmd: "open", args: [url] };
  return { cmd: "xdg-open", args: [url] };
}
