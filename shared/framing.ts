// 4바이트 리틀엔디언 길이 프리픽스 + UTF-8 JSON 본문 프레이밍.
export function encodeFrame(obj: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32LE(body.length, 0);
  return Buffer.concat([len, body]);
}

export class FrameDecoder {
  private buf = Buffer.alloc(0);
  private expected = -1;

  push(chunk: Buffer, onFrame: (obj: any) => void): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      if (this.expected < 0) {
        if (this.buf.length < 4) return;
        this.expected = this.buf.readUInt32LE(0);
        this.buf = this.buf.subarray(4);
      }
      if (this.buf.length < this.expected) return;
      const body = this.buf.subarray(0, this.expected).toString("utf8");
      this.buf = this.buf.subarray(this.expected);
      this.expected = -1;
      onFrame(JSON.parse(body));
    }
  }
}
