import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { DriveBackend } from "./drive.js";
import { StorageError } from "./backend.js";

const SECRET = "client-secret-XYZ";
const REFRESH = "refresh-token-GOOD";

interface FakeFile { id: string; name: string; parents: string[]; folder: boolean; content?: Buffer }

/** 가짜 Google 토큰 서버 + Drive v3(필요한 부분만). */
async function fakeGoogle(opts: { refreshOk?: () => boolean; driveHook?: (req: http.IncomingMessage, res: http.ServerResponse) => boolean } = {}) {
  const files = new Map<string, FakeFile>();
  const seen: { method: string; url: string; auth?: string; body: Buffer }[] = [];
  let n = 0;
  let tokenCalls = 0;
  let validToken = "";
  const srv = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      seen.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, body });
      const json = (code: number, v: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(v)); };
      const u = new URL(req.url!, "http://x");
      if (u.pathname === "/token") {
        tokenCalls++;
        const f = new URLSearchParams(body.toString());
        if (f.get("grant_type") !== "refresh_token" || f.get("refresh_token") !== REFRESH || !(opts.refreshOk?.() ?? true)) return json(400, { error: "invalid_grant" });
        validToken = `at-${tokenCalls}`;
        return json(200, { access_token: validToken, expires_in: 3600, token_type: "Bearer" });
      }
      if (opts.driveHook?.(req, res)) return;
      if (req.headers.authorization !== `Bearer ${validToken}`) return json(401, { error: { code: 401 } });
      if (u.pathname === "/drive/v3/files" && req.method === "GET") {
        const q = u.searchParams.get("q") ?? "";
        const m = /^'((?:[^'\\]|\\.)*)' in parents and trashed = false(?: and name = '((?:[^'\\]|\\.)*)')?$/.exec(q);
        if (!m) return json(400, { error: { message: `bad q ${q}` } });
        const unesc = (s: string) => s.replace(/\\(.)/g, "$1");
        const parent = unesc(m[1]);
        const name = m[2] !== undefined ? unesc(m[2]) : undefined;
        const list = [...files.values()].filter((f) => f.parents.includes(parent) && (name === undefined || f.name === name));
        return json(200, { files: list.map((f) => ({ id: f.id, name: f.name, mimeType: f.folder ? "application/vnd.google-apps.folder" : "application/octet-stream" })) });
      }
      if (u.pathname === "/drive/v3/files" && req.method === "POST") {
        const meta = JSON.parse(body.toString());
        const id = `f${++n}`;
        files.set(id, { id, name: meta.name, parents: meta.parents ?? ["root"], folder: meta.mimeType === "application/vnd.google-apps.folder" });
        return json(200, { id });
      }
      if (u.pathname === "/upload/drive/v3/files" && req.method === "POST") {
        if (u.searchParams.get("uploadType") !== "multipart") return json(400, {});
        const boundary = /boundary=(.+)$/.exec(String(req.headers["content-type"]))![1];
        const parts = body.toString("latin1").split(`--${boundary}`);
        const meta = JSON.parse(parts[1].split("\r\n\r\n")[1].trim());
        const raw = parts[2].slice(parts[2].indexOf("\r\n\r\n") + 4, parts[2].length - 2);
        const id = `f${++n}`;
        files.set(id, { id, name: meta.name, parents: meta.parents, folder: false, content: Buffer.from(raw, "latin1") });
        return json(200, { id });
      }
      const g = /^\/drive\/v3\/files\/([^/]+)$/.exec(u.pathname);
      if (g && req.method === "GET" && u.searchParams.get("alt") === "media") {
        const f = files.get(g[1]);
        if (!f?.content) return json(404, {});
        res.writeHead(200, { "content-type": "application/octet-stream" });
        return res.end(f.content);
      }
      json(404, {});
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(srv.address() as net.AddressInfo).port}`;
  return {
    files, seen, tokenCalls: () => tokenCalls, expire: () => { validToken = "expired"; },
    apiBase: { token: `${base}/token`, drive: `${base}/drive/v3`, upload: `${base}/upload/drive/v3` },
    close: () => new Promise<void>((r) => srv.close(() => r())),
  };
}

const make = (g: { apiBase: { token: string; drive: string; upload: string } }) =>
  new DriveBackend({ clientId: "cid.apps.googleusercontent.com", clientSecret: SECRET, refreshToken: REFRESH, apiBase: g.apiBase });

async function codeOf(p: Promise<unknown>): Promise<StorageError> {
  try { await p; } catch (e) { assert.ok(e instanceof StorageError, String(e)); return e; }
  assert.fail("오류가 나야 함");
}

test("put_get_list: 폴더 경로를 만들고 올리기·받기·목록", async () => {
  const g = await fakeGoogle();
  try {
    const b = make(g);
    await b.check();
    const bytes = Buffer.from([0, 1, 2, 255, 10, 13, 45, 45]);
    await b.put("agent-uplink/s/h/2026-11-06/00000000.frag", bytes);
    await b.put("agent-uplink/s/h/2026-11-06/00000001.frag", Buffer.from("둘"));
    assert.deepEqual(await b.get("agent-uplink/s/h/2026-11-06/00000000.frag"), bytes);
    assert.equal(await b.get("agent-uplink/s/h/2026-11-06/nope.frag"), null);
    assert.equal(await b.get("agent-uplink/none/x.frag"), null);
    assert.deepEqual(await b.list("agent-uplink/s/h"), ["2026-11-06"]);
    assert.deepEqual(await b.list("agent-uplink/s/h/2026-11-06"), ["00000000.frag", "00000001.frag"]);
    assert.deepEqual(await b.list("agent-uplink/none"), []);
    const folders = [...g.files.values()].filter((f) => f.folder).map((f) => f.name);
    assert.deepEqual(folders, ["agent-uplink", "s", "h", "2026-11-06"]); // 폴더는 한 번씩만
    assert.ok(g.seen.filter((s) => !s.url.startsWith("/token")).every((s) => s.auth?.startsWith("Bearer at-")));
    assert.equal(g.tokenCalls(), 1); // access token은 메모리에 두고 다시 씀
  } finally { await g.close(); }
});

test("put_never_overwrites: 같은 이름 파일이 있으면 덮어쓰지 않음", async () => {
  const g = await fakeGoogle();
  try {
    const b = make(g);
    await b.put("a/x.frag", Buffer.from("1"));
    assert.equal((await codeOf(b.put("a/x.frag", Buffer.from("2")))).code, "storage_bad_response");
    assert.equal((await b.get("a/x.frag"))?.toString(), "1");
  } finally { await g.close(); }
});

test("refresh_once_on_401: access token이 만료되면 한 번 갱신하고 다시", async () => {
  const g = await fakeGoogle();
  try {
    const b = make(g);
    await b.put("a/1.frag", Buffer.from("1"));
    g.expire();
    assert.deepEqual(await b.list("a"), ["1.frag"]);
    assert.equal(g.tokenCalls(), 2);
  } finally { await g.close(); }
});

test("expired_refresh_is_auth_failed: refresh token 만료(Testing 7일 등)는 storage_auth_failed", async () => {
  const g = await fakeGoogle({ refreshOk: () => false });
  try {
    assert.equal((await codeOf(make(g).check())).code, "storage_auth_failed");
  } finally { await g.close(); }
});

test("rate_limit_codes: 429·403 rateLimitExceeded → storage_rate_limited, 그 밖 403 → forbidden", async () => {
  const cases: [number, object, Record<string, string>, string][] = [
    [429, { error: { code: 429 } }, {}, "storage_rate_limited"],
    [403, { error: { code: 403, errors: [{ reason: "userRateLimitExceeded" }] } }, {}, "storage_rate_limited"],
    [403, { error: { code: 403, errors: [{ reason: "rateLimitExceeded" }] } }, { "retry-after": "9" }, "storage_rate_limited"],
    [403, { error: { code: 403, errors: [{ reason: "insufficientPermissions" }] } }, {}, "storage_forbidden"],
  ];
  for (const [status, body, headers, code] of cases) {
    const g = await fakeGoogle({ driveHook: (req, res) => {
      if (req.url!.startsWith("/drive/")) { res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(body)); return true; }
      return false;
    } });
    try {
      const e = await codeOf(make(g).list("a"));
      assert.equal(e.code, code);
      if (code === "storage_rate_limited") assert.ok((e.retryAfterMs ?? 0) >= 1000, String(e.retryAfterMs));
      if (headers["retry-after"]) assert.equal(e.retryAfterMs, 9000);
    } finally { await g.close(); }
  }
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  const dead = `http://127.0.0.1:${port}`;
  assert.equal((await codeOf(new DriveBackend({ clientId: "c", refreshToken: REFRESH, apiBase: { token: `${dead}/t`, drive: dead, upload: dead } }).check())).code, "storage_unreachable");
});

test("query_escapes_quotes: 이름의 작은따옴표·역슬래시는 q에서 이스케이프", async () => {
  const g = await fakeGoogle();
  try {
    const b = make(g);
    await b.put("it's/a\\b.frag", Buffer.from("q"));
    assert.equal((await b.get("it's/a\\b.frag"))?.toString(), "q");
    assert.deepEqual(await b.list("it's"), ["a\\b.frag"]);
  } finally { await g.close(); }
});

test("secrets_not_in_errors: 오류에 client secret·refresh token·access token이 없음", async () => {
  const g = await fakeGoogle({ driveHook: (req, res) => {
    if (req.url!.startsWith("/drive/")) { res.writeHead(500, { "content-type": "application/json" }); res.end(JSON.stringify({ echo: `${SECRET} ${REFRESH} ${req.headers.authorization}` })); return true; }
    return false;
  } });
  try {
    const e = await codeOf(make(g).list("a"));
    assert.equal(e.code, "storage_bad_response");
    const all = `${e.message} ${e.stack}`;
    for (const s of [SECRET, REFRESH, "at-1"]) assert.equal(all.includes(s), false, s);
  } finally { await g.close(); }
});
