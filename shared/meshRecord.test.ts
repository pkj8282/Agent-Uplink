import { test } from "node:test";
import assert from "node:assert/strict";
import { generateSigningKeys } from "./connCrypto.js";
import { checkChain, openMesh, recordHash, signMesh, validRecordBody, type RecordBody } from "./meshRecord.js";

const A = generateSigningKeys();
const M = generateSigningKeys();

function body(n: number, prev: string, text = `메시지 ${n}`): RecordBody {
  return { origin: "spaceA", ch: "ch1", n, prev, seq: n, ts: 1_000 + n, from: "u1", fromName: "에이", hubUser: "에이", via: [], text };
}

test("기록 서명 왕복", () => {
  const r = signMesh("rec", body(1, ""), A);
  const b = openMesh("rec", r, A.publicKeyB64);
  assert.ok(b);
  assert.equal(b!.text, "메시지 1");
});

test("본문 한 글자 바꾸면 실패", () => {
  const r = signMesh("rec", body(1, ""), A);
  const t = { ...r, body: { ...r.body, text: "메시지 2" } };
  assert.equal(openMesh("rec", t, A.publicKeyB64), null);
});

test("다른 키로 서명한 기록은 출처 키로 열리지 않음", () => {
  const r = signMesh("rec", body(1, ""), M);
  assert.equal(openMesh("rec", r, A.publicKeyB64), null);
});

test("종류 바꿔치기(기록 서명을 명령으로) 실패", () => {
  const r = signMesh("rec", body(1, ""), A);
  assert.equal(openMesh("cmd", r, A.publicKeyB64), null);
});

test("형식 틀린 입력은 throw 없이 null", () => {
  assert.equal(openMesh("rec", null, A.publicKeyB64), null);
  assert.equal(openMesh("rec", { body: "x", signer: A.publicKeyB64, sig: "?" }, A.publicKeyB64), null);
});

test("사슬: 처음은 어느 번호든 닻, 이어지면 ok, 같은 것 dup, 건너뛰면 gap, 다르면 fork", () => {
  const r1 = signMesh("rec", body(1, ""), A).body as RecordBody;
  const h1 = recordHash(r1);
  const r2 = body(2, h1);
  const h2 = recordHash(r2);
  const hashes = new Map([[1, h1], [2, h2]]);
  const at = (n: number) => hashes.get(n);
  assert.equal(checkChain(undefined, body(7, "whatever"), at), "ok");
  assert.equal(checkChain({ n: 1, hash: h1 }, r2, at), "ok");
  assert.equal(checkChain({ n: 2, hash: h2 }, r2, at), "dup");
  assert.equal(checkChain({ n: 2, hash: h2 }, body(2, h1, "다른 내용"), at), "fork");
  assert.equal(checkChain({ n: 1, hash: h1 }, body(2, "가짜이전"), at), "fork");
  assert.equal(checkChain({ n: 1, hash: h1 }, body(5, "x"), at), "gap");
  assert.equal(checkChain({ n: 2, hash: h2 }, body(1, ""), () => undefined), "dup"); // 잘라내서 모르는 옛 번호
});

test("기록 본문 검사: 미래 5분 넘는 시각·큰 글·틀린 번호는 거부", () => {
  const now = 10_000_000;
  assert.ok(validRecordBody({ ...body(1, ""), ts: now }, now));
  assert.equal(validRecordBody({ ...body(1, ""), ts: now + 6 * 60_000 }, now), false);
  assert.equal(validRecordBody({ ...body(1, ""), text: "x".repeat(300_000) }, now), false);
  assert.equal(validRecordBody({ ...body(0, "") }, now), false);
  assert.equal(validRecordBody({ ...body(1, ""), via: Array(20).fill("s") }, now), false);
  assert.equal(validRecordBody({ ...body(1, ""), from: 5 } as unknown as RecordBody, now), false);
});
