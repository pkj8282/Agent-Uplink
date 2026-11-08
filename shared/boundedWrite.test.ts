import { test } from "node:test";
import assert from "node:assert/strict";
import { boundedWrite } from "./boundedWrite.js";

function sink(writableLength: number) {
  const s = {
    writableLength,
    destroyed: false,
    written: [] as Buffer[],
    write(b: Buffer) { s.written.push(b); return true; },
    destroy() { s.destroyed = true; },
  };
  return s;
}

test("boundedWrite: 상한 안이면 쓰고 true", () => {
  const s = sink(10);
  assert.equal(boundedWrite(s, Buffer.alloc(5), 15), true);
  assert.equal(s.written.length, 1);
  assert.equal(s.destroyed, false);
});

test("boundedWrite: 큐 + 프레임이 상한을 넘으면 끊고 false", () => {
  const s = sink(10);
  assert.equal(boundedWrite(s, Buffer.alloc(6), 15), false);
  assert.equal(s.written.length, 0);
  assert.equal(s.destroyed, true);
});

test("boundedWrite: 이미 끊긴 소켓엔 쓰지 않음", () => {
  const s = sink(0);
  s.destroyed = true;
  assert.equal(boundedWrite(s, Buffer.alloc(1), 15), false);
  assert.equal(s.written.length, 0);
});
