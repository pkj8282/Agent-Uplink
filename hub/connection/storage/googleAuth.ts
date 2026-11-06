// Google OAuth 데스크톱 로그인(v3.0 3b): 127.0.0.1 임의 포트의 1회용 콜백 + PKCE(S256) + state.
// 근거(공식 문서 2026-11-06): 루프백 리다이렉트 지원, "Always use PKCE", 설치형 앱은 refresh token을 받음.
// state가 틀린 콜백은 거부만 하고 계속 기다린다 — 같은 PC의 다른 프로그램이 가짜 콜백으로 로그인을 끊지 못하게.
import http from "node:http";
import net from "node:net";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const DEFAULT_ENDPOINTS = { auth: "https://accounts.google.com/o/oauth2/v2/auth", token: "https://oauth2.googleapis.com/token" };
const DEFAULT_TIMEOUT_MS = 5 * 60_000;

export type LoginResult = { ok: true; refreshToken: string } | { ok: false; code: string };

export interface GoogleLogin {
  authUrl: string;
  port: number;
  address: string;
  done: Promise<LoginResult>;
  cancel(): void;
}

const PAGE = (ok: boolean) =>
  `<!doctype html><meta charset="utf-8"><title>Agent-Uplink</title><p>${ok
    ? "로그인을 마쳤습니다. 이 창을 닫으세요. / Sign-in finished. You can close this window."
    : "로그인하지 못했습니다. 관리 앱을 확인하세요. / Sign-in failed. Check the admin app."}</p>`;

function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export async function startGoogleLogin(o: {
  clientId: string;
  clientSecret?: string;
  timeoutMs?: number;
  endpoints?: { auth: string; token: string };
  fetchImpl?: typeof fetch;
}): Promise<GoogleLogin> {
  const ep = o.endpoints ?? DEFAULT_ENDPOINTS;
  const fetchImpl = o.fetchImpl ?? fetch;
  const verifier = randomBytes(32).toString("base64url"); // 43자 [A-Za-z0-9_-]
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(32).toString("base64url");

  let finish!: (r: LoginResult) => void;
  const done = new Promise<LoginResult>((res) => { finish = res; });
  let settled = false;
  let timer: NodeJS.Timeout | null = null;
  const srv = http.createServer();
  const end = (r: LoginResult) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    srv.close();
    srv.closeAllConnections();
    finish(r);
  };

  await new Promise<void>((res, rej) => {
    srv.once("error", rej);
    srv.listen(0, "127.0.0.1", () => res());
  });
  const port = (srv.address() as net.AddressInfo).port;
  const redirectUri = `http://127.0.0.1:${port}`;

  srv.on("request", (req, res) => {
    const u = new URL(req.url ?? "/", redirectUri);
    const reply = (code: number, ok: boolean) => {
      res.writeHead(code, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(PAGE(ok));
    };
    if (req.method !== "GET" || u.pathname !== "/") return reply(404, false);
    const got = u.searchParams.get("state") ?? "";
    if (!sameText(got, state)) return reply(400, false); // 거부하고 계속 기다린다
    const err = u.searchParams.get("error");
    if (err) {
      reply(200, false);
      return end({ ok: false, code: "oauth_denied" });
    }
    const code = u.searchParams.get("code");
    if (!code) return reply(400, false);
    void (async () => {
      const form = new URLSearchParams({ client_id: o.clientId, code, code_verifier: verifier, grant_type: "authorization_code", redirect_uri: redirectUri });
      if (o.clientSecret) form.set("client_secret", o.clientSecret);
      let result: LoginResult;
      try {
        const r = await fetchImpl(ep.token, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form.toString(), signal: AbortSignal.timeout(30_000) });
        const j = (await r.json().catch(() => ({}))) as { refresh_token?: unknown };
        result = !r.ok ? { ok: false, code: "oauth_exchange_failed" }
          : typeof j.refresh_token === "string" && j.refresh_token ? { ok: true, refreshToken: j.refresh_token }
            : { ok: false, code: "oauth_no_refresh_token" };
      } catch {
        result = { ok: false, code: "oauth_unreachable" };
      }
      reply(200, result.ok);
      end(result);
    })();
  });

  timer = setTimeout(() => end({ ok: false, code: "oauth_timeout" }), o.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  timer.unref();

  const authUrl = `${ep.auth}?${new URLSearchParams({
    client_id: o.clientId, redirect_uri: redirectUri, response_type: "code", scope: DRIVE_SCOPE,
    code_challenge: challenge, code_challenge_method: "S256", state, access_type: "offline", prompt: "consent",
  })}`;
  return { authUrl, port, address: "127.0.0.1", done, cancel: () => end({ ok: false, code: "oauth_cancelled" }) };
}
