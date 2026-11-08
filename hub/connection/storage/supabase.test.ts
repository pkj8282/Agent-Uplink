import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { parseSupabaseUrl, SupabaseBackend } from "./supabase.js";
import { StorageError } from "./backend.js";
import { fakeSupabase, SUPA_KEY } from "./fakeSupabase.js";

const make = (url: string, key = SUPA_KEY) => new SupabaseBackend({ url, key, bucket: "agent-uplink", allowInsecureForTest: true });

async function codeOf(p: Promise<unknown>): Promise<StorageError> {
  try { await p; } catch (e) { assert.ok(e instanceof StorageError, String(e)); return e; }
  assert.fail("오류가 나야 함");
}

test("check_creates_private_bucket: 버킷이 없으면 비공개로 만든다(있으면 그대로)", async () => {
  const s = await fakeSupabase();
  try {
    await make(s.url).check();
    assert.deepEqual([...s.buckets], [["agent-uplink", { public: false }]]);
    await make(s.url).check();
    assert.equal(s.buckets.size, 1);
    const any = s.seen[0];
    assert.equal(any.apikey, SUPA_KEY);
    assert.equal(any.auth, undefined); // 새 secret key는 apikey 헤더만(공식 권장)
  } finally { await s.close(); }
});

test("put_get_list: 올리기·받기·목록(폴더 포함)", async () => {
  const s = await fakeSupabase();
  try {
    const b = make(s.url);
    await b.check();
    const bytes = Buffer.from([0, 1, 255, 10, 13]);
    await b.put("agent-uplink/s/h/2026-11-07/00000000.frag", bytes);
    await b.put("agent-uplink/s/h/2026-11-07/00000001.frag", Buffer.from("둘"));
    assert.deepEqual(await b.get("agent-uplink/s/h/2026-11-07/00000000.frag"), bytes);
    assert.equal(await b.get("agent-uplink/s/h/2026-11-07/nope.frag"), null);
    assert.deepEqual(await b.list("agent-uplink/s/h"), ["2026-11-07"]);
    assert.deepEqual(await b.list("agent-uplink/s/h/2026-11-07"), ["00000000.frag", "00000001.frag"]);
    assert.deepEqual(await b.list("agent-uplink/none"), []);
    const put = s.seen.find((x) => x.method === "POST" && x.url.includes("/object/agent-uplink/"))!;
    assert.ok(put);
  } finally { await s.close(); }
});

test("list_pages: 1,000개 넘는 폴더도 페이지를 넘겨 모두 읽는다", async () => {
  const s = await fakeSupabase();
  try {
    const b = make(s.url);
    await b.check();
    for (let i = 0; i < 1005; i++) s.objects.set(`agent-uplink/d/${String(i).padStart(5, "0")}.frag`, Buffer.from("x"));
    assert.equal((await b.list("d")).length, 1005);
  } finally { await s.close(); }
});

test("put_never_overwrites: 이미 있으면 덮어쓰지 않는다", async () => {
  const s = await fakeSupabase();
  try {
    const b = make(s.url);
    await b.check();
    await b.put("a/x.frag", Buffer.from("1"));
    assert.equal((await codeOf(b.put("a/x.frag", Buffer.from("2")))).code, "storage_bad_response");
    assert.equal((await b.get("a/x.frag"))?.toString(), "1");
  } finally { await s.close(); }
});

test("error_codes: 401 키 틀림·403·429·5xx(일시정지 등)·닿지 않음", async () => {
  const s = await fakeSupabase();
  try {
    assert.equal((await codeOf(make(s.url, "sb_secret_WRONG").check())).code, "storage_auth_failed"); // 실제: 400 authorization 필요
    assert.equal((await codeOf(make(s.url, "eyJhbGciOiJIUzI1NiJ9.e30.x").check())).code, "storage_auth_failed"); // 실제: 400 + 403 Unauthorized
    assert.equal((await codeOf(make(s.url, "sb_secret_WRONG").list("a"))).code, "storage_auth_failed");
  } finally { await s.close(); }
  const cases: [number, Record<string, string>, string][] = [
    [403, {}, "storage_forbidden"], [429, { "retry-after": "4" }, "storage_rate_limited"], [503, {}, "storage_unreachable"], [540, {}, "storage_unreachable"],
  ];
  for (const [status, headers, code] of cases) {
    const f = await fakeSupabase({ hook: (_q, r) => { r.writeHead(status, { "content-type": "application/json", ...headers }); r.end("{}"); return true; } });
    try {
      const e = await codeOf(make(f.url).check());
      assert.equal(e.code, code, String(status));
      if (status === 429) assert.equal(e.retryAfterMs, 4000);
    } finally { await f.close(); }
  }
  const n = net.createServer();
  await new Promise<void>((r) => n.listen(0, "127.0.0.1", () => r()));
  const port = (n.address() as net.AddressInfo).port;
  await new Promise<void>((r) => n.close(() => r()));
  assert.equal((await codeOf(make(`http://127.0.0.1:${port}`).check())).code, "storage_unreachable");
});

test("secret_not_in_errors: 오류에 secret key가 없다", async () => {
  const f = await fakeSupabase({ hook: (q, r) => { r.writeHead(500, { "content-type": "application/json" }); r.end(JSON.stringify({ echo: q.headers.apikey })); return true; } });
  try {
    const e = await codeOf(make(f.url).check());
    assert.equal(`${e.message} ${e.stack}`.includes(SUPA_KEY), false);
  } finally { await f.close(); }
});

test("parse_url: https://<ref>.supabase.co 만", () => {
  assert.equal(parseSupabaseUrl("https://abcdefghijklmnopqrst.supabase.co"), "https://abcdefghijklmnopqrst.supabase.co");
  assert.equal(parseSupabaseUrl(" https://abcdefghijklmnopqrst.supabase.co/ "), "https://abcdefghijklmnopqrst.supabase.co");
  for (const bad of ["http://abc.supabase.co", "https://abc.supabase.co.evil.com", "https://evil.com", "https://a_b.supabase.co", "https://abc.supabase.co/rest/v1", "https://user@abc.supabase.co", "", "abc"]) {
    assert.equal(parseSupabaseUrl(bad), null, bad);
  }
  // 시험용 http 주소는 allowInsecureForTest일 때만
  assert.throws(() => new SupabaseBackend({ url: "http://127.0.0.1:1", key: "k", bucket: "b" }));
});


test("overwrite_replaces_object: 있어도 x-upsert로 덮어쓴다", async () => {
  const f = await fakeSupabase();
  try {
    const b = make(f.url);
    await b.check();
    await b.overwrite("a/head.json", Buffer.from("1"));
    await b.overwrite("a/head.json", Buffer.from("22"));
    assert.equal((await b.get("a/head.json"))!.toString(), "22");
  } finally { await f.close(); }
});
