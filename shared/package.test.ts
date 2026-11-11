// 배포 패키지 설정 검사: npx 진입점·shebang·Registry 이름·포함 파일·버전 일치.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const json = (rel: string) => JSON.parse(fs.readFileSync(path.join(root, rel), "utf8"));
const pkg = json("package.json");

test("npx agent-uplink는 MCP 서버를 실행한다(패키지 이름과 같은 bin)", () => {
  assert.equal(pkg.name, "agent-uplink");
  assert.equal(pkg.bin["agent-uplink"], "dist/mcp/index.js");
  assert.equal(pkg.bin["agent-uplink-mcp"], "dist/mcp/index.js");
  assert.equal(pkg.bin["agent-uplink-hub"], "dist/hub/index.js");
  assert.equal(pkg.bin["agent-uplink-viewer"], "dist/cli/viewer.js");
});

test("모든 bin 진입점 소스의 첫 줄은 #!/usr/bin/env node", () => {
  for (const out of new Set(Object.values(pkg.bin) as string[])) {
    const src = out.replace(/^dist\//, "").replace(/\.js$/, ".ts");
    const first = fs.readFileSync(path.join(root, src), "utf8").split(/\r?\n/)[0];
    assert.equal(first, "#!/usr/bin/env node", src);
  }
});

test("공개 패키지: private 없음, 포함 파일은 dist·README·LICENSE뿐", () => {
  assert.equal(pkg.private, undefined);
  assert.deepEqual(pkg.files, ["dist/", "README.md", "LICENSE"]);
  assert.equal(pkg.license, "MIT");
  assert.match(pkg.repository.url, /github\.com\/pkj8282\/Agent-Uplink/);
  assert.match(pkg.description, /Windows only/);
  assert.equal(pkg.os, undefined); // 설치는 막지 않는다(스펙 결정)
});

test("MCP Registry: mcpName = server.json 이름, 버전·식별자 일치", () => {
  const server = json("server.json");
  assert.equal(pkg.mcpName, "io.github.pkj8282/agent-uplink");
  assert.equal(server.name, pkg.mcpName);
  assert.equal(server.version, pkg.version);
  assert.equal(server.packages.length, 1);
  assert.equal(server.packages[0].registryType, "npm");
  assert.equal(server.packages[0].identifier, pkg.name);
  assert.equal(server.packages[0].version, pkg.version);
  assert.equal(server.packages[0].transport.type, "stdio");
  assert.ok(server.description.length <= 100, "Registry 설명 길이");
});

test("버전 일치: 루트·관리 앱·MCP server version", () => {
  assert.equal(json("admin/package.json").version, pkg.version);
  assert.equal(json("package-lock.json").version, pkg.version);
  assert.equal(json("admin/package-lock.json").version, pkg.version);
  const mcp = fs.readFileSync(path.join(root, "mcp/index.ts"), "utf8");
  assert.match(mcp, new RegExp(`version: "${pkg.version.replace(/\./g, "\\.")}"`));
});

test("배포 직전 클린 빌드(prepublishOnly)", () => {
  assert.match(pkg.scripts.prepublishOnly, /clean/);
  assert.match(pkg.scripts.prepublishOnly, /build/);
});

test("배포 전 typecheck: 테스트 파일까지(tsconfig.test.json) 검사한다", () => {
  assert.match(pkg.scripts.typecheck, /tsc --noEmit/);
  assert.match(pkg.scripts.typecheck, /tsconfig\.test\.json/);
  assert.match(pkg.scripts.prepublishOnly, /typecheck/);
  const tc = json("tsconfig.test.json");
  assert.equal(tc.compilerOptions.noEmit, true);
  assert.ok(!(tc.exclude as string[]).some((e) => e.includes("test")), "테스트 파일을 빼지 않는다");
});

test("npx 사용자는 lockfile 없이 받으므로 의존 범위의 하한은 테스트한(lockfile) 버전과 같은 major.minor(보안 수정 판이면 그 patch까지 올려도 됨)", () => {
  const lock = json("package-lock.json");
  for (const dep of Object.keys(pkg.dependencies)) {
    const locked = lock.packages[`node_modules/${dep}`].version as string;
    const [maj, min, patch] = locked.split(".").map(Number);
    const m = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(pkg.dependencies[dep]);
    assert.ok(m, `${dep}: ${pkg.dependencies[dep]}`);
    assert.deepEqual([Number(m[1]), Number(m[2])], [maj, min], dep);
    assert.ok(Number(m[3]) <= patch, `${dep}: 하한이 시험한 ${locked}보다 높음`);
  }
});

test("알려진 취약 판을 하한으로 허용하지 않는다(GHSA-mrhx-c7xc-m3w5 zod <4.6.6, MCP SDK 권고들 <1.32.0)", () => {
  const floor = (dep: string) => pkg.dependencies[dep].replace(/^\^/, "").split(".").map(Number);
  const atLeast = (v: number[], min: number[]) => v[0] !== min[0] ? v[0] > min[0] : v[1] !== min[1] ? v[1] > min[1] : v[2] >= min[2];
  assert.ok(atLeast(floor("zod"), [4, 6, 6]), pkg.dependencies.zod);
  assert.ok(atLeast(floor("@modelcontextprotocol/sdk"), [1, 32, 0]), pkg.dependencies["@modelcontextprotocol/sdk"]);
});
