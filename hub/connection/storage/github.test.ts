import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { GitHubBackend, parseRepo } from "./github.js";
import { StorageError } from "./backend.js";

const TOKEN = "github_pat_SECRET_TOKEN_VALUE_123";

type Handler = (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void;

/** 가짜 GitHub Contents API. 파일은 메모리에 둔다. */
async function fakeGitHub(override?: Handler) {
  const files = new Map<string, string>(); // path → b64
  const seen: { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
  let active = 0;
  let maxActive = 0;
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      seen.push({ method: req.method!, url: req.url!, headers: req.headers, body });
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 20));
      active--;
      if (override) return override(req, body, res);
      const json = (code: number, v: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(v)); };
      const m = /^\/repos\/o\/r(?:\/contents\/(.*?))?(?:\?.*)?$/.exec(req.url!);
      if (!m) return json(404, { message: "Not Found" });
      const p = m[1] ? decodeURIComponent(m[1]) : undefined;
      if (p === undefined) return json(200, { full_name: "o/r", permissions: { push: true } });
      if (req.method === "PUT") {
        if (files.has(p)) return json(422, { message: "Invalid request. \"sha\" wasn't supplied." });
        files.set(p, JSON.parse(body).content);
        return json(201, { content: { path: p } });
      }
      if (req.method === "GET") {
        if (files.has(p)) return json(200, { type: "file", encoding: "base64", content: files.get(p) });
        const kids = [...new Set([...files.keys()].filter((k) => k.startsWith(`${p}/`)).map((k) => k.slice(p.length + 1).split("/")[0]))];
        if (kids.length === 0) return json(404, { message: "Not Found" });
        return json(200, kids.map((name) => ({ name, type: files.has(`${p}/${name}`) ? "file" : "dir" })));
      }
      json(405, {});
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as net.AddressInfo).port;
  return { files, seen, maxActive: () => maxActive, apiBase: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => srv.close(() => r())) };
}

const make = (apiBase: string) => new GitHubBackend({ token: TOKEN, repo: "o/r", apiBase });

async function codeOf(p: Promise<unknown>): Promise<StorageError> {
  try { await p; } catch (e) { assert.ok(e instanceof StorageError, String(e)); return e; }
  assert.fail("오류가 나야 함");
}

test("put_get_list: 올리기·받기·목록, 요청 머리와 본문", async () => {
  const g = await fakeGitHub();
  try {
    const b = make(g.apiBase);
    await b.check();
    await b.put("agent-uplink/s/h/2026-11-06/00000000.frag", Buffer.from("한글 bytes"));
    const put = g.seen.find((s) => s.method === "PUT")!;
    assert.equal(put.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(put.headers["x-github-api-version"], "2022-11-28");
    assert.equal(put.headers["user-agent"], "agent-uplink");
    assert.match(String(put.headers.accept), /application\/vnd\.github\+json/);
    const pb = JSON.parse(put.body);
    assert.equal(pb.message, "agent-uplink backup");
    assert.equal(Buffer.from(pb.content, "base64").toString(), "한글 bytes");
    assert.equal(Object.keys(pb).sort().join(","), "content,message");
    assert.equal((await b.get("agent-uplink/s/h/2026-11-06/00000000.frag"))?.toString(), "한글 bytes");
    assert.equal(await b.get("agent-uplink/s/h/2026-11-06/nope.frag"), null);
    assert.deepEqual(await b.list("agent-uplink/s/h"), ["2026-11-06"]);
    assert.deepEqual(await b.list("agent-uplink/s/h/2026-11-06"), ["00000000.frag"]);
    assert.deepEqual(await b.list("agent-uplink/none"), []);
    // 이미 있는 경로는 덮어쓰지 않음
    assert.equal((await codeOf(b.put("agent-uplink/s/h/2026-11-06/00000000.frag", Buffer.from("x")))).code, "storage_bad_response");
  } finally { await g.close(); }
});

test("writes_are_serial: 동시에 부른 쓰기도 GitHub에는 하나씩", async () => {
  const g = await fakeGitHub();
  try {
    const b = make(g.apiBase);
    await Promise.all([0, 1, 2].map((i) => b.put(`p/${i}.frag`, Buffer.from(String(i)))));
    assert.equal(g.files.size, 3);
    assert.equal(g.maxActive(), 1);
  } finally { await g.close(); }
});

test("rate_limit_codes: 403/429 제한 머리·401·404·닿지 않음", async () => {
  const cases: [Handler, string, number | undefined][] = [
    [(_q, _b, r) => { r.writeHead(429, { "retry-after": "7" }); r.end("{}"); }, "storage_rate_limited", 7000],
    [(_q, _b, r) => { r.writeHead(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 120) }); r.end("{}"); }, "storage_rate_limited", 120_000],
    [(_q, _b, r) => { r.writeHead(403, { "content-type": "application/json" }); r.end(JSON.stringify({ message: "You have exceeded a secondary rate limit" })); }, "storage_rate_limited", 60_000],
    [(_q, _b, r) => { r.writeHead(403, { "content-type": "application/json" }); r.end(JSON.stringify({ message: "Resource not accessible by personal access token" })); }, "storage_forbidden", undefined],
    [(_q, _b, r) => { r.writeHead(401); r.end("{}"); }, "storage_auth_failed", undefined],
  ];
  for (const [h, code, after] of cases) {
    const g = await fakeGitHub(h);
    try {
      const e = await codeOf(make(g.apiBase).put("p/x.frag", Buffer.from("x")));
      assert.equal(e.code, code);
      if (after !== undefined) assert.ok(Math.abs((e.retryAfterMs ?? 0) - after) < 3000, `${code} ${e.retryAfterMs}`);
    } finally { await g.close(); }
  }
  const g404 = await fakeGitHub((_q, _b, r) => { r.writeHead(404); r.end("{}"); });
  try {
    assert.equal((await codeOf(make(g404.apiBase).check())).code, "storage_repo_not_found");
  } finally { await g404.close(); }
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  assert.equal((await codeOf(make(`http://127.0.0.1:${port}`).check())).code, "storage_unreachable");
});

test("token_not_in_errors: 어떤 오류에도 토큰이 들어가지 않음", async () => {
  const g = await fakeGitHub((_q, _b, r) => { r.writeHead(500, { "content-type": "application/json" }); r.end(JSON.stringify({ message: `echo ${TOKEN}` })); });
  try {
    const e = await codeOf(make(g.apiBase).put("p/x.frag", Buffer.from("x")));
    assert.equal(e.code, "storage_bad_response");
    assert.equal(`${e.message} ${e.code} ${e.stack}`.includes(TOKEN), false);
  } finally { await g.close(); }
});

test("parseRepo: owner/name 형식만", () => {
  assert.deepEqual(parseRepo("a/b"), { owner: "a", name: "b" });
  assert.deepEqual(parseRepo("my-org/repo.name_1"), { owner: "my-org", name: "repo.name_1" });
  for (const bad of ["a", "a/b/c", "../x", "a/b c", "", "a/", "/b", "a/.."]) assert.equal(parseRepo(bad), null, bad);
});
