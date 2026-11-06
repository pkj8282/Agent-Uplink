import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { createHash } from "node:crypto";
import { startGoogleLogin } from "./googleAuth.js";

/** 가짜 토큰 서버: 받은 폼을 기록하고 refresh token을 준다. */
async function fakeToken(reply: object = { access_token: "at", refresh_token: "rt-NEW", expires_in: 3600 }) {
  const forms: URLSearchParams[] = [];
  const srv = http.createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => { forms.push(new URLSearchParams(b)); res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(reply)); });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  return { forms, url: `http://127.0.0.1:${(srv.address() as net.AddressInfo).port}/token`, close: () => new Promise<void>((r) => srv.close(() => r())) };
}

const endpoints = (token: string) => ({ auth: "https://accounts.google.com/o/oauth2/v2/auth", token });

async function hit(url: string): Promise<number> {
  try {
    const r = await fetch(url);
    await r.text();
    return r.status;
  } catch {
    return -1; // 닫힘
  }
}

test("auth_url_has_pkce_state: PKCE S256·state·루프백·drive.file 범위만", async () => {
  const t = await fakeToken();
  const l = await startGoogleLogin({ clientId: "cid", endpoints: endpoints(t.url) });
  try {
    const u = new URL(l.authUrl);
    assert.equal(`${u.origin}${u.pathname}`, "https://accounts.google.com/o/oauth2/v2/auth");
    const p = u.searchParams;
    assert.equal(p.get("client_id"), "cid");
    assert.equal(p.get("response_type"), "code");
    assert.equal(p.get("scope"), "https://www.googleapis.com/auth/drive.file");
    assert.equal(p.get("code_challenge_method"), "S256");
    assert.match(p.get("code_challenge")!, /^[A-Za-z0-9_-]{43}$/);
    assert.ok((p.get("state") ?? "").length >= 43);
    assert.equal(p.get("redirect_uri"), `http://127.0.0.1:${l.port}`);
    assert.equal(p.get("access_type"), "offline");
  } finally { l.cancel(); await l.done; await t.close(); }
});

test("callback_rejects_wrong_state: state가 틀린 콜백은 거부하고 계속 기다림 → 진짜 콜백으로 교환", async () => {
  const t = await fakeToken();
  const l = await startGoogleLogin({ clientId: "cid", clientSecret: "sec", endpoints: endpoints(t.url) });
  try {
    const state = new URL(l.authUrl).searchParams.get("state")!;
    assert.equal(await hit(`http://127.0.0.1:${l.port}/?code=evil&state=wrong`), 400);
    assert.equal(await hit(`http://127.0.0.1:${l.port}/?code=evil`), 400);
    assert.equal(t.forms.length, 0); // 교환하지 않음
    assert.equal(await hit(`http://127.0.0.1:${l.port}/?code=good-code&state=${encodeURIComponent(state)}`), 200);
    const r = await l.done;
    assert.deepEqual(r, { ok: true, refreshToken: "rt-NEW" });
    const f = t.forms[0];
    assert.equal(f.get("code"), "good-code");
    assert.equal(f.get("grant_type"), "authorization_code");
    assert.equal(f.get("redirect_uri"), `http://127.0.0.1:${l.port}`);
    assert.equal(f.get("client_secret"), "sec");
    const challenge = new URL(l.authUrl).searchParams.get("code_challenge");
    const verifier = f.get("code_verifier")!;
    assert.match(verifier, /^[A-Za-z0-9_.~-]{43,128}$/);
    assert.equal(createHash("sha256").update(verifier).digest("base64url"), challenge);
  } finally { await t.close(); }
});

test("user_denied_and_no_refresh_token: 거부·refresh token 없음은 실패 코드", async () => {
  const t = await fakeToken({ access_token: "at" });
  const l = await startGoogleLogin({ clientId: "cid", endpoints: endpoints(t.url) });
  const state = new URL(l.authUrl).searchParams.get("state")!;
  await hit(`http://127.0.0.1:${l.port}/?code=c&state=${state}`);
  assert.deepEqual(await l.done, { ok: false, code: "oauth_no_refresh_token" });
  const l2 = await startGoogleLogin({ clientId: "cid", endpoints: endpoints(t.url) });
  const s2 = new URL(l2.authUrl).searchParams.get("state")!;
  await hit(`http://127.0.0.1:${l2.port}/?error=access_denied&state=${s2}`);
  assert.deepEqual(await l2.done, { ok: false, code: "oauth_denied" });
  await t.close();
});

test("listener_closes_after_use_and_timeout: 한 번 쓰면·시간이 지나면 콜백 포트가 닫힘", async () => {
  const t = await fakeToken();
  const l = await startGoogleLogin({ clientId: "cid", endpoints: endpoints(t.url) });
  const state = new URL(l.authUrl).searchParams.get("state")!;
  await hit(`http://127.0.0.1:${l.port}/?code=c&state=${state}`);
  await l.done;
  assert.equal(await hit(`http://127.0.0.1:${l.port}/?code=c&state=${state}`), -1);
  const l2 = await startGoogleLogin({ clientId: "cid", endpoints: endpoints(t.url), timeoutMs: 100 });
  assert.deepEqual(await l2.done, { ok: false, code: "oauth_timeout" });
  assert.equal(await hit(`http://127.0.0.1:${l2.port}/`), -1);
  await t.close();
});

test("binds_loopback_only: 콜백 리스너는 127.0.0.1에만 열림", async () => {
  const t = await fakeToken();
  const l = await startGoogleLogin({ clientId: "cid", endpoints: endpoints(t.url) });
  try {
    assert.equal(l.address, "127.0.0.1");
  } finally { l.cancel(); await l.done; await t.close(); }
});
