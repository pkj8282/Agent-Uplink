import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { fakeGoogle, REFRESH } from "./fakeGoogle.js";
import net from "node:net";
import { DriveBackend } from "./drive.js";
import { StorageError } from "./backend.js";

const SECRET = "client-secret-XYZ";

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
