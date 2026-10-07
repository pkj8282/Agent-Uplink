import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { secureDataDir, SecureDeps, MARKER_FILE, realSecureDeps } from "./secure.js";
import { isKeyText } from "../shared/auth.js";
import { hasHangul } from "./testing.js";

function tmp(name = "uplink-sec2-"): string { return fs.mkdtempSync(path.join(os.tmpdir(), name)); }

/** win32 경로를 주입으로 돌린다. calls에 호출 순서를 남긴다. */
function deps(over: Partial<SecureDeps> = {}, calls: string[] = []): SecureDeps {
  return {
    platform: "win32",
    currentUserSid: async () => "S-1-5-21-me",
    findForeign: async (_root, opts) => { calls.push(`scan:${opts.recurse}`); return { count: 0, samples: [] }; },
    restrictAcl: async () => { calls.push("acl"); return { ok: true }; },
    ...over,
  };
}

test("첫 실행: ACL → 전체 검사 → 키 2개·표식 생성", async () => {
  const d = tmp(); const calls: string[] = [];
  const k = await secureDataDir(d, deps({}, calls));
  assert.deepEqual(calls, ["acl", "scan:true"]);
  assert.ok(isKeyText(k.clientKey)); assert.ok(isKeyText(k.adminKey));
  assert.equal(fs.readFileSync(path.join(d, "client.key"), "utf8"), k.clientKey);
  assert.equal(fs.readFileSync(path.join(d, "admin.key"), "utf8"), k.adminKey);
  assert.ok(fs.existsSync(path.join(d, MARKER_FILE)));
});

test("두 번째 실행: 부분 검사만, 키는 그대로", async () => {
  const d = tmp();
  const a = await secureDataDir(d, deps());
  const calls: string[] = [];
  const b = await secureDataDir(d, deps({}, calls));
  assert.deepEqual(calls, ["acl", "scan:false"]);
  assert.deepEqual(b, a);
});

test("부분 검사 경로에 키·표식이 포함되고 허용 SID에 현재 사용자가 들어간다", async () => {
  const d = tmp(); let seen: { paths: string[]; allowed: string[] } | null = null;
  await secureDataDir(d, deps({ findForeign: async (_r, o, allowed) => { seen = { paths: o.paths, allowed }; return { count: 0, samples: [] }; } }));
  assert.deepEqual(seen!.paths.map((p) => path.basename(p)).sort(), ["admin.key", "client.key", MARKER_FILE].sort());
  assert.deepEqual(seen!.allowed, ["S-1-5-21-me", "S-1-5-32-544", "S-1-5-18"]);
});

test("RT13/RT18: 다른 소유자 항목이 있으면 시작 거부하고 키를 만들지 않는다", async () => {
  const d = tmp();
  await assert.rejects(
    secureDataDir(d, deps({ findForeign: async () => ({ count: 3, samples: [{ path: path.join(d, "channels"), owner: "S-1-5-21-other" }] }) }), "ko"),
    (e: Error) => e.message.includes("다른 사용자") && e.message.includes("S-1-5-21-other") && e.message.includes("UPLINK_DATA_DIR") && e.message.includes("3"),
  );
  assert.equal(fs.existsSync(path.join(d, "client.key")), false);
});

test("RT14: 선점된 키 파일(다른 소유자)도 같은 이유로 거부", async () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, "client.key"), "b".repeat(64));
  await assert.rejects(secureDataDir(d, deps({ findForeign: async () => ({ count: 1, samples: [{ path: path.join(d, "client.key"), owner: null }] }) }), "ko"), /다른 사용자|소유자/);
  assert.equal(fs.readFileSync(path.join(d, "client.key"), "utf8"), "b".repeat(64));
});

test("ACL 실패는 fail-closed(경고 후 진행하지 않음)", async () => {
  const d = tmp();
  await assert.rejects(secureDataDir(d, deps({ restrictAcl: async () => ({ ok: false, error: "icacls 실패" }) }), "ko"), /권한.*icacls 실패/);
  assert.equal(fs.existsSync(path.join(d, "client.key")), false);
});

test("형식이 틀린 client.key는 새로 만들고, 비어 있지 않은 admin.key는 유지", async () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, "client.key"), "garbage");
  fs.writeFileSync(path.join(d, "admin.key"), "legacy-admin-key");
  const k = await secureDataDir(d, deps());
  assert.ok(isKeyText(k.clientKey));
  assert.equal(k.adminKey, "legacy-admin-key");
});

test("비 win32: ACL·검사 없이 키 생성", async () => {
  const d = tmp(); const calls: string[] = [];
  const k = await secureDataDir(d, deps({ platform: "linux" }, calls));
  assert.deepEqual(calls, []);
  assert.ok(isKeyText(k.clientKey));
});

test("실제 PowerShell 검사: 한글 경로에서도 내 폴더는 0건(win32 전용)", { skip: process.platform !== "win32" }, async () => {
  const d = tmp("보안-테스트-");
  fs.mkdirSync(path.join(d, "하위"));
  fs.writeFileSync(path.join(d, "하위", "파일.jsonl"), "x");
  const me = await realSecureDeps.currentUserSid();
  const rep = await realSecureDeps.findForeign(d, { recurse: true, paths: [] }, [me, "S-1-5-32-544", "S-1-5-18"]);
  assert.deepEqual(rep, { count: 0, samples: [] });
  const rep2 = await realSecureDeps.findForeign(d, { recurse: true, paths: [] }, ["S-1-5-21-nobody"]);
  assert.ok(rep2.count >= 3, JSON.stringify(rep2)); // 루트·하위·파일
  assert.ok(rep2.samples.some((s) => s.path.endsWith("파일.jsonl")), JSON.stringify(rep2.samples));
  // 부분 검사(recurse=false): 루트 + 지정 경로 중 존재하는 것만
  const file = path.join(d, "하위", "파일.jsonl");
  const rep3 = await realSecureDeps.findForeign(d, { recurse: false, paths: [file, path.join(d, "없음.key")] }, ["S-1-5-21-nobody"]);
  assert.equal(rep3.count, 2, JSON.stringify(rep3));
  assert.ok(rep3.samples.some((s) => s.path === file), JSON.stringify(rep3.samples));
  // 허용 목록은 제품과 같게(관리자 권한으로 실행되면 소유자가 Administrators — CI runner 실측).
  const rep4 = await realSecureDeps.findForeign(d, { recurse: false, paths: [file] }, [me, "S-1-5-32-544", "S-1-5-18"]);
  assert.equal(rep4.count, 0, JSON.stringify(rep4));
});

test("RT13 실제 경로: ACL 잠금이 실패해도 남의 항목이 있으면 그 사실과 UPLINK_DATA_DIR를 안내한다", async () => {
  const d = tmp();
  await assert.rejects(
    secureDataDir(d, deps({
      restrictAcl: async () => ({ ok: false, error: "icacls 종료 코드 5" }),
      findForeign: async () => ({ count: 1, samples: [{ path: d, owner: "S-1-5-21-other" }] }),
    }), "ko"),
    (e: Error) => e.message.includes("다른 사용자가 만든 항목") && e.message.includes("S-1-5-21-other") && e.message.includes("UPLINK_DATA_DIR"),
  );
  assert.equal(fs.existsSync(path.join(d, "client.key")), false);
});

test("ACL 잠금만 실패하면 원인 후보와 UPLINK_DATA_DIR 안내를 준다(fail-closed)", async () => {
  const d = tmp();
  await assert.rejects(
    secureDataDir(d, deps({ restrictAcl: async () => ({ ok: false, error: "icacls 종료 코드 5" }) }), "ko"),
    (e: Error) => e.message.includes("icacls 종료 코드 5") && e.message.includes("UPLINK_DATA_DIR"),
  );
  assert.equal(fs.existsSync(path.join(d, "client.key")), false);
});

test("실제 PowerShell 검사: 호환 안 되는 PSModulePath(예: PowerShell 7에서 실행)를 물려받아도 소유자를 읽는다(win32 전용)", { skip: process.platform !== "win32" }, async () => {
  // PowerShell 7 아래에서 띄우면 그 PSModulePath를 물려받아, 5.1이 PS7용 Microsoft.PowerShell.Security를 먼저 찾고 로드에 실패한다(CI 실측).
  const fake = tmp("uplink-psmod-");
  fs.mkdirSync(path.join(fake, "Microsoft.PowerShell.Security"));
  fs.writeFileSync(path.join(fake, "Microsoft.PowerShell.Security", "Microsoft.PowerShell.Security.psd1"), "@{ ModuleVersion = '9.9.9'; GUID = 'a94c8c7e-9810-47c0-b8af-65089c13a35a'; RootModule = 'missing-ps7-only.dll'; CmdletsToExport = @('Get-Acl', 'Set-Acl') }");
  const d = tmp("보안-모듈-");
  fs.writeFileSync(path.join(d, "a.txt"), "x");
  const saved = process.env.PSModulePath;
  process.env.PSModulePath = `${fake};${saved ?? ""}`;
  try {
    const me = await realSecureDeps.currentUserSid();
    const rep = await realSecureDeps.findForeign(d, { recurse: true, paths: [] }, [me, "S-1-5-32-544", "S-1-5-18"]);
    assert.deepEqual(rep, { count: 0, samples: [] });
  } finally {
    if (saved === undefined) delete process.env.PSModulePath; else process.env.PSModulePath = saved;
  }
});

test("보안 준비 실패 안내는 언어를 따른다: 지정 없으면 폴더의 config.json, 이상한 값이면 영어", async () => {
  const foreign = (d: string) => deps({ findForeign: async () => ({ count: 2, samples: [{ path: path.join(d, "x"), owner: "S-1-5-21-other" }] }) });
  const d1 = tmp();
  await assert.rejects(secureDataDir(d1, foreign(d1), "en"), (e: Error) =>
    !hasHangul(e.message) && e.message.includes("created by another user") && e.message.includes("S-1-5-21-other") && e.message.includes("UPLINK_DATA_DIR"));
  const d2 = tmp();
  fs.writeFileSync(path.join(d2, "config.json"), JSON.stringify({ language: "ko" }));
  await assert.rejects(secureDataDir(d2, foreign(d2)), (e: Error) => e.message.includes("다른 사용자가 만든 항목"));
  const d3 = tmp();
  fs.writeFileSync(path.join(d3, "config.json"), JSON.stringify({ language: "<img src=x onerror=alert(1)>" }));
  await assert.rejects(secureDataDir(d3, foreign(d3)), (e: Error) => !hasHangul(e.message) && !e.message.includes("<img"));
  const d4 = tmp();
  await assert.rejects(secureDataDir(d4, deps({ restrictAcl: async () => ({ ok: false, error: "icacls exit code 5" }) }), "en"), (e: Error) =>
    !hasHangul(e.message) && e.message.includes("icacls exit code 5") && e.message.includes("UPLINK_DATA_DIR"));
});
