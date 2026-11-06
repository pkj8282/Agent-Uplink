// 시험 도우미(v3.0 3b): 가짜 Google 토큰 서버 + Drive v3(필요한 부분만). 제품 코드는 쓰지 않는다.
import http from "node:http";
import net from "node:net";

export const REFRESH = "refresh-token-GOOD";

interface FakeFile { id: string; name: string; parents: string[]; folder: boolean; content?: Buffer }

/** 가짜 Google 토큰 서버 + Drive v3(필요한 부분만). */
export async function fakeGoogle(opts: { refreshOk?: () => boolean; driveHook?: (req: http.IncomingMessage, res: http.ServerResponse) => boolean } = {}) {
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
        if (f.get("grant_type") === "authorization_code") return json(200, { access_token: "at-code", refresh_token: REFRESH, expires_in: 3600 });
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

