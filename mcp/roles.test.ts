import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { RoleStore, folderKey, parseAccountsEnv, validateRoleName } from "./roles.js";

function tmp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), "uplink-roles-")); }

test("validateRoleName: trim·대소문자 구분·40자·금지문자", () => {
  assert.deepEqual(validateRoleName("  기획 "), { ok: true, role: "기획" });
  assert.equal(validateRoleName("Plan").ok && validateRoleName("plan").ok, true);
  assert.notDeepEqual(validateRoleName("Plan"), validateRoleName("plan"));
  assert.equal(validateRoleName("").ok, false);
  assert.equal(validateRoleName("   ").ok, false);
  assert.equal(validateRoleName("가".repeat(40)).ok, true);
  assert.equal(validateRoleName("가".repeat(41)).ok, false);
  const emoji = String.fromCodePoint(0x1f600);
  assert.equal(validateRoleName(emoji.repeat(40)).ok, true); // 코드포인트 기준 40자
  for (const bad of ["a=b", "a;b", `a${String.fromCharCode(10)}b`, `a${String.fromCharCode(1)}b`, `a${String.fromCharCode(127)}b`]) {
    assert.equal(validateRoleName(bad).ok, false, JSON.stringify(bad));
  }
});

test("parseAccountsEnv: 정상·공백·오류 항목 무시·중복은 앞의 것", () => {
  const r = parseAccountsEnv(" 기획 = u-1 ; 구현=u-2;;잘못됨;=u-3;빈값=;기획=u-9;공백=a b");
  assert.deepEqual([...r.roles], [["기획", "u-1"], ["구현", "u-2"]]);
  assert.deepEqual(r.ignored, ["잘못됨", "=u-3", "빈값=", "기획=u-9", "공백=a b"]);
  assert.deepEqual([...parseAccountsEnv(undefined).roles], []);
});

test("folderKey: win32는 대소문자·끝 구분자 무시, 다른 폴더는 다름", () => {
  assert.equal(folderKey("C:\\Work\\Proj", "win32"), folderKey("c:\\work\\proj\\", "win32"));
  assert.notEqual(folderKey("C:\\Work\\Proj", "win32"), folderKey("C:\\Work\\Other", "win32"));
  assert.match(folderKey("C:\\Work\\Proj", "win32"), /^[0-9a-f]{16}$/);
});

test("RoleStore: 새 역할은 생성·저장되고 다른 인스턴스(재시작)에서 같은 UUID로 복귀", () => {
  const dataDir = tmp();
  const s1 = new RoleStore({ dataDir, cwd: "C:\\Proj" });
  const first = s1.resolve("기획");
  assert.equal(first.source, "new");
  assert.equal(first.persisted, true);
  const s2 = new RoleStore({ dataDir, cwd: "c:\\proj", platform: "win32" });
  assert.deepEqual(s2.resolve("기획"), { uuid: first.uuid, source: "local", persisted: true });
  assert.deepEqual(s2.list(), [{ role: "기획", uuid: first.uuid, source: "local" }]);
  const dir = path.join(dataDir, "state", "roles", folderKey("C:\\Proj"));
  assert.equal(fs.readFileSync(path.join(dir, "folder.txt"), "utf8"), path.resolve("C:\\Proj"));
});

test("RoleStore: 다른 폴더의 같은 역할 이름은 다른 계정", () => {
  const dataDir = tmp();
  const a = new RoleStore({ dataDir, cwd: "C:\\A" }).resolve("기획");
  const b = new RoleStore({ dataDir, cwd: "C:\\B" }).resolve("기획");
  assert.notEqual(a.uuid, b.uuid);
});

test("RoleStore: env 역할이 로컬보다 우선하고 목록은 env→local 순", () => {
  const dataDir = tmp();
  new RoleStore({ dataDir, cwd: "C:\\P" }).resolve("구현");
  new RoleStore({ dataDir, cwd: "C:\\P" }).resolve("기획"); // 로컬에도 기획이 있지만
  const s = new RoleStore({ dataDir, cwd: "C:\\P", env: "기획=env-uuid;오류항목" });
  assert.deepEqual(s.resolve("기획"), { uuid: "env-uuid", source: "env", persisted: true });
  assert.deepEqual(s.list().map((e) => [e.role, e.source]), [["기획", "env"], ["구현", "local"]]);
  assert.deepEqual(s.ignoredEnv(), ["오류항목"]);
});

test("RoleStore: 저장 실패 시 persisted:false로 이번 세션은 동작", () => {
  const blocker = path.join(tmp(), "file-not-dir");
  fs.writeFileSync(blocker, "x");
  const r = new RoleStore({ dataDir: blocker, cwd: "C:\\P" }).resolve("기획");
  assert.equal(r.source, "new");
  assert.equal(r.persisted, false);
  assert.match(r.uuid, /^[0-9a-f-]{36}$/);
});

test("RoleStore: 손상된 역할 파일은 목록에서 건너뛴다", () => {
  const dataDir = tmp();
  const s = new RoleStore({ dataDir, cwd: "C:\\P" });
  s.resolve("기획");
  const dir = path.join(dataDir, "state", "roles", folderKey("C:\\P"));
  fs.writeFileSync(path.join(dir, "deadbeefdeadbeefdeadbeefdeadbeef.json"), "{not json");
  assert.deepEqual(s.list().map((e) => e.role), ["기획"]);
});

test("validateRoleName은 C1·줄 구분자·방향 제어·폭 0 문자도 거부한다", () => {
  for (const cp of [0x85, 0x2028, 0x202e, 0x2066, 0x200b, 0x200f, 0xfeff]) {
    assert.equal(validateRoleName(`기${String.fromCodePoint(cp)}획`).ok, false, cp.toString(16));
  }
});

test("RoleStore: 손상된 역할 파일은 임의 UUID로 떨어지지 않고 복구되어 다음 실행에서도 같은 UUID", () => {
  const dataDir = tmp();
  const dir = path.join(dataDir, "state", "roles", folderKey("C:\P"));
  fs.mkdirSync(dir, { recursive: true });
  const name = createHash("sha256").update("기획", "utf8").digest("hex").slice(0, 32);
  fs.writeFileSync(path.join(dir, `${name}.json`), ""); // 반쯤 쓰인/손상된 파일
  const first = new RoleStore({ dataDir, cwd: "C:\P" }).resolve("기획");
  assert.equal(first.persisted, true);
  const again = new RoleStore({ dataDir, cwd: "C:\P" }).resolve("기획");
  assert.equal(again.uuid, first.uuid);
});

test("RoleStore: 생성 후 임시 파일을 남기지 않는다", () => {
  const dataDir = tmp();
  new RoleStore({ dataDir, cwd: "C:\P" }).resolve("기획");
  const dir = path.join(dataDir, "state", "roles", folderKey("C:\P"));
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp")), []);
});
