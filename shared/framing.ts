// 4바이트 리틀엔디언 길이 프리픽스 + UTF-8 JSON 본문 프레이밍.
export function encodeFrame(obj: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32LE(body.length, 0);
  return Buffer.concat([len, body]);
}

/** 선언된 프레임 길이가 상한을 넘었다(받는 쪽은 연결을 끊어야 한다). */
export class FrameTooLargeError extends Error {
  constructor(readonly length: number, readonly max: number) {
    super(`프레임이 너무 큽니다(${length} > ${max} bytes).`);
    this.name = "FrameTooLargeError";
  }
}

export class FrameDecoder {
  private buf = Buffer.alloc(0);
  private expected = -1;
  private readonly maxFrame: number;

  /** maxFrame: 받을 수 있는 본문 최대 바이트(기본 상한 없음 — 큰 응답을 받는 클라이언트용). */
  constructor(opts: { maxFrame?: number } = {}) {
    this.maxFrame = opts.maxFrame ?? Infinity;
  }

  push(chunk: Buffer, onFrame: (obj: any) => void): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      if (this.expected < 0) {
        if (this.buf.length < 4) return;
        this.expected = this.buf.readUInt32LE(0);
        this.buf = this.buf.subarray(4);
        // 본문을 기다리며 버퍼를 키우기 전에 거부한다(거대 길이 선언으로 메모리·CPU 고갈 방지).
        if (this.expected > this.maxFrame) throw new FrameTooLargeError(this.expected, this.maxFrame);
      }
      if (this.buf.length < this.expected) return;
      const body = this.buf.subarray(0, this.expected).toString("utf8");
      this.buf = this.buf.subarray(this.expected);
      this.expected = -1;
      let obj: unknown;
      try {
        obj = JSON.parse(body);
      } catch {
        // 본문이 JSON이 아니면 그 프레임만 버리고 다음 프레임을 계속 처리한다.
        continue;
      }
      onFrame(obj);
    }
  }
}
