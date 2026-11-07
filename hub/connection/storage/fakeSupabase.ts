// 시험 도우미(v3.0 3b): 가짜 Supabase Storage(필요한 부분만). 제품 코드는 쓰지 않는다.
import http from "node:http";
import net from "node:net";

export const SUPA_KEY = "sb_secret_TESTKEY_abcdef123456";

export async function fakeSupabase(opts: { hook?: (req: http.IncomingMessage, res: http.ServerResponse) => boolean } = {}) {
  const buckets = new Map<string, { public: boolean }>();
  const objects = new Map<string, Buffer>(); // "<bucket>/<path>"
  const seen: { method: string; url: string; apikey?: string; auth?: string; body: Buffer }[] = [];
  const srv = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      seen.push({ method: req.method!, url: req.url!, apikey: req.headers.apikey as string | undefined, auth: req.headers.authorization, body });
      if (opts.hook?.(req, res)) return;
      const json = (code: number, v: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(v)); };
      if (req.headers.apikey !== SUPA_KEY) return json(401, { message: "Invalid API key" });
      const u = new URL(req.url!, "http://x");
      const p = decodeURIComponent(u.pathname);
      let m: RegExpExecArray | null;
      if ((m = /^\/storage\/v1\/bucket\/([^/]+)$/.exec(p)) && req.method === "GET") {
        return buckets.has(m[1]) ? json(200, { id: m[1], public: buckets.get(m[1])!.public }) : json(400, { statusCode: "404", error: "Bucket not found", message: "Bucket not found" });
      }
      if (p === "/storage/v1/bucket" && req.method === "POST") {
        const b = JSON.parse(body.toString());
        if (buckets.has(b.id)) return json(400, { statusCode: "409", error: "Duplicate", message: "The resource already exists" });
        buckets.set(b.id, { public: b.public === true });
        return json(200, { name: b.id });
      }
      if ((m = /^\/storage\/v1\/object\/list\/([^/]+)$/.exec(p)) && req.method === "POST") {
        const { prefix = "", limit = 100, offset = 0 } = JSON.parse(body.toString());
        const pre = `${m[1]}/${prefix ? `${prefix}/` : ""}`;
        const names = [...new Set([...objects.keys()].filter((k) => k.startsWith(pre)).map((k) => k.slice(pre.length).split("/")[0]))].sort();
        const rows = names.map((name) => ({ name, id: objects.has(`${pre}${name}`) ? `id-${name}` : null }));
        return json(200, rows.slice(offset, offset + limit));
      }
      if ((m = /^\/storage\/v1\/object\/([^/]+)\/(.+)$/.exec(p))) {
        const key = `${m[1]}/${m[2]}`;
        if (!buckets.has(m[1])) return json(400, { statusCode: "404", error: "Bucket not found", message: "Bucket not found" });
        if (req.method === "POST") {
          if (objects.has(key)) return json(400, { statusCode: "409", error: "Duplicate", message: "The resource already exists" });
          objects.set(key, body);
          return json(200, { Key: key });
        }
        if (req.method === "GET") {
          if (!objects.has(key)) return json(400, { statusCode: "404", error: "not_found", message: "Object not found" });
          res.writeHead(200, { "content-type": "application/octet-stream" });
          return res.end(objects.get(key));
        }
      }
      json(404, { message: "no route" });
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const url = `http://127.0.0.1:${(srv.address() as net.AddressInfo).port}`;
  return { buckets, objects, seen, url, close: () => new Promise<void>((r) => srv.close(() => r())) };
}
