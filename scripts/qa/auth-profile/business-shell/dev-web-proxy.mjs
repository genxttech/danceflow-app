#!/usr/bin/env node
// DEV / QA ONLY. Serves an Expo web export and proxies /api/* to a local Next server on the same origin.
// Why: /api/staff/* sends no CORS headers by design (its clients are native apps, which do not need them), so a browser build of the Business app can
// only call it same-origin. This proxy exists for web screenshots and walkthroughs; it is never part of a deployment and the API is not changed for it.
//   node dev-web-proxy.mjs <dist-dir> [--port 8790] [--next http://127.0.0.1:3100]
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const dist = path.resolve(args[0] ?? "");
if (!args[0] || !fs.existsSync(path.join(dist, "index.html"))) throw new Error("usage: dev-web-proxy.mjs <expo web export dir> [--port 8790] [--next http://127.0.0.1:3100]");
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const port = Number(opt("port", "8790"));
const next = new URL(opt("next", "http://127.0.0.1:3100"));
if (!["127.0.0.1", "localhost"].includes(next.hostname)) throw new Error("--next must be a local server");

const types = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".png": "image/png", ".ttf": "font/ttf", ".json": "application/json", ".ico": "image/x-icon" };

http
  .createServer((req, res) => {
    if (req.url.startsWith("/api/")) {
      const upstream = http.request(
        { host: next.hostname, port: next.port, method: req.method, path: req.url, headers: { ...req.headers, host: next.host } },
        (up) => {
          res.writeHead(up.statusCode ?? 502, up.headers);
          up.pipe(res);
        },
      );
      upstream.on("error", (e) => {
        res.writeHead(502, { "content-type": "text/plain" });
        res.end(`dev-web-proxy: ${e.message}`);
      });
      return req.pipe(upstream);
    }
    const p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    let file = path.join(dist, p);
    if (!file.startsWith(dist) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(dist, "index.html");
    res.writeHead(200, { "Content-Type": types[path.extname(file)] ?? "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  })
  .listen(port, "127.0.0.1", () => console.log(`dev-web-proxy: http://localhost:${port} (api -> ${next.origin})`));
