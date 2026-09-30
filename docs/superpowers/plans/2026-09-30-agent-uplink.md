# Agent-Uplink Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 로컬 PC 안에서 여러 AI 세션이 서로 메시지를 주고받게 하는 커뮤니케이션 서버(Hub) + MCP(Agent Uplink) + 브라우저 로그 뷰어를 구현한다.

**Architecture:** 단일 Node/TS 패키지. Hub는 `127.0.0.1:47800`(TCP, 에이전트) + `127.0.0.1:47801`(HTTP, 뷰어)에서 리슨하는 단일 인스턴스 서버. MCP는 각 세션에 stdio로 붙어 Hub에 영속 TCP 연결을 유지하고, Hub가 없으면 자동으로 백그라운드 spawn한다. 포트 바인딩 자체가 단일 인스턴스 뮤텍스 역할을 한다.

**Tech Stack:** Node.js ≥ 22, TypeScript(strict, ESM/NodeNext), `@modelcontextprotocol/sdk` + `zod`(런타임), `tsx` + `typescript` + `@types/node`(개발). 테스트는 `node:test` + `tsx`(추가 프레임워크 없음).

**Spec:** `docs/superpowers/specs/2026-09-30-agent-uplink-design.md`

## Global Constraints

- **런타임**: Node.js ≥ 22 (내장 `node:test`, `--import tsx` 사용).
- **모듈**: ESM (`"type": "module"`). TS 소스의 상대 import는 **`.js` 확장자**를 붙인다(NodeNext 규칙, ESTS와 동일).
- **TypeScript**: `strict: true`.
- **바인딩 주소**: 모든 리슨은 **`127.0.0.1`** 고정. `0.0.0.0` 금지(로컬 전용).
- **포트**: TCP `47800`, HTTP 뷰어 `47801`. 환경변수 `UPLINK_TCP_PORT` / `UPLINK_HTTP_PORT`로 오버라이드.
- **데이터 경로**: `%ProgramData%\AgentUplink` (환경변수 `PROGRAMDATA` 기반). 환경변수 `UPLINK_DATA_DIR`로 오버라이드.
- **프로토콜 상수**: `MAGIC = "agent-uplink"`, `PROTOCOL_VERSION = 1`.
- **뷰어**: 외부 CDN 금지. HTML/JS/CSS 전부 인라인(로컬 전용).
- **런타임 의존성 제한**: `@modelcontextprotocol/sdk`, `zod` 외 런타임 의존성 추가 금지.
- **모든 사용자 대면 텍스트/주석/커밋 메시지**: 한국어.

## Review Focus

- **포트 오염**: `47800`을 Hub가 아닌 다른 프로세스가 점유한 경우 → 무한 재시도/무한 대기 없이 handshake 불일치를 감지해 에이전트에 명확히 보고. (Task 8 test)
- **동시 spawn 경합**: 두 MCP가 동시에 Hub를 spawn → 정확히 하나만 생존하고 나머지는 조용히 종료, 양쪽 다 연결 성공. (Task 8 test)
- **wait 중 연결 끊김**: `wait` 롱폴 대기 중 소켓이 끊기면 pending 요청이 에러로 정리되고, 다음 툴 호출에서 자동 재연결 + 동일 이름 재등록. (Task 8 test)
- **손상된 영속 로그**: `messages.jsonl`에 깨진 줄이 있어도 restore가 그 줄만 건너뛰고 나머지를 복원. (Task 3 test)
- **잘못된 입력**: 빈 `text`, 비문자 `text` → Hub가 거부(에러 응답), 저장/브로드캐스트하지 않음. (Task 5 test)

---

### Task 1: 프로젝트 스캐폴딩 + 테스트 하네스 검증

프로젝트 뼈대를 만들고, `tsx --test`가 실제로 동작하는지 사소한 테스트로 즉시 검증한다(하네스 문제를 1번에서 드러내기 위함).

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`
- Create: `shared/protocol.ts`
- Test: `shared/protocol.test.ts`

**Interfaces:**
- Produces: `shared/protocol.ts` — 상수 `MAGIC`, `PROTOCOL_VERSION`, `DEFAULT_TCP_PORT`, `DEFAULT_HTTP_PORT`; 타입 `Message`, `Request`, `Response`.

- [ ] **Step 1: `package.json` 작성**

```json
{
  "name": "agent-uplink",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "bin": {
    "agent-uplink-mcp": "dist/mcp/index.js",
    "agent-uplink-hub": "dist/hub/index.js"
  },
  "scripts": {
    "build": "tsc",
    "test": "tsx --test \"**/*.test.ts\"",
    "start:hub": "tsx hub/index.ts",
    "start:mcp": "tsx mcp/index.ts"
  },
  "engines": { "node": ">=22" },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "typescript": "^5.5.0",
    "tsx": "^4.19.0",
    "@types/node": "^22.0.0"
  }
}
```

- [ ] **Step 2: `tsconfig.json` 작성**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": ".",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": false,
    "sourceMap": false
  },
  "include": ["shared/**/*.ts", "hub/**/*.ts", "mcp/**/*.ts"],
  "exclude": ["node_modules", "dist", "**/*.test.ts"]
}
```

- [ ] **Step 3: `.gitignore` 작성**

```
node_modules/
dist/
*.log
```

- [ ] **Step 4: `shared/protocol.ts` 작성**

```ts
// 프로토콜 상수와 요청/응답/메시지 타입 정의.
export const MAGIC = "agent-uplink";
export const PROTOCOL_VERSION = 1;
export const DEFAULT_TCP_PORT = 47800;
export const DEFAULT_HTTP_PORT = 47801;

export interface Message {
  seq: number;        // Hub의 단조 증가 정수
  ts: number;         // epoch ms
  from: string;       // 보낸 세션 이름
  to: string | null;  // 대상 세션 이름, 전체면 null
  text: string;
}

export type Request =
  | { op: "hello"; id: number }
  | { op: "register"; id: number; name?: string }
  | { op: "send"; id: number; text: string; to?: string | null }
  | { op: "check"; id: number }
  | { op: "wait"; id: number; timeoutMs?: number }
  | { op: "who"; id: number };

export interface Response {
  ok: boolean;
  id: number;
  magic?: string;                               // hello
  version?: number;                             // hello
  sessionId?: string;                           // register
  name?: string;                                // register
  seq?: number;                                 // send
  messages?: Message[];                         // check/wait
  sessions?: { name: string; since: number }[]; // who
  error?: string;
}
```

- [ ] **Step 5: 하네스 검증용 테스트 작성 (`shared/protocol.test.ts`)**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { MAGIC, PROTOCOL_VERSION, DEFAULT_TCP_PORT, DEFAULT_HTTP_PORT } from "./protocol.js";

test("프로토콜 상수가 스펙과 일치한다", () => {
  assert.equal(MAGIC, "agent-uplink");
  assert.equal(PROTOCOL_VERSION, 1);
  assert.equal(DEFAULT_TCP_PORT, 47800);
  assert.equal(DEFAULT_HTTP_PORT, 47801);
});
```

- [ ] **Step 6: 의존성 설치 후 테스트 실행(실패가 아니라 통과 확인 — 하네스 검증)**

Run: `npm install && npx tsx --test shared/protocol.test.ts`
Expected: 테스트 1개 PASS. (실패 시 tsx/node 버전 문제이므로 여기서 해결하고 진행)

- [ ] **Step 7: Commit**

```bash
git add package.json tsconfig.json .gitignore shared/protocol.ts shared/protocol.test.ts
git commit -m "빌드: 프로젝트 스캐폴딩과 프로토콜 타입 정의"
```

---

### Task 2: 길이 프리픽스 JSON 프레이밍

TCP 스트림에서 메시지 경계를 복원하는 프레이밍. 순수 함수라 단독 테스트가 쉽다.

**Files:**
- Create: `shared/framing.ts`
- Test: `shared/framing.test.ts`

**Interfaces:**
- Produces: `encodeFrame(obj: unknown): Buffer`; `class FrameDecoder { push(chunk: Buffer, onFrame: (obj: any) => void): void }`.

- [ ] **Step 1: 실패하는 테스트 작성 (`shared/framing.test.ts`)**

```ts
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
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx tsx --test shared/framing.test.ts`
Expected: FAIL ("Cannot find module './framing.js'" 또는 export 없음).

- [ ] **Step 3: 최소 구현 (`shared/framing.ts`)**

```ts
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
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx tsx --test shared/framing.test.ts`
Expected: 3개 PASS.

- [ ] **Step 5: Commit**

```bash
git add shared/framing.ts shared/framing.test.ts
git commit -m "기능: 길이 프리픽스 JSON 프레이밍(인코더/디코더)"
```

---

### Task 3: 메시지 저장소 (링버퍼 + JSONL)

메시지 저장, seq 부여, 커서 기반 필터 조회, 파일 append/회전/복원.

**Files:**
- Create: `hub/store.ts`
- Test: `hub/store.test.ts`

**Interfaces:**
- Consumes: `Message` (shared/protocol.ts).
- Produces: `class MessageStore` with:
  - `constructor(opts: { dir: string; ringSize?: number; rotateBytes?: number })`
  - `append(from: string, to: string | null, text: string): Message`
  - `since(afterSeq: number, name: string): Message[]` — `seq > afterSeq && from !== name && (to === null || to === name)`
  - `recent(limit: number): Message[]`
  - `get lastSeq(): number`

- [ ] **Step 1: 실패하는 테스트 작성 (`hub/store.test.ts`)**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MessageStore } from "./store.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "uplink-store-"));
}

test("append는 seq를 1부터 단조 증가시킨다", () => {
  const store = new MessageStore({ dir: tmpDir() });
  const a = store.append("A", null, "첫번째");
  const b = store.append("B", null, "두번째");
  assert.equal(a.seq, 1);
  assert.equal(b.seq, 2);
  assert.equal(store.lastSeq, 2);
});

test("since는 커서 이후, 대상 일치, 자기 메시지 제외로 필터한다", () => {
  const store = new MessageStore({ dir: tmpDir() });
  store.append("A", null, "전체1");      // seq1
  store.append("B", "A", "A에게");        // seq2
  store.append("B", "C", "C에게");        // seq3
  store.append("A", null, "A자신전체");   // seq4
  const forA = store.since(0, "A");
  assert.deepEqual(forA.map((m) => m.text), ["전체1", "A에게"]); // seq4는 from==A라 제외
});

test("링버퍼 크기를 넘으면 오래된 메시지를 버린다", () => {
  const store = new MessageStore({ dir: tmpDir(), ringSize: 3 });
  for (let i = 1; i <= 5; i++) store.append("A", null, `m${i}`);
  const recent = store.recent(10);
  assert.deepEqual(recent.map((m) => m.text), ["m3", "m4", "m5"]);
});

test("JSONL을 다시 읽어 seq와 최근 메시지를 복원한다", () => {
  const dir = tmpDir();
  const s1 = new MessageStore({ dir });
  s1.append("A", null, "영속1");
  s1.append("A", null, "영속2");
  const s2 = new MessageStore({ dir });
  assert.equal(s2.lastSeq, 2);              // seq 이어감
  assert.equal(s2.recent(10).length, 2);
  assert.equal(s2.append("A", null, "영속3").seq, 3);
});

test("손상된 JSONL 줄은 건너뛰고 나머지를 복원한다", () => {
  const dir = tmpDir();
  const file = path.join(dir, "messages.jsonl");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({ seq: 1, ts: 1, from: "A", to: null, text: "정상" }) + "\n" +
      "{깨진 JSON\n" +
      JSON.stringify({ seq: 2, ts: 2, from: "B", to: null, text: "정상2" }) + "\n",
  );
  const store = new MessageStore({ dir });
  assert.equal(store.lastSeq, 2);
  assert.deepEqual(store.recent(10).map((m) => m.text), ["정상", "정상2"]);
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx tsx --test hub/store.test.ts`
Expected: FAIL (모듈 없음).

- [ ] **Step 3: 최소 구현 (`hub/store.ts`)**

```ts
import fs from "node:fs";
import path from "node:path";
import { Message } from "../shared/protocol.js";

export interface StoreOptions {
  dir: string;
  ringSize?: number;
  rotateBytes?: number;
}

export class MessageStore {
  private ring: Message[] = [];
  private readonly ringSize: number;
  private readonly rotateBytes: number;
  private seq = 0;
  private readonly file: string;

  constructor(opts: StoreOptions) {
    this.ringSize = opts.ringSize ?? 1000;
    this.rotateBytes = opts.rotateBytes ?? 10 * 1024 * 1024;
    this.file = path.join(opts.dir, "messages.jsonl");
    fs.mkdirSync(opts.dir, { recursive: true });
    this.restore();
  }

  private restore(): void {
    if (!fs.existsSync(this.file)) return;
    const lines = fs.readFileSync(this.file, "utf8").split("\n").filter(Boolean);
    for (const line of lines.slice(-Math.max(this.ringSize, 200))) {
      try {
        const m = JSON.parse(line) as Message;
        this.ring.push(m);
        if (m.seq > this.seq) this.seq = m.seq;
      } catch {
        // 손상된 줄은 무시
      }
    }
    if (this.ring.length > this.ringSize) this.ring = this.ring.slice(-this.ringSize);
  }

  append(from: string, to: string | null, text: string): Message {
    const msg: Message = { seq: ++this.seq, ts: Date.now(), from, to, text };
    this.ring.push(msg);
    if (this.ring.length > this.ringSize) this.ring.shift();
    this.writeLine(msg);
    return msg;
  }

  private writeLine(msg: Message): void {
    try {
      if (fs.existsSync(this.file) && fs.statSync(this.file).size > this.rotateBytes) {
        fs.renameSync(this.file, this.file + ".1");
      }
      fs.appendFileSync(this.file, JSON.stringify(msg) + "\n");
    } catch {
      // 디스크 오류 시에도 인메모리 링은 유지한다
    }
  }

  since(afterSeq: number, name: string): Message[] {
    return this.ring.filter(
      (m) => m.seq > afterSeq && m.from !== name && (m.to === null || m.to === name),
    );
  }

  recent(limit: number): Message[] {
    return this.ring.slice(-limit);
  }

  get lastSeq(): number {
    return this.seq;
  }
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx tsx --test hub/store.test.ts`
Expected: 5개 PASS.

- [ ] **Step 5: Commit**

```bash
git add hub/store.ts hub/store.test.ts
git commit -m "기능: 메시지 저장소(링버퍼 + JSONL 영속/복원/회전)"
```

---

### Task 4: 세션 레지스트리

접속한 세션의 이름 부여(자동/지정), 중복 회피, 목록, 제거를 담당. 커서와 wait 대기 상태를 세션에 보관.

**Files:**
- Create: `hub/sessions.ts`
- Test: `hub/sessions.test.ts`

**Interfaces:**
- Consumes: `Message` (shared/protocol.ts).
- Produces:
  - `interface Waiter { resolve: (msgs: Message[]) => void; timer: NodeJS.Timeout }`
  - `class Session { name: string; since: number; lastDeliveredSeq: number; waiter: Waiter | null }`
  - `class SessionRegistry` with:
    - `create(startSeq: number): Session` — 자동 이름 `uplink-N`, `lastDeliveredSeq = startSeq`
    - `rename(s: Session, name: string): string` — 중복 시 `-2`, `-3` … 부여, 최종 이름 반환
    - `remove(s: Session): void`
    - `list(): { name: string; since: number }[]`
    - `all(): Session[]`

- [ ] **Step 1: 실패하는 테스트 작성 (`hub/sessions.test.ts`)**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionRegistry } from "./sessions.js";

test("create는 uplink-1, uplink-2로 자동 이름을 준다", () => {
  const reg = new SessionRegistry();
  assert.equal(reg.create(0).name, "uplink-1");
  assert.equal(reg.create(0).name, "uplink-2");
});

test("create의 startSeq가 세션의 초기 커서가 된다", () => {
  const reg = new SessionRegistry();
  assert.equal(reg.create(42).lastDeliveredSeq, 42);
});

test("rename은 중복 이름에 접미사를 붙인다", () => {
  const reg = new SessionRegistry();
  const a = reg.create(0);
  const b = reg.create(0);
  assert.equal(reg.rename(a, "A"), "A");
  assert.equal(reg.rename(b, "A"), "A-2");
});

test("rename은 자기 자신과는 충돌로 보지 않는다", () => {
  const reg = new SessionRegistry();
  const a = reg.create(0);
  assert.equal(reg.rename(a, "A"), "A");
  assert.equal(reg.rename(a, "A"), "A"); // 다시 같은 이름은 그대로
});

test("remove 후 list에서 사라진다", () => {
  const reg = new SessionRegistry();
  const a = reg.create(0);
  reg.rename(a, "A");
  reg.create(0);
  reg.remove(a);
  assert.deepEqual(reg.list().map((s) => s.name), ["uplink-2"]);
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx tsx --test hub/sessions.test.ts`
Expected: FAIL (모듈 없음).

- [ ] **Step 3: 최소 구현 (`hub/sessions.ts`)**

```ts
import { Message } from "../shared/protocol.js";

export interface Waiter {
  resolve: (msgs: Message[]) => void;
  timer: NodeJS.Timeout;
}

export class Session {
  name: string;
  since = Date.now();
  lastDeliveredSeq = 0;
  waiter: Waiter | null = null;
  constructor(name: string) {
    this.name = name;
  }
}

export class SessionRegistry {
  private sessions = new Set<Session>();
  private autoCounter = 0;

  create(startSeq: number): Session {
    const s = new Session(`uplink-${++this.autoCounter}`);
    s.lastDeliveredSeq = startSeq;
    this.sessions.add(s);
    return s;
  }

  rename(s: Session, name: string): string {
    let candidate = name;
    let n = 1;
    const taken = () => [...this.sessions].some((x) => x !== s && x.name === candidate);
    while (taken()) candidate = `${name}-${++n}`;
    s.name = candidate;
    return candidate;
  }

  remove(s: Session): void {
    if (s.waiter) {
      clearTimeout(s.waiter.timer);
      s.waiter = null;
    }
    this.sessions.delete(s);
  }

  list(): { name: string; since: number }[] {
    return [...this.sessions].map((s) => ({ name: s.name, since: s.since }));
  }

  all(): Session[] {
    return [...this.sessions];
  }
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx tsx --test hub/sessions.test.ts`
Expected: 5개 PASS.

- [ ] **Step 5: Commit**

```bash
git add hub/sessions.ts hub/sessions.test.ts
git commit -m "기능: 세션 레지스트리(자동 이름/중복 회피/커서)"
```

---

### Task 5: Hub 서버 코어 (TCP dispatch)

TCP 연결을 받아 프레임을 파싱하고 op를 처리한다. HTTP/뷰어는 Task 6에서 추가하므로 여기서는 TCP만.

**Files:**
- Create: `hub/server.ts`
- Test: `hub/server.test.ts`

**Interfaces:**
- Consumes: `encodeFrame`/`FrameDecoder` (Task 2), `MessageStore` (Task 3), `SessionRegistry`/`Session` (Task 4), `MAGIC`/`PROTOCOL_VERSION`/`Message`/`Request`/`Response` (Task 1).
- Produces:
  - `interface HubOptions { tcpPort: number; httpPort: number; dataDir: string; idleShutdownMs: number }`
  - `class Hub` with `startTcp(): Promise<void>`, `stop(): void`, `get tcpAddress(): { port: number }`, and internal `dispatch`/`broadcast`. (HTTP는 Task 6에서 `startHttp` 추가.)

> 참고: 이 Task의 테스트는 spawn 없이 **같은 프로세스에서 Hub를 생성**하고 `net` 클라이언트로 접속해 검증한다. 포트 충돌을 피하려고 `tcpPort: 0`(임의 빈 포트)을 쓰고 `tcpAddress`로 실제 포트를 얻는다.

- [ ] **Step 1: 실패하는 테스트 작성 (`hub/server.test.ts`)**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { encodeFrame, FrameDecoder } from "../shared/framing.js";
import { Hub } from "./server.js";
import { Response } from "../shared/protocol.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "uplink-hub-"));
}

// 한 연결에서 요청을 보내고 id로 응답을 받는 소형 클라이언트
class TestClient {
  private sock: net.Socket;
  private dec = new FrameDecoder();
  private waiters = new Map<number, (r: Response) => void>();
  private id = 0;
  constructor(port: number) {
    this.sock = net.connect(port, "127.0.0.1");
    this.sock.on("data", (d) =>
      this.dec.push(d, (r: Response) => this.waiters.get(r.id)?.(r)),
    );
  }
  ready(): Promise<void> {
    return new Promise((res) => this.sock.once("connect", () => res()));
  }
  req(op: string, params: object = {}): Promise<Response> {
    const id = ++this.id;
    return new Promise((resolve) => {
      this.waiters.set(id, resolve);
      this.sock.write(encodeFrame({ op, id, ...params }));
    });
  }
  close(): void {
    this.sock.destroy();
  }
}

async function startHub() {
  const hub = new Hub({ tcpPort: 0, httpPort: 0, dataDir: tmpDir(), idleShutdownMs: 0 });
  await hub.startTcp();
  return { hub, port: hub.tcpAddress.port };
}

test("hello는 매직과 버전을 돌려준다", async () => {
  const { hub, port } = await startHub();
  const c = new TestClient(port);
  await c.ready();
  const r = await c.req("hello");
  assert.equal(r.ok, true);
  assert.equal(r.magic, "agent-uplink");
  assert.equal(r.version, 1);
  c.close();
  hub.stop();
});

test("register는 지정 이름을, 미지정 시 자동 이름을 준다", async () => {
  const { hub, port } = await startHub();
  const a = new TestClient(port); await a.ready();
  const b = new TestClient(port); await b.ready();
  assert.equal((await a.req("register", { name: "A" })).name, "A");
  assert.match((await b.req("register")).name!, /^uplink-\d+$/);
  a.close(); b.close(); hub.stop();
});

test("send한 브로드캐스트를 다른 세션이 check로 받고, 보낸 자신은 못 받는다", async () => {
  const { hub, port } = await startHub();
  const a = new TestClient(port); await a.ready(); await a.req("register", { name: "A" });
  const b = new TestClient(port); await b.ready(); await b.req("register", { name: "B" });
  await a.req("send", { text: "안녕 전체" });
  const rb = await b.req("check");
  assert.deepEqual(rb.messages!.map((m) => m.text), ["안녕 전체"]);
  const ra = await a.req("check");
  assert.deepEqual(ra.messages, []); // 자기 메시지 제외
  a.close(); b.close(); hub.stop();
});

test("to로 대상 지정 시 그 세션만 받는다", async () => {
  const { hub, port } = await startHub();
  const a = new TestClient(port); await a.ready(); await a.req("register", { name: "A" });
  const b = new TestClient(port); await b.ready(); await b.req("register", { name: "B" });
  const c = new TestClient(port); await c.ready(); await c.req("register", { name: "C" });
  await a.req("send", { text: "B만 봐", to: "B" });
  assert.equal((await b.req("check")).messages!.length, 1);
  assert.equal((await c.req("check")).messages!.length, 0);
  a.close(); b.close(); c.close(); hub.stop();
});

test("빈 text는 거부한다", async () => {
  const { hub, port } = await startHub();
  const a = new TestClient(port); await a.ready(); await a.req("register", { name: "A" });
  const r = await a.req("send", { text: "" });
  assert.equal(r.ok, false);
  a.close(); hub.stop();
});

test("wait는 새 메시지가 오면 즉시 반환한다", async () => {
  const { hub, port } = await startHub();
  const a = new TestClient(port); await a.ready(); await a.req("register", { name: "A" });
  const b = new TestClient(port); await b.ready(); await b.req("register", { name: "B" });
  const waiting = b.req("wait", { timeoutMs: 5000 });
  setTimeout(() => a.req("send", { text: "깨어나" }), 50);
  const r = await waiting;
  assert.deepEqual(r.messages!.map((m) => m.text), ["깨어나"]);
  a.close(); b.close(); hub.stop();
});

test("wait는 타임아웃 시 빈 배열을 준다", async () => {
  const { hub, port } = await startHub();
  const a = new TestClient(port); await a.ready(); await a.req("register", { name: "A" });
  const r = await a.req("wait", { timeoutMs: 1000 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.messages, []);
  a.close(); hub.stop();
});

test("who는 접속 세션 목록을 준다", async () => {
  const { hub, port } = await startHub();
  const a = new TestClient(port); await a.ready(); await a.req("register", { name: "A" });
  const b = new TestClient(port); await b.ready(); await b.req("register", { name: "B" });
  const names = (await a.req("who")).sessions!.map((s) => s.name).sort();
  assert.deepEqual(names, ["A", "B"]);
  a.close(); b.close(); hub.stop();
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx tsx --test hub/server.test.ts`
Expected: FAIL (모듈 없음).

- [ ] **Step 3: 최소 구현 (`hub/server.ts`)**

```ts
import net from "node:net";
import { encodeFrame, FrameDecoder } from "../shared/framing.js";
import { MessageStore } from "./store.js";
import { SessionRegistry, Session } from "./sessions.js";
import { MAGIC, PROTOCOL_VERSION, Message, Request, Response } from "../shared/protocol.js";

export interface HubOptions {
  tcpPort: number;
  httpPort: number;
  dataDir: string;
  idleShutdownMs: number; // 0이면 자동 종료 안 함
}

export class Hub {
  protected store: MessageStore;
  private registry = new SessionRegistry();
  private tcp: net.Server;
  private idleTimer: NodeJS.Timeout | null = null;
  protected opts: HubOptions;

  constructor(opts: HubOptions) {
    this.opts = opts;
    this.store = new MessageStore({ dir: opts.dataDir });
    this.tcp = net.createServer((sock) => this.onConnection(sock));
  }

  startTcp(): Promise<void> {
    return new Promise((resolve, reject) => {
      const onErr = (e: Error) => reject(e);
      this.tcp.once("error", onErr);
      this.tcp.listen(this.opts.tcpPort, "127.0.0.1", () => {
        this.tcp.off("error", onErr);
        resolve();
      });
    });
  }

  get tcpAddress(): { port: number } {
    const a = this.tcp.address();
    if (a && typeof a === "object") return { port: a.port };
    return { port: this.opts.tcpPort };
  }

  stop(): void {
    this.tcp.close();
    for (const s of this.registry.all()) this.registry.remove(s);
  }

  private onConnection(sock: net.Socket): void {
    this.cancelIdle();
    const dec = new FrameDecoder();
    const state: { session: Session | null } = { session: null };
    sock.on("data", (chunk) => {
      dec.push(chunk, (req: Request) => {
        state.session = this.dispatch(sock, state.session, req);
      });
    });
    sock.on("close", () => {
      if (state.session) this.registry.remove(state.session);
      this.maybeIdle();
    });
    sock.on("error", () => {
      /* close가 뒤따른다 */
    });
  }

  private dispatch(sock: net.Socket, session: Session | null, req: Request): Session | null {
    const reply = (r: Omit<Response, "id">) => sock.write(encodeFrame({ ...r, id: req.id }));
    const ensure = (): Session => {
      if (!session) session = this.registry.create(this.store.lastSeq);
      return session;
    };

    switch (req.op) {
      case "hello":
        reply({ ok: true, magic: MAGIC, version: PROTOCOL_VERSION });
        return session;

      case "register": {
        const s = ensure();
        const name = req.name ? this.registry.rename(s, req.name) : s.name;
        reply({ ok: true, sessionId: name, name });
        return s;
      }

      case "send": {
        const s = ensure();
        if (typeof req.text !== "string" || req.text.length === 0) {
          reply({ ok: false, error: "text는 비어있지 않은 문자열이어야 합니다" });
          return s;
        }
        const to = req.to && req.to.length ? req.to : null;
        const msg = this.store.append(s.name, to, req.text);
        reply({ ok: true, seq: msg.seq });
        this.broadcast(msg);
        return s;
      }

      case "check": {
        const s = ensure();
        const msgs = this.store.since(s.lastDeliveredSeq, s.name);
        if (msgs.length) s.lastDeliveredSeq = msgs[msgs.length - 1].seq;
        reply({ ok: true, messages: msgs });
        return s;
      }

      case "wait": {
        const s = ensure();
        const msgs = this.store.since(s.lastDeliveredSeq, s.name);
        if (msgs.length) {
          s.lastDeliveredSeq = msgs[msgs.length - 1].seq;
          reply({ ok: true, messages: msgs });
          return s;
        }
        const timeoutMs = Math.min(Math.max(req.timeoutMs ?? 30000, 1000), 120000);
        if (s.waiter) {
          clearTimeout(s.waiter.timer);
          s.waiter = null;
        }
        const timer = setTimeout(() => {
          s.waiter = null;
          reply({ ok: true, messages: [] });
        }, timeoutMs);
        s.waiter = {
          resolve: (m: Message[]) => reply({ ok: true, messages: m }),
          timer,
        };
        return s;
      }

      case "who": {
        const s = ensure();
        reply({ ok: true, sessions: this.registry.list() });
        return s;
      }

      default:
        reply({ ok: false, error: "알 수 없는 op" });
        return session;
    }
  }

  protected broadcast(msg: Message): void {
    for (const s of this.registry.all()) {
      if (s.waiter && s.name !== msg.from && (msg.to === null || msg.to === s.name)) {
        const w = s.waiter;
        s.waiter = null;
        clearTimeout(w.timer);
        s.lastDeliveredSeq = msg.seq;
        w.resolve([msg]);
      }
    }
  }

  private maybeIdle(): void {
    if (this.opts.idleShutdownMs <= 0) return;
    if (this.registry.all().length > 0) return;
    this.idleTimer = setTimeout(() => this.stop(), this.opts.idleShutdownMs);
    this.idleTimer.unref();
  }

  private cancelIdle(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx tsx --test hub/server.test.ts`
Expected: 8개 PASS.

- [ ] **Step 5: Commit**

```bash
git add hub/server.ts hub/server.test.ts
git commit -m "기능: Hub 서버 코어(register/send/check/wait/who dispatch)"
```

---

### Task 6: 브라우저 로그 뷰어 (HTTP + SSE)

Hub에 HTTP 서버를 붙여, 최근 메시지를 렌더하고 SSE로 실시간 갱신하는 뷰어 페이지를 제공한다.

**Files:**
- Create: `hub/viewer.ts`
- Modify: `hub/server.ts` (HTTP 서버, SSE 클라이언트 관리, `broadcast`에서 SSE push, `startHttp`/`stop` 갱신)
- Test: `hub/viewer.test.ts`

**Interfaces:**
- Produces: `renderViewerHtml(): string`; `Hub.startHttp(): Promise<void>`; `Hub.get httpAddress(): { port: number }`.
- Consumes: `MessageStore.recent` (Task 3).

- [ ] **Step 1: 실패하는 테스트 작성 (`hub/viewer.test.ts`)**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { encodeFrame } from "../shared/framing.js";
import { Hub } from "./server.js";
import { renderViewerHtml } from "./viewer.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "uplink-viewer-"));
}

test("renderViewerHtml은 외부 CDN을 참조하지 않는 HTML을 만든다", () => {
  const html = renderViewerHtml();
  assert.match(html, /<!doctype html>/i);
  assert.doesNotMatch(html, /https?:\/\//i); // 외부 링크 없음(로컬 전용)
  assert.match(html, /EventSource\(/); // SSE 연결 코드 포함
});

test("루트 경로는 HTML을, /events는 SSE 초기 스냅샷을 준다", async () => {
  const hub = new Hub({ tcpPort: 0, httpPort: 0, dataDir: tmpDir(), idleShutdownMs: 0 });
  await hub.startTcp();
  await hub.startHttp();
  const port = hub.httpAddress.port;

  const html = await new Promise<string>((resolve) => {
    http.get({ host: "127.0.0.1", port, path: "/" }, (res) => {
      let b = ""; res.on("data", (d) => (b += d)); res.on("end", () => resolve(b));
    });
  });
  assert.match(html, /<!doctype html>/i);

  const initEvent = await new Promise<string>((resolve) => {
    http.get({ host: "127.0.0.1", port, path: "/events" }, (res) => {
      res.on("data", (d) => resolve(String(d))); // 첫 이벤트(init)만 확인
    });
  });
  assert.match(initEvent, /event: init/);
  hub.stop();
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx tsx --test hub/viewer.test.ts`
Expected: FAIL (viewer.ts 없음, `startHttp` 없음).

- [ ] **Step 3: `hub/viewer.ts` 작성**

```ts
// 로컬 전용 로그 뷰어 페이지. 외부 의존성 없이 인라인 HTML/CSS/JS.
export function renderViewerHtml(): string {
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Agent-Uplink 로그</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: ui-monospace, Consolas, monospace; margin: 0; padding: 12px; }
  h1 { font-size: 14px; opacity: 0.7; margin: 0 0 8px; }
  #log { display: flex; flex-direction: column; gap: 2px; }
  .row { padding: 3px 6px; border-radius: 4px; background: rgba(127,127,127,0.08); }
  .meta { opacity: 0.6; margin-right: 6px; }
  .to { color: #d08; }
</style>
</head>
<body>
<h1>Agent-Uplink 로그 (127.0.0.1)</h1>
<div id="log"></div>
<script>
  const log = document.getElementById("log");
  function fmt(m) {
    const t = new Date(m.ts).toLocaleTimeString();
    const target = m.to ? m.to : "ALL";
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML =
      '<span class="meta">[' + t + ' ' + m.from + '\u2192<span class="to">' +
      target + '</span>]</span>';
    row.appendChild(document.createTextNode(m.text));
    log.appendChild(row);
    window.scrollTo(0, document.body.scrollHeight);
  }
  const es = new EventSource("/events");
  es.addEventListener("init", (e) => JSON.parse(e.data).forEach(fmt));
  es.onmessage = (e) => fmt(JSON.parse(e.data));
</script>
</body>
</html>`;
}
```

- [ ] **Step 4: `hub/server.ts` 수정 — HTTP/SSE 추가**

`hub/server.ts` 상단 import에 추가:

```ts
import http from "node:http";
import { renderViewerHtml } from "./viewer.js";
```

`Hub` 클래스에 필드 추가(기존 필드 옆):

```ts
  private http: http.Server;
  private sseClients = new Set<http.ServerResponse>();
```

생성자 끝(`this.store = ...` 다음 줄)에 추가:

```ts
    this.http = http.createServer((req, res) => this.onHttp(req, res));
```

`get tcpAddress` 아래에 메서드 추가:

```ts
  startHttp(): Promise<void> {
    return new Promise((resolve) => {
      this.http.once("error", () => resolve()); // 뷰어 포트 실패는 치명적이지 않다
      this.http.listen(this.opts.httpPort, "127.0.0.1", () => resolve());
    });
  }

  get httpAddress(): { port: number } {
    const a = this.http.address();
    if (a && typeof a === "object") return { port: a.port };
    return { port: this.opts.httpPort };
  }

  private onHttp(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.url === "/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(`event: init\ndata: ${JSON.stringify(this.store.recent(200))}\n\n`);
      this.sseClients.add(res);
      req.on("close", () => this.sseClients.delete(res));
    } else {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(renderViewerHtml());
    }
  }

  private pushSse(msg: Message): void {
    const data = `data: ${JSON.stringify(msg)}\n\n`;
    for (const res of this.sseClients) res.write(data);
  }
```

`broadcast` 메서드 마지막 줄(닫는 `}` 직전)에 SSE push 추가:

```ts
    this.pushSse(msg);
```

`stop` 메서드에 HTTP 종료와 SSE 정리 추가:

```ts
  stop(): void {
    this.tcp.close();
    this.http.close();
    for (const res of this.sseClients) res.end();
    this.sseClients.clear();
    for (const s of this.registry.all()) this.registry.remove(s);
  }
```

- [ ] **Step 5: 테스트 통과 확인 (뷰어 + 기존 서버 테스트 회귀 확인)**

Run: `npx tsx --test hub/viewer.test.ts hub/server.test.ts`
Expected: 뷰어 2개 + 서버 8개 = 10개 PASS.

- [ ] **Step 6: Commit**

```bash
git add hub/viewer.ts hub/server.ts hub/viewer.test.ts
git commit -m "기능: 브라우저 로그 뷰어(HTTP + SSE 실시간)"
```

---

### Task 7: Hub 진입점

환경변수로 옵션을 만들고 Hub를 기동한다. 포트 경합(`EADDRINUSE`)이면 조용히 종료(경쟁 패배 = 다른 Hub 승리). 기동 성공 시 `hub.json` 기록.

**Files:**
- Create: `hub/options.ts` (환경변수 → 옵션, 테스트 대상)
- Create: `hub/index.ts` (실행 진입점)
- Test: `hub/options.test.ts`

**Interfaces:**
- Consumes: `HubOptions` (Task 5).
- Produces:
  - `resolveOptions(env: NodeJS.ProcessEnv): HubOptions & { infoPath: string }`
  - `hub/index.ts` — 실행 시 Hub 기동, EADDRINUSE 시 `process.exit(0)`.

- [ ] **Step 1: 실패하는 테스트 작성 (`hub/options.test.ts`)**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveOptions } from "./options.js";

test("기본값은 47800/47801과 ProgramData 경로를 쓴다", () => {
  const o = resolveOptions({ PROGRAMDATA: "C:\\ProgramData" } as any);
  assert.equal(o.tcpPort, 47800);
  assert.equal(o.httpPort, 47801);
  assert.match(o.dataDir, /AgentUplink/);
  assert.equal(o.idleShutdownMs, 10 * 60 * 1000);
});

test("환경변수로 포트와 유휴 종료를 오버라이드한다", () => {
  const o = resolveOptions({
    PROGRAMDATA: "C:\\ProgramData",
    UPLINK_TCP_PORT: "50000",
    UPLINK_HTTP_PORT: "50001",
    UPLINK_IDLE_MINUTES: "0",
  } as any);
  assert.equal(o.tcpPort, 50000);
  assert.equal(o.httpPort, 50001);
  assert.equal(o.idleShutdownMs, 0);
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx tsx --test hub/options.test.ts`
Expected: FAIL (모듈 없음).

- [ ] **Step 3: `hub/options.ts` 작성**

```ts
import path from "node:path";
import { HubOptions } from "./server.js";

export function resolveOptions(env: NodeJS.ProcessEnv): HubOptions & { infoPath: string } {
  const base = env.UPLINK_DATA_DIR ?? path.join(env.PROGRAMDATA ?? ".", "AgentUplink");
  const idleMin = env.UPLINK_IDLE_MINUTES !== undefined ? Number(env.UPLINK_IDLE_MINUTES) : 10;
  return {
    tcpPort: Number(env.UPLINK_TCP_PORT ?? 47800),
    httpPort: Number(env.UPLINK_HTTP_PORT ?? 47801),
    dataDir: base,
    idleShutdownMs: (Number.isFinite(idleMin) ? idleMin : 10) * 60 * 1000,
    infoPath: path.join(base, "hub.json"),
  };
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx tsx --test hub/options.test.ts`
Expected: 2개 PASS.

- [ ] **Step 5: `hub/index.ts` 작성 (진입점 — 실행 스크립트, 단위 테스트 없음)**

```ts
import fs from "node:fs";
import { Hub } from "./server.js";
import { resolveOptions } from "./options.js";

async function main(): Promise<void> {
  const opts = resolveOptions(process.env);
  const hub = new Hub(opts);
  try {
    await hub.startTcp();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EADDRINUSE") {
      // 다른 Hub가 이미 포트를 점유했다. 경쟁에서 졌으므로 조용히 종료.
      process.exit(0);
    }
    process.stderr.write(`Hub 시작 실패: ${(e as Error).message}\n`);
    process.exit(1);
  }
  await hub.startHttp();

  try {
    fs.mkdirSync(opts.dataDir, { recursive: true });
    fs.writeFileSync(
      opts.infoPath,
      JSON.stringify(
        { tcpPort: opts.tcpPort, httpPort: opts.httpPort, pid: process.pid, startedAt: Date.now() },
        null,
        2,
      ),
    );
  } catch {
    // 정보 파일 실패는 치명적이지 않다
  }

  process.stderr.write(
    `Agent-Uplink Hub 시작: tcp=127.0.0.1:${opts.tcpPort} viewer=http://127.0.0.1:${opts.httpPort}\n`,
  );
}

main().catch((e) => {
  process.stderr.write(`치명적 오류: ${(e as Error).message}\n`);
  process.exit(1);
});
```

- [ ] **Step 6: 수동 기동 확인**

Run: `npx tsx hub/index.ts` (별도 터미널에서) → stderr에 시작 로그 출력, 브라우저로 `http://127.0.0.1:47801` 접속 시 빈 로그 페이지 표시. 확인 후 Ctrl+C.
Expected: 시작 로그 + 뷰어 페이지 렌더.

- [ ] **Step 7: Commit**

```bash
git add hub/options.ts hub/index.ts hub/options.test.ts
git commit -m "기능: Hub 진입점(환경변수 옵션, EADDRINUSE 조용히 종료, hub.json)"
```

---

### Task 8: HubClient (영속 연결 + 자동 spawn + 재연결)

MCP가 Hub와 통신하는 클라이언트. 연결/핸드셰이크/요청-응답 상관/자동 spawn/재연결/재등록을 담당. 자동 spawn과 단일 인스턴스 경합을 실제 프로세스로 통합 테스트한다.

**Files:**
- Create: `mcp/hubClient.ts`
- Test: `mcp/hubClient.test.ts`

**Interfaces:**
- Consumes: `encodeFrame`/`FrameDecoder` (Task 2), `MAGIC`/`PROTOCOL_VERSION`/`DEFAULT_TCP_PORT`/`Response` (Task 1), 실행 중인 Hub(Task 7의 `hub/index.ts`).
- Produces:
  - `interface HubClientOptions { port?: number; hubEntry?: string; nodeArgs?: string[] }`
  - `class HubClient` with `register(name?: string): Promise<Response>`, `send(text: string, to?: string): Promise<Response>`, `check(): Promise<Response>`, `wait(timeoutMs?: number): Promise<Response>`, `who(): Promise<Response>`, `close(): void`.

> 테스트는 실제 Hub를 임의 포트로 spawn한다. 테스트끼리 포트가 겹치지 않도록 각 테스트가 고유 포트를 쓰고, 데이터 디렉터리도 임시 폴더로 지정한다(`UPLINK_DATA_DIR`, `UPLINK_IDLE_MINUTES=0`). `hubEntry`는 `hub/index.ts`, `nodeArgs`는 `["--import","tsx"]`로 주입해 빌드 없이 실행한다.

- [ ] **Step 1: 실패하는 테스트 작성 (`mcp/hubClient.test.ts`)**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encodeFrame, FrameDecoder } from "../shared/framing.js";
import { HubClient } from "./hubClient.js";

const HUB_ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "hub", "index.ts");
const NODE_ARGS = ["--import", "tsx"];
let portSeq = 49200;
function freshPort(): number { return portSeq++; }
function tmpDir(): string { return fs.mkdtempSync(path.join(os.tmpdir(), "uplink-client-")); }

function makeClient(port: number): HubClient {
  process.env.UPLINK_DATA_DIR = tmpDir();
  // 0.1분(6초) 후 세션이 모두 떠나면 Hub가 스스로 종료 → 테스트 후 detached Hub 누수 방지.
  process.env.UPLINK_IDLE_MINUTES = "0.1";
  process.env.UPLINK_TCP_PORT = String(port);
  process.env.UPLINK_HTTP_PORT = String(port + 1000);
  return new HubClient({ port, hubEntry: HUB_ENTRY, nodeArgs: NODE_ARGS });
}

test("Hub가 없으면 자동으로 spawn해 연결한다", async () => {
  const port = freshPort();
  const c = makeClient(port);
  const r = await c.register("A");
  assert.equal(r.ok, true);
  assert.equal(r.name, "A");
  c.close();
  await new Promise((r) => setTimeout(r, 300));
});

test("두 클라이언트가 동시에 붙어도 Hub는 하나만 살아 서로 메시지를 주고받는다", async () => {
  const port = freshPort();
  const a = makeClient(port);
  const b = makeClient(port);
  const [ra, rb] = await Promise.all([a.register("A"), b.register("B")]); // 동시 spawn 경합
  assert.equal(ra.ok, true);
  assert.equal(rb.ok, true);
  await a.send("안녕 B", "B");
  const got = await b.wait(3000);
  assert.deepEqual(got.messages!.map((m) => m.text), ["안녕 B"]);
  a.close(); b.close();
  await new Promise((r) => setTimeout(r, 300));
});

test("포트를 Hub가 아닌 프로세스가 점유하면 명확히 실패한다", async () => {
  const port = freshPort();
  // 연결은 받아주되 매직/버전이 틀린 유효 프레임으로 응답하는 가짜 서버 →
  // handshake가 불일치를 감지해 5초 타임아웃이 아니라 즉시 명확히 실패해야 한다.
  const squatter = net.createServer((s) => {
    const dec = new FrameDecoder();
    s.on("data", (d) =>
      dec.push(d, (req: any) => s.write(encodeFrame({ ok: true, id: req.id, magic: "other", version: 0 }))),
    );
  });
  await new Promise<void>((res) => squatter.listen(port, "127.0.0.1", () => res()));
  const c = new HubClient({ port, hubEntry: HUB_ENTRY, nodeArgs: NODE_ARGS });
  await assert.rejects(() => c.register("A"), /Hub가 아닙|Agent-Uplink/);
  c.close();
  squatter.close();
});

test("연결이 끊겨도 다음 호출에서 재연결하고 이름을 유지한다", async () => {
  const port = freshPort();
  const c = makeClient(port);
  await c.register("A");
  c.dropConnectionForTest();          // 소켓 강제 종료
  const r = await c.who();            // 재연결 유발
  assert.ok(r.sessions!.some((s) => s.name === "A")); // 재등록으로 A 유지
  c.close();
  await new Promise((r) => setTimeout(r, 300));
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx tsx --test mcp/hubClient.test.ts`
Expected: FAIL (모듈 없음).

- [ ] **Step 3: 최소 구현 (`mcp/hubClient.ts`)**

```ts
import net from "node:net";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encodeFrame, FrameDecoder } from "../shared/framing.js";
import { MAGIC, PROTOCOL_VERSION, DEFAULT_TCP_PORT, Response } from "../shared/protocol.js";

export interface HubClientOptions {
  port?: number;
  hubEntry?: string;   // Hub 진입점 경로(기본: 컴파일된 ../hub/index.js)
  nodeArgs?: string[]; // node 앞 인자(기본: []). 개발 중엔 ["--import","tsx"].
}

interface Pending {
  resolve: (r: Response) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class HubClient {
  private readonly port: number;
  private readonly hubEntry: string;
  private readonly nodeArgs: string[];
  private sock: net.Socket | null = null;
  private dec = new FrameDecoder();
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private name: string | null = null;
  private connecting: Promise<void> | null = null;

  constructor(opts: HubClientOptions = {}) {
    this.port = opts.port ?? DEFAULT_TCP_PORT;
    this.hubEntry =
      opts.hubEntry ??
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "hub", "index.js");
    this.nodeArgs = opts.nodeArgs ?? [];
  }

  async register(name?: string): Promise<Response> {
    await this.ensureConnected();
    const r = await this.request("register", name ? { name } : {});
    if (r.ok && r.name) this.name = r.name;
    return r;
  }

  async send(text: string, to?: string): Promise<Response> {
    await this.ensureConnected();
    return this.request("send", { text, to: to ?? null });
  }

  async check(): Promise<Response> {
    await this.ensureConnected();
    return this.request("check", {});
  }

  async wait(timeoutMs = 30000): Promise<Response> {
    await this.ensureConnected();
    const clamped = Math.min(Math.max(timeoutMs, 1000), 120000);
    return this.request("wait", { timeoutMs: clamped }, clamped + 15000);
  }

  async who(): Promise<Response> {
    await this.ensureConnected();
    return this.request("who", {});
  }

  close(): void {
    if (this.sock) {
      this.sock.destroy();
      this.sock = null;
    }
  }

  /** 테스트 전용: 연결을 강제로 끊어 재연결 경로를 검증한다. */
  dropConnectionForTest(): void {
    if (this.sock) {
      this.sock.destroy();
      this.sock = null;
    }
  }

  private async ensureConnected(): Promise<void> {
    if (this.sock && !this.sock.destroyed) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.doConnect().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async doConnect(): Promise<void> {
    let sock: net.Socket;
    try {
      sock = await this.connectOnce();
    } catch {
      this.spawnHub();
      sock = await this.retryConnect();
    }
    this.attach(sock);
    await this.handshake();
    if (this.name) {
      // 재연결 시 동일 이름으로 재등록
      const r = await this.request("register", { name: this.name });
      if (r.ok && r.name) this.name = r.name;
    }
  }

  private connectOnce(): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const s = net.connect(this.port, "127.0.0.1");
      s.once("connect", () => resolve(s));
      s.once("error", reject);
    });
  }

  private async retryConnect(): Promise<net.Socket> {
    for (let i = 0; i < 30; i++) {
      await delay(100);
      try {
        return await this.connectOnce();
      } catch {
        // 아직 기동 중 — 재시도
      }
    }
    throw new Error("Hub를 시작했지만 연결에 실패했습니다(포트 점유 또는 기동 실패).");
  }

  private spawnHub(): void {
    const child = spawn(process.execPath, [...this.nodeArgs, this.hubEntry], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
  }

  private attach(sock: net.Socket): void {
    this.sock = sock;
    this.dec = new FrameDecoder();
    sock.on("data", (chunk) => {
      this.dec.push(chunk, (r: Response) => {
        const p = this.pending.get(r.id);
        if (p) {
          clearTimeout(p.timer);
          this.pending.delete(r.id);
          p.resolve(r);
        }
      });
    });
    const fail = () => {
      this.sock = null;
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error("Hub 연결이 끊겼습니다."));
      }
      this.pending.clear();
    };
    sock.on("close", fail);
    sock.on("error", () => {
      /* close가 뒤따른다 */
    });
  }

  private async handshake(): Promise<void> {
    const r = await this.request("hello", {}, 5000);
    if (r.magic !== MAGIC || r.version !== PROTOCOL_VERSION) {
      this.close();
      throw new Error(`포트 ${this.port}가 Agent-Uplink Hub가 아닙니다(다른 프로세스 점유 가능).`);
    }
  }

  private request(op: string, params: object, timeoutMs = 60000): Promise<Response> {
    return new Promise((resolve, reject) => {
      const sock = this.sock;
      if (!sock || sock.destroyed) {
        reject(new Error("Hub 연결이 없습니다."));
        return;
      }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Hub 응답 타임아웃(op=${op}).`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      sock.write(encodeFrame({ op, id, ...params }));
    });
  }
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx tsx --test mcp/hubClient.test.ts`
Expected: 4개 PASS. (spawn·경합·오염포트·재연결)

- [ ] **Step 5: Commit**

```bash
git add mcp/hubClient.ts mcp/hubClient.test.ts
git commit -m "기능: HubClient(영속 연결/자동 spawn/단일 인스턴스/재연결)"
```

---

### Task 9: MCP 서버 (툴 노출)

`@modelcontextprotocol/sdk`로 stdio MCP 서버를 만들고, HubClient를 감싸 5개 툴을 노출한다. ESTS `mcp/src/index.ts` 구조를 따른다.

**Files:**
- Create: `mcp/index.ts`
- Test: `mcp/index.smoke.test.ts` (MCP 서버가 stdio로 뜨고 tools/list에 5개 툴이 나오는지 스모크 확인)

**Interfaces:**
- Consumes: `HubClient` (Task 8), `@modelcontextprotocol/sdk`, `zod`.
- Produces: `mcp/index.ts` 실행 진입점(빌드 후 `dist/mcp/index.js`가 bin).

> 스모크 테스트는 MCP를 자식 프로세스로 띄우고 JSON-RPC `initialize` + `tools/list`를 stdio로 주고받아 툴 5개(register/send/check/wait/who)를 확인한다. Hub 연결은 툴을 **호출**할 때만 일어나므로, `tools/list`는 Hub 없이도 동작한다(연결 부작용 없음).

- [ ] **Step 1: 실패하는 스모크 테스트 작성 (`mcp/index.smoke.test.ts`)**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.ts");

// 자식 MCP에 JSON-RPC 한 줄을 보내고 응답 한 건을 받는다(개행 구분 stdio).
function rpc(reqs: object[]): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", ENTRY], { stdio: ["pipe", "pipe", "ignore"] });
    const out: any[] = [];
    let buf = "";
    child.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) out.push(JSON.parse(line));
        if (out.length >= reqs.length) {
          child.kill();
          resolve(out);
        }
      }
    });
    child.on("error", reject);
    for (const r of reqs) child.stdin.write(JSON.stringify(r) + "\n");
  });
}

test("MCP는 tools/list에서 5개 툴을 노출한다", async () => {
  const out = await rpc([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } } },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  ]);
  const list = out.find((m) => m.id === 2);
  const names = list.result.tools.map((t: any) => t.name).sort();
  assert.deepEqual(names, ["check", "register", "send", "wait", "who"]);
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx tsx --test mcp/index.smoke.test.ts`
Expected: FAIL (index.ts 없음).

- [ ] **Step 3: 최소 구현 (`mcp/index.ts`)**

```ts
// Agent Uplink — AI 세션 간 메시지 교환 MCP 서버(stdio).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { HubClient } from "./hubClient.js";
import { Message, Response } from "../shared/protocol.js";

const client = new HubClient({ port: Number(process.env.UPLINK_TCP_PORT ?? 47800) });

const server = new McpServer({ name: "agent-uplink", version: "0.1.0" });

function text(t: string, isError = false) {
  return { content: [{ type: "text" as const, text: t }], isError };
}

function formatMessages(msgs: Message[] | undefined): string {
  if (!msgs || msgs.length === 0) return "(새 메시지 없음)";
  return msgs
    .map((m) => `[${new Date(m.ts).toLocaleTimeString()} ${m.from}→${m.to ?? "ALL"}] ${m.text}`)
    .join("\n");
}

server.tool(
  "register",
  "이 세션을 Agent-Uplink에 등록하고 이름을 정합니다. 이름을 생략하면 uplink-N이 자동 부여됩니다. 다른 툴 사용 전에 먼저 호출하는 것을 권장합니다.",
  { name: z.string().optional().describe("이 세션의 표시 이름(예: A). 중복 시 -2가 붙습니다.") },
  async ({ name }) => {
    try {
      const r = await client.register(name);
      if (!r.ok) return text(`등록 실패: ${r.error ?? "unknown"}`, true);
      return text(`등록됨. 세션 이름: ${r.name}`);
    } catch (e) {
      return text((e as Error).message, true);
    }
  },
);

server.tool(
  "send",
  "다른 AI 세션들에게 메시지를 보냅니다. to를 지정하면 그 세션에게만, 생략하면 전체에게 전송됩니다(로그에는 항상 기록).",
  {
    text: z.string().min(1).describe("보낼 메시지 내용"),
    to: z.string().optional().describe("대상 세션 이름. 생략 시 전체 브로드캐스트."),
  },
  async ({ text: body, to }) => {
    try {
      const r = await client.send(body, to);
      if (!r.ok) return text(`전송 실패: ${r.error ?? "unknown"}`, true);
      return text(`전송됨 (seq=${r.seq})`);
    } catch (e) {
      return text((e as Error).message, true);
    }
  },
);

server.tool(
  "check",
  "지난 확인 이후 나에게 온 새 메시지(전체 브로드캐스트 + 나를 대상으로 한 것)를 즉시 가져옵니다. 대기하지 않고 바로 반환합니다.",
  {},
  async () => {
    try {
      const r = await client.check();
      if (!r.ok) return text(`확인 실패: ${r.error ?? "unknown"}`, true);
      return text(formatMessages(r.messages));
    } catch (e) {
      return text((e as Error).message, true);
    }
  },
);

server.tool(
  "wait",
  "새 메시지가 올 때까지 최대 timeoutMs 동안 기다렸다가 반환합니다(롱폴). 다른 세션의 응답을 기다릴 때 사용합니다. 타임아웃되면 빈 결과를 돌려줍니다.",
  { timeoutMs: z.number().int().positive().max(120000).optional().describe("최대 대기 시간(ms). 기본 30000, 최대 120000.") },
  async ({ timeoutMs }) => {
    try {
      const r = await client.wait(timeoutMs ?? 30000);
      if (!r.ok) return text(`대기 실패: ${r.error ?? "unknown"}`, true);
      return text(formatMessages(r.messages));
    } catch (e) {
      return text((e as Error).message, true);
    }
  },
);

server.tool(
  "who",
  "현재 Agent-Uplink에 접속 중인 세션 목록을 봅니다.",
  {},
  async () => {
    try {
      const r = await client.who();
      if (!r.ok) return text(`조회 실패: ${r.error ?? "unknown"}`, true);
      const names = (r.sessions ?? []).map((s) => s.name);
      return text(names.length ? `접속 중: ${names.join(", ")}` : "(접속 세션 없음)");
    } catch (e) {
      return text((e as Error).message, true);
    }
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("Agent-Uplink MCP 서버 시작(stdio).\n");
}

main().catch((e) => {
  process.stderr.write(`치명적 오류: ${(e as Error).message}\n`);
  process.exit(1);
});
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx tsx --test mcp/index.smoke.test.ts`
Expected: 1개 PASS.

- [ ] **Step 5: 전체 빌드 확인(타입체크 + 컴파일)**

Run: `npm run build`
Expected: 오류 0, `dist/mcp/index.js`, `dist/hub/index.js` 생성.

- [ ] **Step 6: Commit**

```bash
git add mcp/index.ts mcp/index.smoke.test.ts
git commit -m "기능: Agent-Uplink MCP 서버(register/send/check/wait/who 툴)"
```

---

### Task 10: README 및 사용 안내

빌드/설치/MCP 등록/뷰어 접속 방법과 사용 시나리오를 문서화한다.

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: 전체 산출물.

- [ ] **Step 1: `README.md` 작성(기존 내용 대체)**

````markdown
# Agent-Uplink

로컬 PC 안에서 여러 AI 세션(Claude Code, Claude Desktop 등)이 서로 메시지를 주고받게 하는 MCP + 커뮤니케이션 서버.

- **Hub**: `127.0.0.1:47800`(에이전트 TCP) + `127.0.0.1:47801`(브라우저 로그 뷰어). 첫 MCP가 자동으로 띄우며, 단일 인스턴스로 동작.
- **MCP(Agent Uplink)**: 각 AI 세션에 stdio로 붙어 Hub에 연결. `register / send / check / wait / who` 툴 제공.
- **로그 뷰어**: 브라우저로 `http://127.0.0.1:47801` 접속 시 메시지 흐름 실시간 확인.

> 로컬 전용입니다. 외부 네트워크에 노출되지 않으며 권한 상승도 하지 않습니다.

## 빌드

```cmd
cd C:\Research\Agent-Uplink
npm install
npm run build
```
→ `dist/mcp/index.js`, `dist/hub/index.js` 생성.

## MCP 등록 (Claude Code 예시)

각 세션의 MCP 설정에 아래를 추가합니다(세션마다 붙이면 됩니다):

```json
{
  "mcpServers": {
    "agent-uplink": {
      "command": "node",
      "args": ["C:\\Research\\Agent-Uplink\\dist\\mcp\\index.js"]
    }
  }
}
```

첫 세션이 툴을 호출하면 Hub가 자동으로 백그라운드에서 시작됩니다. 별도 설치·수동 실행은 필요 없습니다.

## 사용

1. 각 세션에서 `register`로 이름을 정합니다(예: A, B). 생략하면 `uplink-N` 자동.
2. `send`로 메시지를 보냅니다. `to`를 주면 특정 세션에게만, 생략하면 전체에게.
3. 상대 세션은 `check`(즉시 조회) 또는 `wait`(새 메시지 올 때까지 대기)로 받습니다.
4. `who`로 현재 접속 세션을 확인합니다.
5. 브라우저로 `http://127.0.0.1:47801`을 열면 전체 흐름을 눈으로 봅니다.

> **중요(수신 방식)**: MCP는 구조상 메시지를 자동으로 밀어 넣지 못합니다. 상대 세션이 `check`/`wait`를 호출하는 순간에만 수신됩니다. 협업 중 응답을 기다릴 땐 `wait`를 쓰세요.

## 환경변수(선택)

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `UPLINK_TCP_PORT` | 47800 | 에이전트 TCP 포트 |
| `UPLINK_HTTP_PORT` | 47801 | 뷰어 HTTP 포트 |
| `UPLINK_DATA_DIR` | `%ProgramData%\AgentUplink` | 메시지 로그·hub.json 저장 위치 |
| `UPLINK_IDLE_MINUTES` | 10 | 모든 세션이 떠난 뒤 Hub 자동 종료까지 분. `0`이면 종료 안 함 |

## 테스트

```cmd
npm test
```

## 구조

- `shared/` — 프로토콜 타입·프레이밍(공용)
- `hub/` — 커뮤니케이션 서버(TCP + HTTP 뷰어)
- `mcp/` — Agent Uplink MCP 서버(stdio) + Hub 클라이언트
````

- [ ] **Step 2: 전체 테스트 최종 실행**

Run: `npm test`
Expected: 모든 테스트 PASS(Task 1~9 누계).

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "문서: README(빌드/MCP 등록/사용/환경변수)"
```

---

## 완료 기준

- `npm run build` 오류 0, `npm test` 전체 PASS.
- 두 개 이상의 MCP 세션을 등록해 `send`/`check`/`wait`로 메시지가 오가고, 브라우저 뷰어에 실시간 반영됨.
- Hub 미기동 상태에서 첫 세션이 자동 spawn, 동시 다중 spawn에도 단일 Hub 생존.
