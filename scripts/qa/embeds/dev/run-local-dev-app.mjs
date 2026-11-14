#!/usr/bin/env node
// Builds and serves THIS checkout as a production build on localhost, wired to hosted DEV Supabase and nothing else.
// There is no hosted deployment: nothing is uploaded, no Vercel project is touched, no cron runs, no domain exists. The process gets a MINIMAL
// environment (OS basics + DEV Supabase URL/anon/service keys + localhost site URL); no Stripe, Resend, Twilio, OpenAI, Mux or Google keys are
// present, so those integrations cannot act. Keys are read in-process from the supabase CLI and are never printed or written to disk.
//   node run-local-dev-app.mjs build            clean-tree check, next build, then the isolation scan of the build output
//   node run-local-dev-app.mjs start [port]     next start on 127.0.0.1 (default 3100), same minimal environment
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEV_REF, PROD_REF, devKeys } from "./provision-accounts.mjs";

const [cmd, portArg] = process.argv.slice(2);
const root = resolve(process.cwd());
if (!existsSync(join(root, "next.config.ts"))) throw new Error("run this from the repository root");
const port = Number(portArg ?? 3100);
const PROD_REF_B64 = Buffer.from(PROD_REF).toString("base64").replace(/=+$/, "");
const marker = join(root, ".next", ".dev-build-marker.json");

const git = (...a) => execFileSync("git", a, { cwd: root }).toString().trim();
const dirty = git("status", "--porcelain"); // untracked files count too: they would be built
if (dirty) throw new Error(`the checkout has uncommitted changes; build from a clean commit:\n${dirty}`);
const sha = git("rev-parse", "HEAD");
for (const f of readdirSync(root).filter((n) => n.startsWith(".env") && !n.endsWith(".example"))) {
  throw new Error(`${f} exists in the repository root and Next would read it; remove it first (it could carry other credentials)`);
}

const keep = ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "windir", "TEMP", "TMP", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "COMSPEC", "PATHEXT", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS"];
const k = devKeys();
const env = Object.fromEntries(keep.filter((n) => process.env[n] !== undefined).map((n) => [n, process.env[n]]));
Object.assign(env, {
  NODE_ENV: "production",
  NEXT_TELEMETRY_DISABLED: "1",
  NODE_OPTIONS: "--max-old-space-size=6144",
  NEXT_PUBLIC_SUPABASE_URL: k.url,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: k.anon,
  SUPABASE_SERVICE_ROLE_KEY: k.service,
  NEXT_PUBLIC_SITE_URL: `http://localhost:${port}`,
  APP_URL: `http://localhost:${port}`,
});
for (const [name, value] of Object.entries(env)) if (String(value).includes(PROD_REF)) throw new Error(`${name} mentions the PROD project: refusing`);

const nextBin = join(root, "node_modules", "next", "dist", "bin", "next");
const run = (args) => new Promise((ok, fail) => {
  const c = spawn(process.execPath, [nextBin, ...args], { cwd: root, env, stdio: "inherit" });
  c.on("exit", (code) => (code === 0 ? ok() : fail(new Error(`next ${args[0]} exited ${code}`))));
});

function scan(dir, hits) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    const s = statSync(p);
    if (s.isDirectory()) { if (n !== "cache") scan(p, hits); continue; }
    if (n === ".dev-build-marker.json" || s.size > 40e6) continue;
    const t = readFileSync(p, "latin1"); // every file except .next/cache, whatever its extension
    if (t.includes(PROD_REF) || t.includes(PROD_REF_B64)) hits.prod.push(p);
    if (t.includes(DEV_REF)) hits.dev += 1;
    if (t.includes(k.service)) hits.serviceInBundle.push(p);
  }
}

if (cmd === "build") {
  console.log(`commit ${sha}; building with DEV ${DEV_REF} and a minimal environment`);
  rmSync(join(root, ".next"), { recursive: true, force: true }); // no stale dev-server types or earlier builds with other wiring
  await run(["build"]);
  const hits = { prod: [], dev: 0, serviceInBundle: [] };
  scan(join(root, ".next"), hits);
  const staticHits = { prod: [], dev: 0, serviceInBundle: [] };
  scan(join(root, ".next", "static"), staticHits);
  console.log(JSON.stringify({ commit: sha, devRefFiles: hits.dev, prodRefFiles: hits.prod.length, serviceKeyInAnyFile: hits.serviceInBundle.length, serviceKeyInBrowserBundle: staticHits.serviceInBundle.length }));
  if (hits.prod.length || hits.dev === 0 || staticHits.serviceInBundle.length) throw new Error("isolation scan failed: the build must mention DEV, never PROD, and the service key must not be in the browser bundle");
  writeFileSync(marker, JSON.stringify({ sha, ref: DEV_REF, scanPass: true }));
  console.log("ISOLATION SCAN PASS");
} else if (cmd === "start") {
  // `start` serves whatever is in .next: only serve a build this script made from this exact commit, and re-scan it first.
  const m = existsSync(marker) ? JSON.parse(readFileSync(marker, "utf8")) : null;
  if (!m || m.sha !== sha || m.ref !== DEV_REF || !m.scanPass) throw new Error("no matching build marker: run `build` first from this commit");
  const again = { prod: [], dev: 0, serviceInBundle: [] };
  scan(join(root, ".next"), again);
  if (again.prod.length || again.dev === 0) throw new Error("re-scan of the build failed: it is not a DEV-only build");
  console.log(`commit ${sha}; serving on http://127.0.0.1:${port} against DEV ${DEV_REF}`);
  await run(["start", "-H", "127.0.0.1", "-p", String(port)]);
} else {
  throw new Error("usage: run-local-dev-app.mjs build | start [port]");
}
