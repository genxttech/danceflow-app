// Authenticated walkthrough host: Next (DEV-bound build) on 127.0.0.1:3018 behind a logging proxy on 127.0.0.1:3017.
// The proxy logs ONLY method, path (no query), status, redirect path, and a boolean for server-action posts. Never headers, cookies, bodies or tokens.
const fs = require("fs"), cp = require("child_process"), http = require("http");
const WT = "C:/Dev/studioapp-devpf", D = process.env.TEMP + "/devpf", DEV = "epdrtzcydvnoidwrepqz";
const PUB = 3017, INT = 3018;
const lines = fs.readFileSync("C:/Dev/studioapp/.env.local", "utf8").split(/\r?\n/);
const pick = (k) => { for (const l of lines) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/); if (m && m[1] === k) return m[2].trim().replace(/^["']|["']$/g, ""); } };
const URLV = pick("NEXT_PUBLIC_SUPABASE_URL"), ANON = pick("NEXT_PUBLIC_SUPABASE_ANON_KEY"), SVC = pick("SUPABASE_SERVICE_ROLE_KEY");
if (!URLV || !ANON || !SVC || new URL(URLV).host !== `${DEV}.supabase.co`) { console.log("STOP: values missing or URL is not DEV"); process.exit(2); }
const GUARD = D + "/netguard-auth.log", REQLOG = D + "/auth-requests.log", SRVLOG = D + "/auth-server.log";
for (const f of [GUARD, REQLOG, SRVLOG]) fs.writeFileSync(f, "");
const env = {
  PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, windir: process.env.windir, TEMP: process.env.TEMP, TMP: process.env.TMP,
  USERPROFILE: process.env.USERPROFILE, APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA, HOME: process.env.HOME || process.env.USERPROFILE,
  NODE_OPTIONS: "--max-old-space-size=4096 --require <TEMP>/devpf/netguard2.cjs", NEXT_TELEMETRY_DISABLED: "1",
  NETGUARD_LOG: GUARD, NETGUARD_ALLOW: `${DEV}.supabase.co`, NODE_ENV: "production",
  NEXT_PUBLIC_SUPABASE_URL: URLV, NEXT_PUBLIC_SUPABASE_ANON_KEY: ANON, SUPABASE_SERVICE_ROLE_KEY: SVC,
  NEXT_PUBLIC_APP_URL: `http://localhost:${PUB}`, NEXT_PUBLIC_SITE_URL: `http://localhost:${PUB}`,
};
console.log("env names passed to the app:", Object.keys(env).join(","));
const red = (t) => [[URLV, "<url>"], [ANON, "<anon>"], [SVC, "<service>"]].reduce((s, [v, r]) => s.split(v).join(r), t);
const child = cp.spawn(process.execPath, [WT + "/node_modules/next/dist/bin/next", "start", "-H", "127.0.0.1", "-p", String(INT)], { cwd: WT, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
child.stdout.on("data", (d) => fs.appendFileSync(SRVLOG, red(String(d)))); child.stderr.on("data", (d) => fs.appendFileSync(SRVLOG, red(String(d))));
const locPath = (l) => { if (!l) return ""; try { const u = new URL(l, "http://x"); return (u.host !== "x" && !/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(u.host) ? u.host : "") + u.pathname; } catch { return "?"; } };
const server = http.createServer((req, res) => {
  const pathOnly = (req.url || "").split("?")[0];
  const pr = http.request({ host: "127.0.0.1", port: INT, method: req.method, path: req.url, headers: req.headers }, (r) => {
    fs.appendFileSync(REQLOG, `${new Date().toISOString().slice(11, 19)} ${req.method} ${pathOnly} -> ${r.statusCode}${r.headers.location ? " location=" + locPath(r.headers.location) : ""}${req.headers["next-action"] ? " server-action" : ""}\n`);
    res.writeHead(r.statusCode, r.headers); r.pipe(res);
  });
  pr.on("error", () => { fs.appendFileSync(REQLOG, `${new Date().toISOString().slice(11, 19)} ${req.method} ${pathOnly} -> 502\n`); res.writeHead(502); res.end(); });
  req.pipe(pr);
});
server.listen(PUB, "127.0.0.1", () => {
  fs.writeFileSync(D + "/auth-pids.json", JSON.stringify({ launcher: process.pid, next: child.pid }));
  console.log(`proxy listening on 127.0.0.1:${PUB} -> next on 127.0.0.1:${INT}`);
});
process.on("SIGTERM", () => { try { child.kill(); } catch {} process.exit(0); });
