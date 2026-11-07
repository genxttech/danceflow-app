// D4-2 real-Next.js browser acceptance: STACK + HELPERS (local disposable only).
// Containers are labelled df.d4nxe=1 and named df-nxe-*; nothing outside that label is ever touched. No hosted service, no provider call, no real credential.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, openSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(here, "..", "..", "..", "..");
export const HOME = process.env.D4NXE_HOME ?? path.join(os.tmpdir(), "df-nxe");
export const STATE_FILE = path.join(HOME, "state.json");
export const LABEL = "df.d4nxe=1";
export const NET = "df-nxe-net";
export const SNAP = "df-nxe/snap:chain";
export const NAMES = { db: "df-nxe-db", rest: "df-nxe-rest", auth: "df-nxe-auth", kong: "df-nxe-kong" };
export const PG_IMAGE = process.env.D4NXE_PG_IMAGE ?? "df-isoqa/base:20261119092100";
export const CUTOFF = "20261119092100";
const REST_IMAGE = process.env.ISO_QA_REST_IMAGE ?? "public.ecr.aws/supabase/postgrest:v14.8";
const KONG_IMAGE = process.env.ISO_QA_KONG_IMAGE ?? "public.ecr.aws/supabase/kong:2.8.1";
const GOTRUE_IMAGE = process.env.ISO_QA_GOTRUE_IMAGE ?? "public.ecr.aws/supabase/gotrue:v2.188.1";
export const MIGRATIONS = path.join(REPO, "src", "lib", "supabase", "migrations");
export const MONITOR_REF = "origin/claude/d4-2-price-monitoring";
export const MONITOR_FILE = "20270210110000_twilio_price_monitor.sql";
process.env.MSYS_NO_PATHCONV = "1";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const docker = (...a) => execFileSync("docker", a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 600_000, maxBuffer: 1 << 28 }).trim();
export const dockerTry = (...a) => {
  const r = spawnSync("docker", a, { encoding: "utf8", maxBuffer: 1 << 28 });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
};
const ours = (n) => dockerTry("inspect", "--format", '{{ index .Config.Labels "df.d4nxe" }}', n).out === "1";
export function removeAll() {
  for (const n of [NAMES.kong, NAMES.auth, NAMES.rest, NAMES.db]) if (dockerTry("inspect", n).ok) { if (!ours(n)) throw new Error(`refusing to remove ${n}: not labelled ${LABEL}`); docker("rm", "-f", n); }
  if (dockerTry("network", "inspect", NET).ok) dockerTry("network", "rm", NET);
}
export const removeSnapshot = () => { if (dockerTry("image", "inspect", SNAP).ok) dockerTry("rmi", "-f", SNAP); };

export function psql(sql, { user = "postgres", container = NAMES.db } = {}) {
  const r = spawnSync("docker", ["exec", "-i", "-e", "PGPASSWORD=postgres", container, "psql", "-U", user, "-d", "postgres", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose"], { input: sql, encoding: "utf8", maxBuffer: 1 << 28 });
  return { code: r.status ?? 1, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}
export const q = (sql) => { const r = psql(sql); if (r.code !== 0) throw new Error(`sql failed: ${r.err.slice(0, 400)}`); return r.out; };

// ------------------------------------------------------------------------------------------------ tokens
const b64u = (b) => Buffer.from(b).toString("base64url");
export function signHs256(secret, payload) {
  const head = b64u(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64u(JSON.stringify(payload));
  return `${head}.${body}.${createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url")}`;
}
function base32(s) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of s.replace(/=+$/, "").toUpperCase()) bits += alphabet.indexOf(ch).toString(2).padStart(5, "0");
  const out = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(out);
}
export function totp(secret, atMs = Date.now()) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(atMs / 30000)));
  const h = createHmac("sha1", base32(secret)).update(counter).digest();
  const o = h[h.length - 1] & 0xf;
  const code = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(code % 1_000_000).padStart(6, "0");
}
export async function http(method, url, token, body, extra = {}) {
  const res = await fetch(url, { method, headers: { "content-type": "application/json", apikey: "local-no-key-auth", ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, json, text };
}

async function freePort(lo, hi) {
  const used = new Set((dockerTry("ps", "--format", "{{.Ports}}").out.match(/:(\d+)->/g) ?? []).map((m) => Number(m.slice(1, -2))));
  for (let p = lo; p <= hi; p++) {
    if (used.has(p)) continue;
    const ok = await new Promise((res) => { const s = net.createServer(); s.once("error", () => res(false)); s.listen(p, "127.0.0.1", () => s.close(() => res(true))); });
    if (ok) return p;
  }
  throw new Error(`no free port in ${lo}-${hi}`);
}

const KONG_YML = (rest, auth) => `_format_version: "2.1"\nservices:\n  - name: rest-v1\n    url: http://${rest}:3000/\n    routes:\n      - name: rest-v1\n        strip_path: true\n        paths: ["/rest/v1/"]\n  - name: auth-v1\n    url: http://${auth}:9999/\n    routes:\n      - name: auth-v1\n        strip_path: true\n        paths: ["/auth/v1/"]\n`;

function migrationPlan({ monitor }) {
  const items = readdirSync(MIGRATIONS).filter((n) => /^\d{14}.*\.sql$/.test(n) && n.slice(0, 14) > CUTOFF).sort().map((n) => ({ file: n, sql: readFileSync(path.join(MIGRATIONS, n), "utf8") }));
  if (monitor && !items.some((i) => i.file === MONITOR_FILE)) {
    const sql = execFileSync("git", ["show", `${MONITOR_REF}:src/lib/supabase/migrations/${MONITOR_FILE}`], { cwd: REPO, encoding: "utf8", maxBuffer: 1 << 26 });
    items.push({ file: MONITOR_FILE, sql });
    items.sort((a, b) => (a.file < b.file ? -1 : 1));
  }
  return items;
}

async function waitDb(ms = 300_000) {
  const t0 = Date.now();
  let ok = 0;
  while (Date.now() - t0 < ms) {
    const r = dockerTry("exec", NAMES.db, "psql", "-U", "postgres", "-d", "postgres", "-At", "-c", "select 1");
    ok = r.ok ? ok + 1 : 0;
    if (ok >= 3) return;
    await sleep(r.ok ? 3000 : 2500);
  }
  throw new Error("database did not become ready");
}

/** Brings up Postgres (migration chain) + PostgREST + GoTrue + Kong. Returns the state object (also written to STATE_FILE). */
export async function stackUp({ appPort, monitor = true, reuse = false, _prev = null }) {
  mkdirSync(HOME, { recursive: true });
  const prev = _prev ?? (reuse ? loadState() : null); // --reuse: same JWT secret and Kong port, so an already-built app keeps working against a fresh database
  removeAll();
  // --reuse: restart from the snapshot taken right after the chain + GoTrue migrations of the previous `up` (seconds instead of minutes); a clean database every time
  const fromSnap = reuse && dockerTry("image", "inspect", SNAP).ok;
  if (!fromSnap && !dockerTry("image", "inspect", PG_IMAGE).ok) throw new Error(`baseline image ${PG_IMAGE} not found`);
  docker("network", "create", "--label", LABEL, NET);
  docker("run", "-d", "--name", NAMES.db, "--label", LABEL, "--network", NET, "--memory", "1500m", "--cpus", "2", "-e", "POSTGRES_PASSWORD=postgres", fromSnap ? SNAP : PG_IMAGE, "postgres", "-D", "/etc/postgresql", "-c", "supautils.hint_roles=");
  await waitDb();
  const plan = fromSnap ? [] : migrationPlan({ monitor });
  const applied = fromSnap ? [...(prev?.applied ?? [])] : [];
  for (const m of plan) {
    const r = psql(m.sql);
    if (r.code !== 0 || /(^|\n)(psql:[^\n]*?: )?(ERROR|FATAL|PANIC):/.test(`${r.out}\n${r.err}`)) throw new Error(`migration ${m.file} failed: ${(r.err || r.out).slice(0, 500)}`);
    applied.push(m.file);
  }
  const jwt = prev?.jwt ?? createHash("sha256").update(`${Date.now()}${Math.random()}${randomBytes(8).toString("hex")}`).digest("hex").slice(0, 48);
  const port = prev?.kongPort ?? (await freePort(56900, 56949));
  const yml = path.join(HOME, "kong.yml");
  writeFileSync(yml, KONG_YML(NAMES.rest, NAMES.auth));
  const pw = psql("alter role authenticator with password 'postgres';", { user: "supabase_admin" });
  if (pw.code !== 0) throw new Error(`authenticator password: ${pw.err.slice(0, 200)}`);
  docker("run", "-d", "--name", NAMES.rest, "--label", LABEL, "--network", NET, "--memory", "256m", "--cpus", "0.5", "-e", `PGRST_DB_URI=postgres://authenticator:postgres@${NAMES.db}:5432/postgres`, "-e", "PGRST_DB_SCHEMAS=public",
    "-e", "PGRST_DB_ANON_ROLE=anon", "-e", `PGRST_JWT_SECRET=${jwt}`, "-e", "PGRST_DB_USE_LEGACY_GUCS=false", REST_IMAGE);
  const own = psql("alter role supabase_auth_admin with password 'postgres';\ndo $q$ declare r record; begin\n  for r in select p.oid::regprocedure as sig from pg_proc p where p.pronamespace = 'auth'::regnamespace and p.proowner <> 'supabase_auth_admin'::regrole loop execute format('alter function %s owner to supabase_auth_admin', r.sig); end loop;\n  for r in select c.oid::regclass as rel, c.relkind from pg_class c where c.relnamespace = 'auth'::regnamespace and c.relkind in ('r','p','v','m','S') and c.relowner <> 'supabase_auth_admin'::regrole loop\n    execute format('alter %s %s owner to supabase_auth_admin', case r.relkind when 'S' then 'sequence' when 'v' then 'view' when 'm' then 'materialized view' else 'table' end, r.rel); end loop;\n  for r in select t.oid::regtype as ty from pg_type t where t.typnamespace = 'auth'::regnamespace and t.typtype = 'e' and t.typowner <> 'supabase_auth_admin'::regrole loop execute format('alter type %s owner to supabase_auth_admin', r.ty); end loop;\nend $q$;", { user: "supabase_admin" });
  if (own.code !== 0) throw new Error(`auth schema ownership: ${own.err.slice(0, 300)}`);
  const e = (k, v) => ["-e", `${k}=${v}`];
  const appOrigin = `http://localhost:${appPort}`;
  docker("run", "-d", "--name", NAMES.auth, "--label", LABEL, "--network", NET, "--memory", "256m", "--cpus", "0.5",
    ...e("GOTRUE_API_HOST", "0.0.0.0"), ...e("GOTRUE_API_PORT", "9999"), ...e("API_EXTERNAL_URL", `http://127.0.0.1:${port}`), ...e("GOTRUE_DB_DRIVER", "postgres"), ...e("GOTRUE_DB_NAMESPACE", "auth"),
    ...e("GOTRUE_DB_DATABASE_URL", `postgres://supabase_auth_admin:postgres@${NAMES.db}:5432/postgres`), ...e("GOTRUE_SITE_URL", appOrigin), ...e("GOTRUE_JWT_SECRET", jwt), ...e("GOTRUE_JWT_EXP", "3600"),
    ...e("GOTRUE_JWT_AUD", "authenticated"), ...e("GOTRUE_JWT_DEFAULT_GROUP_NAME", "authenticated"), ...e("GOTRUE_DISABLE_SIGNUP", "false"), ...e("GOTRUE_EXTERNAL_EMAIL_ENABLED", "true"), ...e("GOTRUE_MAILER_AUTOCONFIRM", "true"),
    ...e("GOTRUE_MFA_TOTP_ENROLL_ENABLED", "true"), ...e("GOTRUE_MFA_TOTP_VERIFY_ENABLED", "true"), ...e("GOTRUE_RATE_LIMIT_EMAIL_SENT", "1000"), ...e("GOTRUE_LOG_LEVEL", "info"), GOTRUE_IMAGE);
  docker("create", "--name", NAMES.kong, "--label", LABEL, "--network", NET, "--memory", "512m", "--cpus", "1", "-p", `127.0.0.1:${port}:8000`, "-e", "KONG_DATABASE=off", "-e", "KONG_NGINX_WORKER_PROCESSES=1",
    "-e", "KONG_NGINX_HTTP_KEEPALIVE_TIMEOUT=3600s", "-e", "KONG_NGINX_HTTP_KEEPALIVE_REQUESTS=100000", "-e", "KONG_DECLARATIVE_CONFIG=/home/kong/kong.yml", "-e", "KONG_PROXY_LISTEN=0.0.0.0:8000", "-e", "KONG_DNS_ORDER=LAST,A,CNAME", KONG_IMAGE);
  docker("cp", yml, `${NAMES.kong}:/home/kong/kong.yml`);
  docker("start", NAMES.kong);
  const url = `http://127.0.0.1:${port}`;
  const t0 = Date.now();
  for (;;) {
    try {
      const a = await fetch(`${url}/auth/v1/health`, { signal: AbortSignal.timeout(8000) });
      const r = await fetch(`${url}/rest/v1/`, { headers: { apikey: "x" }, signal: AbortSignal.timeout(8000) });
      if (a.status === 200 && r.status < 500) break;
    } catch { /* not yet */ }
    if (Date.now() - t0 > 180_000) throw new Error("the API did not come up");
    await sleep(1500);
  }
  if (!fromSnap) {
    // snapshot from a CLEANLY stopped database (a crash-recovery start of this image takes minutes of fsync on a busy host), then restart everything from it
    docker("stop", "-t", "120", NAMES.db);
    docker("commit", NAMES.db, SNAP);
    removeAll();
    return stackUp({ appPort, monitor, reuse: true, _prev: { jwt, kongPort: port, applied, anon: undefined, service: undefined, appPid: null } });
  }
  const now = Math.floor(Date.now() / 1000);
  const anon = signHs256(jwt, { role: "anon", iss: "supabase-local", iat: now, exp: now + 86400 * 30 });
  const service = signHs256(jwt, { role: "service_role", iss: "supabase-local", iat: now, exp: now + 86400 * 30 });
  const state = { url, kongPort: port, appPort, appOrigin, jwt, anon: prev?.anon ?? anon, service: prev?.service ?? service, applied, startedAt: new Date().toISOString(), appPid: prev?.appPid ?? null };
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  return state;
}

export const loadState = () => (existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : null);
export const saveState = (s) => writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));

export function appEnv(s) {
  return {
    ...process.env,
    NEXT_PUBLIC_SUPABASE_URL: s.url, NEXT_PUBLIC_SUPABASE_ANON_KEY: s.anon, SUPABASE_SERVICE_ROLE_KEY: s.service,
    NEXT_PUBLIC_APP_URL: s.appOrigin, NEXT_PUBLIC_SITE_URL: s.appOrigin, APP_URL: s.appOrigin, SITE_URL: s.appOrigin,
    // dummy provider configuration: no key here is real, and every SMS / pricing switch stays at its default (off)
    STRIPE_SECRET_KEY: "sk_test_dummy_d4nxe", STRIPE_WEBHOOK_SECRET: "whsec_dummy_d4nxe", NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: "pk_test_dummy_d4nxe",
    RESEND_API_KEY: "re_dummy_d4nxe", TWILIO_ACCOUNT_SID: "ACdummyd4nxe00000000000000000000", TWILIO_AUTH_TOKEN: "dummy_d4nxe", NEXT_TELEMETRY_DISABLED: "1",
  };
}

const NEXT_BIN = path.join(REPO, "node_modules", "next", "dist", "bin", "next");
export function buildApp(s, { log }) {
  const out = openSync(log, "w");
  const r = spawnSync(process.execPath, ["--max-old-space-size=6144", NEXT_BIN, "build"], { cwd: REPO, env: appEnv(s), stdio: ["ignore", out, out], timeout: Number(process.env.D4NXE_BUILD_MIN ?? 45) * 60_000 });
  return r.status === 0;
}
export function startApp(s, { log, dev = false }) {
  const out = openSync(log, "a");
  const args = dev ? [NEXT_BIN, "dev", "--webpack", "-p", String(s.appPort)] : [NEXT_BIN, "start", "-p", String(s.appPort)];
  const child = spawn(process.execPath, args, { cwd: REPO, env: { ...appEnv(s), ...(dev ? {} : { NODE_ENV: "production" }) }, stdio: ["ignore", out, out], detached: true, windowsHide: true });
  child.unref();
  s.appPid = child.pid;
  saveState(s);
  return child.pid;
}
export async function waitApp(s, ms = 180_000) {
  const t0 = Date.now();
  await sleep(3000);
  for (;;) {
    try { const r = await fetch(`${s.appOrigin}/login`, { redirect: "manual", signal: AbortSignal.timeout(20000) }); if (r.status < 500) return; } catch { /* not yet */ }
    if (Date.now() - t0 > ms) throw new Error("the app did not come up");
    await sleep(2000);
  }
}
export function stopApp(s) {
  if (s?.appPid) spawnSync("taskkill", ["/PID", String(s.appPid), "/T", "/F"], { stdio: "ignore" });
  // belt and braces: whatever still listens on the app port is the app this harness started (a stale server would otherwise serve an OLD build)
  if (s?.appPort) spawnSync("powershell", ["-NoProfile", "-Command", `Get-NetTCPConnection -LocalPort ${s.appPort} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }`], { stdio: "ignore" });
  if (s) s.appPid = null;
}
