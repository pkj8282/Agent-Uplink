// tsc는 삭제된 소스의 출력물을 지우지 않으므로 빌드 전에 dist를 비운다.
import fs from "node:fs";

fs.rmSync(new URL("../dist", import.meta.url), { recursive: true, force: true });
