export interface FrameLike {
  url: string;
}

/**
 * IPC를 보낸 프레임이 우리 창의 주 프레임인지 확인한다.
 * URL 문자열은 Node·Chromium 정규화가 달라(드라이브 대소문자, ~/%7E, % 등) 비교하지 않고 객체 동일성으로 본다.
 * 창은 탐색·새 창이 차단돼 있으므로 주 프레임은 항상 우리 index.html이다.
 */
export function isTrustedFrame(
  sender: unknown,
  senderFrame: FrameLike | null | undefined,
  expected: { webContents: unknown; mainFrame: unknown },
): boolean {
  return (
    sender === expected.webContents &&
    !!senderFrame &&
    senderFrame === expected.mainFrame &&
    senderFrame.url.startsWith("file:")
  );
}
