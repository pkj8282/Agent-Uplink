import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeFrame, FrameDecoder } from "./framing.js";

test("인코딩한 프레임을 다시 디코딩하면 원본 객체가 나온다", () => {
  const dec = new FrameDecoder();
  const out: any[] = [];
  dec.push(encodeFrame({ op: "hello", id: 1 }), (o) => out.push(o));
  assert.deepEqual(out, [{ op: "hello", id: 1 }]);
});

test("한 청크에 담긴 여러 프레임을 모두 분리한다", () => {
  const dec = new FrameDecoder();
  const out: any[] = [];
  const chunk = Buffer.concat([encodeFrame({ a: 1 }), encodeFrame({ b: 2 })]);
  dec.push(chunk, (o) => out.push(o));
  assert.deepEqual(out, [{ a: 1 }, { b: 2 }]);
});

test("바이트 단위로 쪼개 들어와도 완성된 프레임만 방출한다", () => {
  const dec = new FrameDecoder();
  const out: any[] = [];
  const frame = encodeFrame({ hello: "world" });
  for (const byte of frame) dec.push(Buffer.from([byte]), (o) => out.push(o));
  assert.deepEqual(out, [{ hello: "world" }]);
});
