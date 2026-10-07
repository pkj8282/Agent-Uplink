// npm 배포 워크플로 정적 검사: 최소 권한, 태그에서만, 버전 일치, 이미 있는 버전 건너뛰기, 테스트 뒤 배포.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const yml = fs.readFileSync(path.join(root, ".github/workflows/npm-publish.yml"), "utf8").replace(/\r\n/g, "\n");

test("권한은 id-token: write와 contents: read뿐", () => {
  const perms = /^permissions:\n((?:[ \t]+[\w-]+:[ \t]*\w+\n)+)/m.exec(yml)![1].trim().split(/\n/).map((l) => l.trim()).sort();
  assert.deepEqual(perms, ["contents: read", "id-token: write"]);
});

test("태그 push에서 실행되고, 배포 단계는 태그 ref에서만", () => {
  assert.match(yml, /tags:\s*\["v\*"\]/);
  assert.match(yml, /if: startsWith\(github\.ref, 'refs\/tags\/'\) && steps\.exists\.outputs\.skip != 'true'/);
});

test("태그 버전 = package.json 버전 검사, 이미 있는 버전 건너뛰기, 테스트 뒤 배포, 토큰 없음", () => {
  assert.match(yml, /\[ "\$GITHUB_REF_NAME" = "v\$V" \]/);
  assert.match(yml, /npm view "agent-uplink@\$V" version/);
  const iTest = yml.indexOf("run: npm test");
  const iPublish = yml.indexOf("npm publish --access public");
  assert.ok(iTest > 0 && iPublish > iTest, "테스트가 배포보다 먼저");
  assert.match(yml, /npm install -g npm@11/);
  assert.doesNotMatch(yml, /NODE_AUTH_TOKEN|NPM_TOKEN|secrets\./); // Trusted Publishing(OIDC)
});
