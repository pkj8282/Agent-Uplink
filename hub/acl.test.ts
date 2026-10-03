import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { restrictDataDirAcl } from "./acl.js";

const win = process.platform === "win32";
const USERS_SID = "*S-1-5-32-545";

function acl(p: string): string {
  return execFileSync("icacls", [p], { encoding: "utf8" });
}

test("RT5: 데이터 폴더가 상속받은 Users 권한을 제거하고 하위 파일까지 현재 사용자 전용으로 만든다", { skip: !win }, async () => {
  // ProgramData처럼 Users에 읽기 권한을 상속하는 부모를 흉내 낸다.
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "uplink-acl-"));
  execFileSync("icacls", [parent, "/grant", `${USERS_SID}:(OI)(CI)RX`], { encoding: "utf8" });
  const dataDir = path.join(parent, "AgentUplink");
  fs.mkdirSync(path.join(dataDir, "accounts"), { recursive: true });
  const key = path.join(dataDir, "admin.key");
  fs.writeFileSync(key, "secret");
  assert.match(acl(key), /BUILTIN.Users/); // 전제: 상속으로 Users가 읽을 수 있다

  const r = await restrictDataDirAcl(dataDir);
  assert.equal(r.ok, true, r.error);
  for (const p of [dataDir, path.join(dataDir, "accounts"), key]) {
    assert.doesNotMatch(acl(p), /BUILTIN.Users|S-1-5-32-545|Everyone|S-1-1-0/, p);
  }
  assert.equal(fs.readFileSync(key, "utf8"), "secret"); // 현재 사용자는 계속 읽는다
  fs.writeFileSync(path.join(dataDir, "accounts", "new.json"), "{}"); // 새 파일도 쓸 수 있다
  assert.doesNotMatch(acl(path.join(dataDir, "accounts", "new.json")), /BUILTIN.Users/);
  assert.equal((await restrictDataDirAcl(dataDir)).ok, true); // 멱등
});

test("restrictDataDirAcl: 없는 폴더는 실패를 돌려주고 던지지 않는다", { skip: !win }, async () => {
  const r = await restrictDataDirAcl(path.join(os.tmpdir(), "uplink-acl-없는-폴더-zz"));
  assert.equal(r.ok, false);
});
