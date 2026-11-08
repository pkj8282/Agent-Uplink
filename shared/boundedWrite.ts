// 보내기 큐 상한(독립 리뷰 M2): 상대가 읽지 않으면 sock.write가 메모리에 쌓이기만 한다.
// 큐 + 이번 프레임이 상한을 넘으면 그 연결을 끊는다. 쓰기 큐는 연결이 끊기면 함께 사라진다.

/** 인증된 통신 연결의 보내기 큐 상한(바이트) — 가장 큰 응답(c_read 2MB)의 몇 배. */
export const CONN_WRITE_QUEUE = 8 * 1024 * 1024;

export interface WriteSink {
  writableLength: number;
  destroyed: boolean;
  write(b: Buffer): unknown;
  destroy(): void;
}

/** 썼으면 true. 상한을 넘으면 연결을 끊고 false, 이미 끊겼으면 false. */
export function boundedWrite(sock: WriteSink, frame: Buffer, limit: number): boolean {
  if (sock.destroyed) return false;
  if (sock.writableLength + frame.length > limit) {
    sock.destroy();
    return false;
  }
  sock.write(frame);
  return true;
}
