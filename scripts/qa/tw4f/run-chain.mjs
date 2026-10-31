#!/usr/bin/env node
/**
 * TW-4F Q1 continuous-QA runner (local developer tool, read-only against git).
 *
 * Applies the TW-4F migration chain on a DEDICATED, disposable Postgres container and proves, for main plus any number of slice migrations:
 *   chain   apply -> reverse rollback -> re-apply, with a function-body / catalog fingerprint compared at every step (CRLF normalised)
 *   suites  every localStack.* vitest suite, serially, each against its OWN fresh database cloned from the applied chain
 *
 * Nothing here touches a hosted database, Twilio, Stripe, or any other session's container. All containers carry the label df.tw4fq1=1 and the prefix df-q1-,
 * live on their own network (df-q1-net), and only Kong publishes a port (127.0.0.1:56800-56899). Migrations and tests are read from git refs, never from a
 * working tree; another commit's suites run from a private detached worktree under the QA home (never inside a slice session's worktree).
 *
 *   node scripts/qa/tw4f/run-chain.mjs chain  [options]
 *   node scripts/qa/tw4f/run-chain.mjs suites [options] [--suite <path> ...]
 *   node scripts/qa/tw4f/run-chain.mjs all    [options]            chain + suites
 *   node scripts/qa/tw4f/run-chain.mjs baseline [options]         apply the plan once and write the probe_fingerprint.sql / FP_SQL fingerprints (WP-D0)
 *   node scripts/qa/tw4f/run-chain.mjs down                        remove this tool's leftover containers
 *
 * Options
 *   --base <ref>             ref providing the baseline chain and the default tests (default origin/main)
 *   --extra-branch <ref>     add every migration (version > cutoff) that exists at <ref> but not at --base (repeatable)
 *   --extra <ref:version>    add one migration file (repeatable); e.g. origin/twilio-tw4f-f3-recon-gate:20261218
 *   --order numeric|given    apply in version order (default) or main chain first, then extras in the order given
 *   --tests-ref <ref>        ref whose localStack suites run (default: the last --extra-branch ref, else --base)
 *   --image <tag>            baseline image (default df-isoqa/base:20261205090000, built by scripts/qa/iso-qa.mjs `baseline` from PR #266)
 *   --cutoff <version>       highest version already inside the baseline image (default 20261205090000)
 *   --label <text>           name of the run in the report
 *   --out <dir>              evidence directory (default <QA home>/runs/<time>-<label>)
 *   --env KEY=VALUE          extra environment for every suite (repeatable; the token {db} becomes the suite database container name), e.g. --env TW4RFL_DB=postgres --env ISO_QA_MARKER=1
 *   --until <version>        drop every planned migration whose version is above <version> (e.g. 20261231100000: the hosted DEV pending list)
 *   --track-functions        start every SUITE database with track_functions=all and write coverage.json per suite (pg_stat_user_functions vs public functions)
 *   --marker                 create public.tw4_local_qa_only in the seed before the plan (plus the auth.users columns GoTrue adds, i.e. iso-qa.mjs parity: ISO_QA_MARKER=1 and its auth step; 11 localStack suites require them)
 *   --auth                   also start a disposable local GoTrue (own container, TOTP MFA on, auto-confirm, no SMTP) behind Kong at /auth/v1 and export TW4_LOCAL_AUTH_URL (WP-D2 layer b)
 *   --keep                   keep the chain image and worktrees
 *   --known <file>           known environment failures (default scripts/qa/tw4f/known-failures.json)
 *
 * Exit: 0 all green; 1 a check or test failed on a healthy database; 3 infrastructure failure (database crash/OOM, migration error); 4 nothing ran / skipped (BLOCKED);
 *       6 only KNOWN, explained environment failures remain; 2 usage.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, rmdirSync, symlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, "..", "..", "..");
const QA_HOME = process.env.TW4F_QA_HOME ?? path.join(os.tmpdir(), "danceflow-tw4f-q1");
const NET = "df-q1-net";
const LABEL = "df.tw4fq1=1";
const PG_IMAGE_DEFAULT = "df-isoqa/base:20261205090000";
const REST_IMAGE = process.env.ISO_QA_REST_IMAGE ?? "public.ecr.aws/supabase/postgrest:v14.8";
const KONG_IMAGE = process.env.ISO_QA_KONG_IMAGE ?? "public.ecr.aws/supabase/kong:2.8.1";
const MIGRATIONS = "src/lib/supabase/migrations";
const ROLLBACKS = `${MIGRATIONS}/rollback`;
/** supautils in image 17.6.1.106 segfaults on "permission denied for function" for API roles (docs/twilio/TW-4F_Isolated_QA.md section 1): empty hint_roles avoids it. */
const PG_ARGS = ["postgres", "-D", "/etc/postgresql", "-c", "supautils.hint_roles="];
const LIMITS = { db: ["--memory", "1500m", "--cpus", "2"], rest: ["--memory", "256m", "--cpus", "0.5"], kong: ["--memory", "1280m", "--cpus", "1"] };

process.env.MSYS_NO_PATHCONV = "1";
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 600_000, maxBuffer: 1 << 28, ...opts }).trim();
const docker = (...a) => sh("docker", a);
const dockerTry = (...a) => { try { return { ok: true, out: docker(...a) }; } catch (e) { return { ok: false, out: String(e.stderr ?? e.message) }; } };
const dockerLogs = (name) => { const r = spawnSync("docker", ["logs", name], { encoding: "utf8", maxBuffer: 1 << 28 }); return `${r.stdout ?? ""}${r.stderr ?? ""}`; };
const git = (...a) => sh("git", ["-C", REPO, ...a]);
const gitShow = (ref, file) => execFileSync("git", ["-C", REPO, "show", `${ref}:${file}`], { encoding: "utf8", maxBuffer: 1 << 28 });
const log = (...a) => console.error("[tw4f-q1]", ...a);
const die = (m, code = 2) => { console.error(`[tw4f-q1] ${m}`); process.exit(code); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (t) => createHash("sha256").update(t).digest("hex");
const ERROR_RE = /(^|\n)(psql:[^\n]*?: )?(ERROR|FATAL|PANIC):/;
const CRASH_RE = /terminated by signal|was terminated by|exited with exit code [1-9]|reinitializing|PANIC:|out of memory/i;

// ------------------------------------------------------------------------------------------------------------------------------------ args
function parseArgs(argv) {
  const flags = { extraBranch: [], extra: [], suite: [], env: {} };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { rest.push(a); continue; }
    const k = a.slice(2);
    if (k === "keep") { flags.keep = true; continue; }
    if (k === "marker") { flags.marker = true; continue; }
    if (k === "auth") { flags.auth = true; continue; }
    if (k === "track-functions") { flags.trackFunctions = true; continue; }
    const v = argv[++i];
    if (v === undefined) die(`--${k} needs a value`);
    if (k === "extra-branch") flags.extraBranch.push(v);
    else if (k === "extra") flags.extra.push(v);
    else if (k === "suite") flags.suite.push(v);
    else if (k === "env") { const i = v.indexOf("="); flags.env[v.slice(0, i)] = v.slice(i + 1); }
    else flags[k.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v;
  }
  return { flags, rest };
}
const { flags, rest } = parseArgs(process.argv.slice(2));
const cmd = rest[0];
if (!["chain", "suites", "all", "baseline", "down"].includes(cmd ?? "")) die("usage: run-chain.mjs chain|suites|all|down [options] (see the header of this file)");

const resolveRef = (ref) => { try { return git("rev-parse", "--verify", `${ref}^{commit}`); } catch { return die(`cannot resolve git ref ${ref} (git fetch origin first)`); } };
const verOf = (name) => name.slice(0, 14);

// ------------------------------------------------------------------------------------------------------------------------------------ docker plumbing
const ensureNetwork = () => { if (!dockerTry("network", "inspect", NET).ok) docker("network", "create", "--label", LABEL, NET); };
const ours = (name) => name.startsWith("df-q1-") && dockerTry("inspect", "--format", '{{ index .Config.Labels "df.tw4fq1" }}', name).out === "1";
const assertOurs = (n) => { if (!ours(n)) die(`refusing to touch ${n}: not a TW-4F Q1 container`); };
function psql(container, sql, { user = "postgres", tuples = false } = {}) {
  assertOurs(container);
  const r = spawnSync("docker", ["exec", "-i", "-e", "PGPASSWORD=postgres", container, "psql", "-U", user, "-d", "postgres", "-q", "-v", "ON_ERROR_STOP=1", ...(tuples ? ["-At"] : [])], { input: sql, encoding: "utf8", maxBuffer: 1 << 28 });
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}
async function waitReady(container, ms = 300_000) {
  const t0 = Date.now();
  let ok = 0;
  while (Date.now() - t0 < ms) {
    const r = dockerTry("exec", container, "psql", "-U", "postgres", "-d", "postgres", "-At", "-c", "select 1");
    ok = r.ok ? ok + 1 : 0;
    if (ok >= 3) return;
    await sleep(r.ok ? 3000 : 2500);
  }
  throw Object.assign(new Error(`${container} did not become ready`), { infra: true });
}
const dbState = (c) => {
  const r = dockerTry("inspect", "--format", "{{.State.Running}}|{{.State.OOMKilled}}|{{.State.StartedAt}}|{{.RestartCount}}", c);
  if (!r.ok) return { running: false, oom: true, startedAt: "", restarts: -1 };
  const [running, oom, startedAt, restarts] = r.out.split("|");
  return { running: running === "true", oom: oom === "true", startedAt, restarts: Number(restarts) };
};
function assertHealthy(c, since) {
  const lines = dockerLogs(c).split("\n").filter((l) => CRASH_RE.test(l));
  const st = dbState(c);
  const p = [];
  if (lines.length) p.push(`${lines.length} crash/restart log line(s): ${lines[0].slice(0, 140)}`);
  if (!st.running) p.push("container not running");
  if (st.oom) p.push("container OOM-killed");
  if (since && (st.startedAt !== since.startedAt || st.restarts !== since.restarts)) p.push("container restarted");
  if (p.length) throw Object.assign(new Error(`database unhealthy (${c}): ${p.join("; ")}`), { infra: true });
}
const startDb = async (name, image, extraPgArgs = []) => {
  ensureNetwork();
  if (dockerTry("inspect", name).ok) { assertOurs(name); docker("rm", "-f", name); }
  docker("run", "-d", "--name", name, "--label", LABEL, "--network", NET, ...LIMITS.db, "-e", "POSTGRES_PASSWORD=postgres", image, ...PG_ARGS, ...extraPgArgs);
  await waitReady(name);
  return dbState(name);
};
const removeAll = (...names) => { for (const n of names) if (dockerTry("inspect", n).ok) { assertOurs(n); docker("rm", "-f", n); } };

async function freePort() {
  const used = new Set((dockerTry("ps", "--format", "{{.Ports}}").out.match(/:(\d+)->/g) ?? []).map((m) => Number(m.slice(1, -2))));
  for (let p = 56800; p <= 56899; p++) {
    if (used.has(p)) continue;
    const ok = await new Promise((res) => { const s = net.createServer(); s.once("error", () => res(false)); s.listen(p, "127.0.0.1", () => s.close(() => res(true))); });
    if (ok) return p;
  }
  throw new Error("no free port in 56800-56899");
}
const GOTRUE_IMAGE = process.env.ISO_QA_GOTRUE_IMAGE ?? "public.ecr.aws/supabase/gotrue:v2.188.1";
const kongYml = (rest, auth) => `_format_version: "2.1"\nservices:\n  - name: rest-v1\n    url: http://${rest}:3000/\n    routes:\n      - name: rest-v1\n        strip_path: true\n        paths: ["/rest/v1/"]\n${auth ? `  - name: auth-v1\n    url: http://${auth}:9999/\n    routes:\n      - name: auth-v1\n        strip_path: true\n        paths: ["/auth/v1/"]\n` : ""}`;
/** PostgREST + Kong in front of a started database; returns the env the suites need. */
async function startApi(base, dbName) {
  const n = { rest: `${base}-rest`, kong: `${base}-kong`, ...(flags.auth ? { auth: `${base}-auth` } : {}) };
  removeAll(...Object.values(n));
  const jwt = createHash("sha256").update(`${Date.now()}${Math.random()}`).digest("hex").slice(0, 48);
  const port = await freePort();
  const yml = path.join(QA_HOME, `kong-${base}.yml`);
  writeFileSync(yml, kongYml(n.rest, n.auth));
  const pw = psql(dbName, "alter role authenticator with password 'postgres';", { user: "supabase_admin" });
  if (pw.code !== 0) throw new Error(`could not set authenticator password: ${pw.out.slice(0, 200)}`);
  docker("run", "-d", "--name", n.rest, "--label", LABEL, "--network", NET, ...LIMITS.rest, "-e", `PGRST_DB_URI=postgres://authenticator:postgres@${dbName}:5432/postgres`, "-e", "PGRST_DB_SCHEMAS=public",
    "-e", "PGRST_DB_ANON_ROLE=anon", "-e", `PGRST_JWT_SECRET=${jwt}`, "-e", "PGRST_DB_USE_LEGACY_GUCS=false", REST_IMAGE);
  if (n.auth) {
    const e = (k, v) => ["-e", `${k}=${v}`];
    docker("run", "-d", "--name", n.auth, "--label", LABEL, "--network", NET, "--memory", "256m", "--cpus", "0.5",
      ...e("GOTRUE_API_HOST", "0.0.0.0"), ...e("GOTRUE_API_PORT", "9999"), ...e("API_EXTERNAL_URL", `http://127.0.0.1:${port}`), ...e("GOTRUE_DB_DRIVER", "postgres"), ...e("GOTRUE_DB_NAMESPACE", "auth"),
      ...e("GOTRUE_DB_DATABASE_URL", `postgres://supabase_auth_admin:postgres@${dbName}:5432/postgres`), ...e("GOTRUE_SITE_URL", "http://127.0.0.1:3000"), ...e("GOTRUE_JWT_SECRET", jwt), ...e("GOTRUE_JWT_EXP", "3600"),
      ...e("GOTRUE_JWT_AUD", "authenticated"), ...e("GOTRUE_JWT_DEFAULT_GROUP_NAME", "authenticated"), ...e("GOTRUE_DISABLE_SIGNUP", "false"), ...e("GOTRUE_EXTERNAL_EMAIL_ENABLED", "true"), ...e("GOTRUE_MAILER_AUTOCONFIRM", "true"),
      ...e("GOTRUE_MFA_TOTP_ENROLL_ENABLED", "true"), ...e("GOTRUE_MFA_TOTP_VERIFY_ENABLED", "true"), ...e("GOTRUE_RATE_LIMIT_EMAIL_SENT", "1000"), ...e("GOTRUE_LOG_LEVEL", "info"), GOTRUE_IMAGE);
  }
  docker("create", "--name", n.kong, "--label", LABEL, "--network", NET, ...LIMITS.kong, "-p", `127.0.0.1:${port}:8000`, "-e", "KONG_DATABASE=off", "-e", "KONG_NGINX_WORKER_PROCESSES=1",
    "-e", "KONG_NGINX_HTTP_KEEPALIVE_TIMEOUT=3600s", "-e", "KONG_NGINX_HTTP_KEEPALIVE_REQUESTS=100000", "-e", "KONG_DECLARATIVE_CONFIG=/home/kong/kong.yml", "-e", "KONG_PROXY_LISTEN=0.0.0.0:8000", "-e", "KONG_DNS_ORDER=LAST,A,CNAME", KONG_IMAGE);
  docker("cp", yml, `${n.kong}:/home/kong/kong.yml`);
  docker("start", n.kong);
  const url = `http://127.0.0.1:${port}`;
  const t0 = Date.now();
  for (;;) {
    try { const r = await fetch(`${url}/rest/v1/`, { headers: { apikey: "x" }, signal: AbortSignal.timeout(8000) }); if (r.status < 500) break; } catch { /* not yet */ }
    if (Date.now() - t0 > 180_000) throw Object.assign(new Error("the API did not come up"), { infra: true });
    await sleep(1500);
  }
  return { names: n, env: { TW4A_LOCAL_URL: url, TW4A_LOCAL_DB_CONTAINER: dbName, TW4A_LOCAL_JWT_SECRET: jwt, TW4_ISO_QA: "1", ...(n.auth ? { TW4_LOCAL_AUTH_URL: `${url}/auth/v1` } : {}) } };
}

// ------------------------------------------------------------------------------------------------------------------------------------ migration plan
const cutoff = flags.cutoff ?? "20261205090000";
const baseRef = flags.base ?? "origin/main";
const lsMig = (ref, dir) => { try { return git("ls-tree", "--name-only", `${ref}:${dir}`).split("\n").filter((n) => /^\d{14}.*\.sql$/.test(n)); } catch { return []; } };

function buildPlan() {
  const items = [];
  for (const n of lsMig(baseRef, MIGRATIONS)) if (verOf(n) > cutoff) items.push({ file: n, ref: baseRef, origin: "base" });
  const baseNames = new Set(items.map((i) => i.file));
  for (const ref of flags.extraBranch) for (const n of lsMig(ref, MIGRATIONS)) if (verOf(n) > cutoff && !baseNames.has(n)) items.push({ file: n, ref, origin: "extra" });
  for (const e of flags.extra) {
    const i = e.lastIndexOf(":");
    const ref = e.slice(0, i), version = e.slice(i + 1);
    const hit = lsMig(ref, MIGRATIONS).filter((n) => n.startsWith(version));
    if (hit.length !== 1) die(`--extra ${e}: expected exactly one migration ${version}* at ${ref}, found ${hit.length}`);
    if (!items.some((x) => x.file === hit[0])) items.push({ file: hit[0], ref, origin: "extra" });
  }
  const seen = new Map();
  for (const it of items) {
    const v = verOf(it.file);
    if (seen.has(v) && seen.get(v).file !== it.file) die(`version ${v} is used by two different migrations: ${seen.get(v).file} (${seen.get(v).ref}) and ${it.file} (${it.ref}); a hosted apply would collide`);
    seen.set(v, it);
  }
  for (const it of items) it.rollbackFile = `${it.file.replace(/\.sql$/, "")}_rollback.sql`;
  if (flags.until) for (let i = items.length - 1; i >= 0; i--) if (verOf(items[i].file) > flags.until) items.splice(i, 1);
  const sorted = [...items].sort((a, b) => (a.file < b.file ? -1 : 1));
  const ordered = flags.order === "given" ? [...sorted.filter((i) => i.origin === "base"), ...items.filter((i) => i.origin === "extra")] : sorted;
  for (const it of ordered) { it.sql = gitShow(it.ref, `${MIGRATIONS}/${it.file}`); try { it.rollbackSql = gitShow(it.ref, `${ROLLBACKS}/${it.rollbackFile}`); } catch { it.rollbackSql = null; } }
  return ordered;
}

// ------------------------------------------------------------------------------------------------------------------------------------ fingerprint (CRLF-normalised)
const FP_SQL = `
select 'fn ' || p.oid::regprocedure::text || ' ' || md5(replace(p.prosrc, E'\\r', '')) || ' args=' || pg_get_function_arguments(p.oid) || ' secdef=' || p.prosecdef || ' cfg=' || coalesce(p.proconfig::text, '-') || ' owner=' || p.proowner::regrole::text
  || ' ret=' || pg_get_function_result(p.oid) || ' vol=' || p.provolatile::text || ' strict=' || p.proisstrict || ' lang=' || (select l.lanname from pg_language l where l.oid = p.prolang) || ' acl=' || coalesce(p.proacl::text, '-')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'
union all select 'tbl ' || c.relname || ' rls=' || c.relrowsecurity || '/' || c.relforcerowsecurity || ' owner=' || c.relowner::regrole::text || ' acl=' || coalesce(c.relacl::text, '-') || ' cols=' ||
  (select string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull || ':' || coalesce(pg_get_expr(d.adbin, d.adrelid), '-') || ':' || a.attidentity::text || a.attgenerated::text, ',' order by a.attname)
     from pg_attribute a left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped)
  from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r', 'p')
union all select 'colacl ' || attrelid::regclass::text || ' ' || attname || ' ' || attacl::text from pg_attribute where attacl is not null and attrelid in (select oid from pg_class where relnamespace = 'public'::regnamespace)
union all select 'con ' || conrelid::regclass::text || ' ' || conname || ' ' || regexp_replace(pg_get_constraintdef(oid), '[[:space:]]+', ' ', 'g') from pg_constraint where connamespace = 'public'::regnamespace
union all select 'idx ' || tablename || ' ' || indexname || ' ' || md5(indexdef) from pg_indexes where schemaname = 'public'
union all select 'pol ' || tablename || ' ' || policyname || ' ' || cmd || ' ' || permissive || ' ' || roles::text || ' ' || md5(coalesce(qual, '') || '|' || coalesce(with_check, '')) from pg_policies where schemaname = 'public'
union all select 'trg ' || tgrelid::regclass::text || ' ' || tgname || ' ' || md5(pg_get_triggerdef(oid)) || ' enabled=' || tgenabled::text from pg_trigger where not tgisinternal and tgrelid in (select oid from pg_class where relnamespace = 'public'::regnamespace)
union all select 'view ' || c.relname || ' ' || md5(pg_get_viewdef(c.oid)) || ' acl=' || coalesce(c.relacl::text, '-') from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('v', 'm')
union all select 'seq ' || c.relname || ' acl=' || coalesce(c.relacl::text, '-') from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'S'
union all select 'type ' || t.typname || ' ' || t.typtype::text || ' ' || coalesce((select string_agg(e.enumlabel, ',' order by e.enumsortorder) from pg_enum e where e.enumtypid = t.oid), '-') from pg_type t where t.typnamespace = 'public'::regnamespace and t.typtype in ('e', 'd')
union all select 'defacl ' || defaclrole::regrole::text || ' ' || coalesce(defaclnamespace::regnamespace::text, '-') || ' ' || defaclobjtype::text || ' ' || defaclacl::text from pg_default_acl
union all select 'schema ' || nspname || ' ' || coalesce(nspacl::text, '-') from pg_namespace where nspname = 'public'
order by 1;`;
function fingerprint(db) {
  const r = psql(db, FP_SQL, { tuples: true });
  if (r.code !== 0 || ERROR_RE.test(r.out)) throw Object.assign(new Error(`fingerprint failed: ${r.out.slice(0, 300)}`), { infra: true });
  return r.out.split("\n").filter(Boolean);
}
const diffFp = (a, b) => {
  const A = new Set(a), B = new Set(b);
  return { onlyBefore: a.filter((x) => !B.has(x)), onlyAfter: b.filter((x) => !A.has(x)) };
};
const FN_NAME = (l) => l.replace(/^fn /, "").split(" ")[0];

// ------------------------------------------------------------------------------------------------------------------------------------ migration execution
function applySql(db, label, sql) {
  const t0 = Date.now();
  const r = psql(db, sql);
  const ms = Date.now() - t0;
  const ok = r.code === 0 && !ERROR_RE.test(r.out);
  return { label, ok, ms, error: ok ? null : r.out.slice(0, 600) };
}

async function chainCheck(plan, image, outDir) {
  const name = `df-q1-chain-${process.pid}`;
  const stages = [];
  const rec = (stage, status, detail = {}) => { stages.push({ stage, status, ...detail }); log(`${status.padEnd(7)} ${stage}${detail.note ? " - " + detail.note : ""}`); };
  let since;
  try {
    since = await startDb(name, image);
    const fp0 = fingerprint(name);
    rec("baseline image reachable", fp0.some((l) => /^fn (public\.)?tw4_/.test(l)) ? "PASS" : "FAIL", { note: `${fp0.length} catalog entries, image ${image}` });
    const main = plan.filter((p) => p.origin === "base");
    const extras = plan.filter((p) => p.origin === "extra");
    const applyAll = (list, stage) => {
      const rows = [];
      for (const m of list) {
        const r = applySql(name, m.file, m.sql);
        rows.push({ file: m.file, ms: r.ms, ok: r.ok });
        if (!r.ok) { rec(`${stage}: ${m.file}`, "FAIL", { error: r.error }); return { ok: false, rows }; }
      }
      return { ok: true, rows };
    };
    const rollAll = (list, stage) => {
      const rows = [];
      for (const m of [...list].reverse()) {
        if (!m.rollbackSql) { rec(`${stage}: ${m.rollbackFile}`, "BLOCKED", { note: "no rollback file at the ref" }); return { ok: false, rows }; }
        const r = applySql(name, m.rollbackFile, m.rollbackSql);
        rows.push({ file: m.rollbackFile, ms: r.ms, ok: r.ok });
        if (!r.ok) { rec(`${stage}: ${m.rollbackFile}`, "FAIL", { error: r.error }); return { ok: false, rows }; }
      }
      return { ok: true, rows };
    };
    const cmp = (stage, before, after, expectEqual = true) => {
      const d = diffFp(before, after);
      const same = d.onlyBefore.length === 0 && d.onlyAfter.length === 0;
      rec(stage, same === expectEqual ? "PASS" : "FAIL", { equal: same, onlyBefore: d.onlyBefore.slice(0, 40), onlyAfter: d.onlyAfter.slice(0, 40), counts: [d.onlyBefore.length, d.onlyAfter.length] });
      return same;
    };

    // 1. main chain
    const a1 = applyAll(main, "apply main chain");
    if (!a1.ok) return finish("FAIL");
    rec("apply main chain", "PASS", { note: `${main.length} migration(s), ${a1.rows.reduce((s, r) => s + r.ms, 0)} ms`, rows: a1.rows });
    const fpMain = fingerprint(name);
    let fpTop = fpMain;
    // 2. extras on top
    if (extras.length) {
      const a2 = applyAll(extras, "apply extras");
      if (!a2.ok) return finish("FAIL");
      rec("apply extras", "PASS", { note: `${extras.map((e) => e.file).join(", ")}`, rows: a2.rows });
      fpTop = fingerprint(name);
      const r2 = rollAll(extras, "rollback extras");
      if (!r2.ok) return finish("FAIL");
      cmp("rollback extras == main-only catalog", fpMain, fingerprint(name));
      const a3 = applyAll(extras, "re-apply extras");
      if (!a3.ok) return finish("FAIL");
      cmp("re-apply extras == first apply", fpTop, fingerprint(name));
    }
    // 3. rollback everything in reverse order, compare with the baseline
    const rAll = rollAll(plan, "rollback all (reverse order)");
    if (!rAll.ok) return finish("FAIL");
    rec("rollback all (reverse order)", "PASS", { note: `${plan.length} rollback(s) ran without error`, rows: rAll.rows });
    cmp("rollback all == baseline catalog", fp0, fingerprint(name));
    // 4. re-apply the full plan in plan order
    const a4 = applyAll(plan, "re-apply all");
    if (!a4.ok) return finish("FAIL");
    cmp("re-apply all == first apply", fpTop, fingerprint(name));
    // 5. second rollback + apply cycle proves repeatability
    const r5 = rollAll(plan, "rollback all again");
    if (r5.ok) { const a5 = applyAll(plan, "re-apply all again"); if (a5.ok) cmp("second cycle == first apply", fpTop, fingerprint(name)); }
    assertHealthy(name, since);
    writeFileSync(path.join(outDir, "fingerprint-top.txt"), fpTop.join("\n"));
    return finish(stages.some((s) => s.status === "FAIL") ? "FAIL" : stages.some((s) => s.status === "BLOCKED") ? "BLOCKED" : "PASS");
  } catch (e) {
    rec("infrastructure", "INFRA", { error: e.message });
    return finish("INFRA");
  } finally {
    removeAll(name);
  }
  function finish(verdict) { return { verdict, stages, fingerprintLines: null }; }
}

// ------------------------------------------------------------------------------------------------------------------------------------ host conditions
/** CPU % (1 s sample across all cores), free RAM and running container count: recorded per suite so a load-driven failure is never mistaken for a regression. */
async function hostSample() {
  const snap = () => os.cpus().reduce((a, c) => { const t = Object.values(c.times).reduce((x, y) => x + y, 0); return [a[0] + t, a[1] + c.times.idle]; }, [0, 0]);
  const [t0, i0] = snap();
  await sleep(1000);
  const [t1, i1] = snap();
  const cpu = t1 > t0 ? Math.round(100 * (1 - (i1 - i0) / (t1 - t0))) : null;
  const containers = dockerTry("ps", "-q").out.split("\n").filter(Boolean).length;
  return { cpuPct: cpu, freeRamGb: Number((os.freemem() / 2 ** 30).toFixed(1)), containers };
}
/** A host is "saturated" when CPU >= 85% or free RAM < 2 GB at either end of a suite: failures then count as resource exhaustion, not as regressions. */
const saturated = (h) => Boolean(h && ((h.cpuPct ?? 0) >= 85 || h.freeRamGb < 2));

// ------------------------------------------------------------------------------------------------------------------------------------ suites
const known = (() => { const f = flags.known ?? path.join(here, "known-failures.json"); return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : { known: [] }; })();

/** One JSON array: every public function/procedure with its volatility and the calls recorded by track_functions=all (0 when never called). */
const COVERAGE_SQL = `select coalesce(json_agg(json_build_object('name', p.proname, 'args', pg_get_function_identity_arguments(p.oid), 'vol', p.provolatile::text, 'kind', p.prokind::text, 'calls', coalesce(s.calls, 0), 'self_ms', coalesce(s.self_time, 0)) order by p.proname, p.oid), '[]'::json)
  from pg_proc p left join pg_stat_user_functions s on s.funcid = p.oid where p.pronamespace = 'public'::regnamespace and p.prokind in ('f', 'p');`;

function testWorktree(ref) {
  const sha = resolveRef(ref);
  if (sha === git("rev-parse", "HEAD") && !flags.noWorktree) { /* still use a detached copy: never run a slice's suites from a dirty tree */ }
  const dir = path.join(QA_HOME, "wt", sha.slice(0, 12));
  if (!existsSync(path.join(dir, ".git"))) {
    mkdirSync(path.dirname(dir), { recursive: true });
    rmSync(dir, { recursive: true, force: true });
    git("worktree", "add", "--detach", dir, sha);
  }
  const nm = path.join(dir, "node_modules");
  if (!existsSync(nm)) symlinkSync(path.join(REPO, "node_modules"), nm, "junction");
  if (!existsSync(path.join(nm, "vitest", "vitest.mjs"))) die(`vitest missing at ${nm} (copy node_modules into ${REPO} first)`);
  return { dir, sha };
}
/** Removes the junction first (rmdir only unlinks it), then the worktree: never recursive through the link. */
function dropWorktree(ref) {
  const sha = resolveRef(ref);
  const dir = path.join(QA_HOME, "wt", sha.slice(0, 12));
  try { rmdirSync(path.join(dir, "node_modules")); } catch { /* absent */ }
  try { git("worktree", "remove", "--force", dir); } catch { /* absent */ }
}

async function suiteRun(plan, image, testsRef, outDir) {
  const tests = testWorktree(testsRef);
  const grep = git("grep", "-l", "TW4A_LOCAL_URL", tests.sha, "--", "src");
  let files = [...new Set(grep.split("\n").filter(Boolean).map((l) => l.replace(/^[0-9a-f]{40}:/, "")))].filter((f) => /\.test\.ts$/.test(f)).sort();
  // suites that do not carry the TW4A_LOCAL_URL gate (tw4rfl, tw4rflops use TW4RFL_DB) are only reachable by name
  if (flags.suite.length) files = [...new Set([...files, ...git("ls-tree", "-r", "--name-only", tests.sha, "--", "src").split("\n").filter((p) => /localStack\.[^/]*\.test\.ts$/.test(p))])].sort();
  if (flags.suite.length) files = files.filter((f) => flags.suite.some((s) => f.endsWith(s) || f.includes(s)));
  if (!files.length) return { verdict: "BLOCKED", results: [], note: "no localStack suites found" };

  // one database with the whole plan applied, stopped and committed: every suite starts from a pristine clone of it
  const seed = `df-q1-seed-${process.pid}`;
  const chainTag = `df-q1/chain:${sha256(image + plan.map((p) => p.file + sha256(p.sql)).join("|") + (flags.marker ? "|marker" : "")).slice(0, 12)}`;
  const results = [];
  try {
    if (!dockerTry("image", "inspect", chainTag).ok) {
      await startDb(seed, image);
      if (flags.marker) { const r0 = psql(seed, "alter table auth.users add column if not exists email_confirmed_at timestamptz, add column if not exists banned_until timestamptz, add column if not exists deleted_at timestamptz; do $q$ begin if to_regclass('public.outbound_deliveries') is not null then grant update, delete on public.outbound_deliveries to authenticated; end if; end $q$;", { user: "supabase_admin" }); if (r0.code !== 0) return { verdict: "INFRA", results, note: `auth columns: ${r0.out.slice(0, 200)}` }; }
      if (flags.marker) { const r = psql(seed, "create table if not exists public.tw4_local_qa_only (note text); revoke all on public.tw4_local_qa_only from public, anon, authenticated, service_role;"); if (r.code !== 0) return { verdict: "INFRA", results, note: `marker: ${r.out.slice(0, 200)}` }; }
      for (const m of plan) { const r = applySql(seed, m.file, m.sql); if (!r.ok) return { verdict: "INFRA", results, note: `${m.file}: ${r.error}` }; }
      const ident = psql(seed, `select set_config('request.jwt.claims', '{"sub":"11111111-2222-4333-8444-555555555555","role":"authenticated"}', false) is not null and auth.uid() = '11111111-2222-4333-8444-555555555555'::uuid;`, { tuples: true });
      if (ident.out.trim().split("\n").pop() !== "t") return { verdict: "INFRA", results, note: "auth.uid() identity round trip failed" };
      docker("stop", "-t", "60", seed);
      docker("commit", "--change", "LABEL df.tw4fq1=1", seed, chainTag);
      docker("rm", "-f", seed);
    }
    for (const [i, f] of files.entries()) {
      const base = `df-q1-s${i}-${process.pid}`;
      const t0 = Date.now();
      const rec = { suite: f, status: "BLOCKED", seconds: 0, counts: null, failedTests: [], note: "", host: { start: await hostSample(), end: null } };
      const runDir = path.join(outDir, `suite-${i}-${path.basename(f, ".test.ts")}`);
      mkdirSync(path.join(runDir, "tmp"), { recursive: true });
      try {
        const since = await startDb(base, chainTag, flags.trackFunctions ? ["-c", "track_functions=all"] : []);
        const api = await startApi(base, base);
        const jsonOut = path.join(runDir, "vitest.json");
        const args = [path.join(tests.dir, "node_modules", "vitest", "vitest.mjs"), "run", "--no-file-parallelism", "--reporter=default", "--reporter=json", `--outputFile.json=${jsonOut}`, "--testTimeout=60000", "--hookTimeout=120000", f];
        const tmp = path.join(runDir, "tmp");
        const r = spawnSync(process.execPath, args, { cwd: tests.dir, env: { ...process.env, ...Object.fromEntries(Object.entries(flags.env).map(([k, v]) => [k, v.replaceAll("{db}", base)])), ...api.env, TMP: tmp, TEMP: tmp, TMPDIR: tmp }, encoding: "utf8", maxBuffer: 1 << 28, timeout: 30 * 60_000, killSignal: "SIGKILL" });
        const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
        writeFileSync(path.join(runDir, "vitest.log"), out);
        writeFileSync(path.join(runDir, "postgres.log"), dockerLogs(base));
        if (flags.trackFunctions) {
          await sleep(2500); // let backends flush pending function stats
          const cv = psql(base, COVERAGE_SQL, { tuples: true });
          writeFileSync(path.join(runDir, "coverage.json"), cv.code === 0 ? cv.out : JSON.stringify({ error: cv.out.slice(0, 300) }));
        }
        let unhealthy = null;
        try { assertHealthy(base, since); } catch (e) { unhealthy = e.message; }
        if (r.error || r.status === null) unhealthy = `${unhealthy ? unhealthy + "; " : ""}test process did not exit normally (${r.error?.code ?? r.signal})`;
        for (const c of Object.values(api.names)) { const st = dbState(c); if (!st.running || st.oom || st.restarts > 0) unhealthy = `${unhealthy ? unhealthy + "; " : ""}${c} unhealthy`; }
        let counts = { passed: 0, failed: 0, skipped: 0, todo: 0, total: 0 };
        let failed = [];
        try {
          const j = JSON.parse(readFileSync(jsonOut, "utf8"));
          counts = { passed: j.numPassedTests, failed: j.numFailedTests, skipped: j.numPendingTests, todo: j.numTodoTests, total: j.numTotalTests };
          failed = (j.testResults ?? []).flatMap((x) => (x.assertionResults ?? []).filter((a) => a.status === "failed").map((a) => a.fullName ?? a.title));
          if ((j.testResults ?? []).some((x) => x.status === "failed" && !(x.assertionResults ?? []).length)) failed.push("(suite failed to load or its setup threw)");
        } catch { /* no json */ }
        rec.counts = counts; rec.failedTests = failed;
        if (unhealthy) { rec.status = "INFRA"; rec.note = unhealthy; }
        else if (counts.total === 0) { rec.status = "BLOCKED"; rec.note = "nothing ran"; }
        else if (r.status === 0 && (counts.skipped > 0 || counts.todo > 0 || counts.passed === 0)) { rec.status = "BLOCKED"; rec.note = `${counts.skipped} skipped / ${counts.todo} todo`; }
        else if (r.status === 0) rec.status = "PASS";
        else {
          const k = known.known.find((e) => f.endsWith(e.suite) && failed.length && failed.every((t) => e.failing.some((p) => t.includes(p))));
          rec.status = k ? "KNOWN" : "FAIL";
          if (k) rec.note = k.reason;
        }
      } catch (e) {
        rec.status = e.infra ? "INFRA" : "BLOCKED"; rec.note = e.message;
      } finally {
        rec.seconds = Math.round((Date.now() - t0) / 1000);
        rec.host.end = await hostSample();
        rec.hostSaturated = saturated(rec.host.start) || saturated(rec.host.end);
        if (rec.hostSaturated && ["FAIL", "INFRA"].includes(rec.status)) rec.note = `${rec.note} [resource exhaustion suspected: host saturated during this suite; rerun on an idle host before treating as a regression]`.trim();
        removeAll(`${base}-kong`, `${base}-rest`, `${base}-auth`, base);
      }
      results.push(rec);
      log(`${rec.status.padEnd(7)} ${f} ${rec.counts ? `${rec.counts.passed}/${rec.counts.total}` : ""} ${rec.seconds}s ${rec.note ? "- " + rec.note.slice(0, 100) : ""}`);
    }
  } finally {
    removeAll(seed);
    if (!flags.keep) { dockerTry("rmi", chainTag); }
  }
  const bad = results.filter((r) => r.status !== "PASS");
  const verdict = results.some((r) => r.status === "INFRA") ? "INFRA" : results.some((r) => r.status === "BLOCKED") ? "BLOCKED" : results.some((r) => r.status === "FAIL") ? "FAIL" : bad.length ? "KNOWN" : "PASS";
  return { verdict, results, testsSha: tests.sha };
}

// ------------------------------------------------------------------------------------------------------------------------------------ main
async function main() {
  if (cmd === "down") {
    const all = dockerTry("ps", "-a", "--filter", `label=${LABEL}`, "--format", "{{.Names}}").out.split("\n").filter(Boolean);
    for (const c of all) if (ours(c)) docker("rm", "-f", c);
    log(`removed ${all.length} container(s)`);
    return 0;
  }
  if (cmd === "baseline") return baseline();
  const image = flags.image ?? PG_IMAGE_DEFAULT;
  if (!dockerTry("image", "inspect", image).ok) die(`baseline image ${image} not found: build it with \`node scripts/qa/iso-qa.mjs baseline\` (PR #266)`, 3);
  const plan = buildPlan();
  const testsRef = flags.testsRef ?? (flags.extraBranch.length ? flags.extraBranch[flags.extraBranch.length - 1] : baseRef);
  const label = flags.label ?? (flags.extraBranch.length || flags.extra.length ? "slice" : "main");
  const outDir = flags.out ?? path.join(QA_HOME, "runs", `${new Date().toISOString().replace(/[:.]/g, "-")}-${label}`);
  mkdirSync(outDir, { recursive: true });
  const meta = {
    label, base: { ref: baseRef, sha: resolveRef(baseRef) }, testsRef: { ref: testsRef, sha: resolveRef(testsRef) },
    image, imageId: docker("image", "inspect", image, "--format", "{{.Id}}"), pgImage: image,
    plan: plan.map((p) => ({ file: p.file, origin: p.origin, ref: p.ref, sha256: sha256(p.sql).slice(0, 12), hasRollback: Boolean(p.rollbackSql), crlf: p.sql.includes("\r") })),
    order: flags.order ?? "numeric", startedAt: new Date().toISOString(), node: process.version,
  };
  log(`plan: ${plan.map((p) => p.file.slice(0, 14)).join(" ")}`);
  const report = { meta };
  let code = 0;
  if (cmd === "chain" || cmd === "all") {
    const t0 = Date.now();
    report.chain = await chainCheck(plan, image, outDir);
    report.chain.seconds = Math.round((Date.now() - t0) / 1000);
    code = Math.max(code, { PASS: 0, FAIL: 1, BLOCKED: 4, INFRA: 3 }[report.chain.verdict] ?? 1);
  }
  if (cmd === "suites" || cmd === "all") {
    const t0 = Date.now();
    report.suites = await suiteRun(plan, image, testsRef, outDir);
    report.suites.seconds = Math.round((Date.now() - t0) / 1000);
    const c = { PASS: 0, FAIL: 1, BLOCKED: 4, INFRA: 3, KNOWN: 6 }[report.suites.verdict] ?? 1;
    code = code === 0 ? c : code === 6 ? Math.max(c, 6) : code;
    if (!flags.keep && testsRef !== baseRef) dropWorktree(testsRef);
  }
  report.finishedAt = new Date().toISOString();
  writeFileSync(path.join(outDir, "report.json"), JSON.stringify(report, (k, v) => (k === "sql" || k === "rollbackSql" ? undefined : v), 2));
  writeFileSync(path.join(outDir, "report.md"), markdown(report));
  console.log(markdown(report));
  log(`evidence: ${outDir}  exit=${code}`);
  return code;
}

/** WP-D0: apply the plan once on a fresh database and record both fingerprints (the hosted probe_fingerprint.sql method, and this runner's FP_SQL). */
async function baseline() {
  const image = flags.image ?? PG_IMAGE_DEFAULT;
  if (!dockerTry("image", "inspect", image).ok) die(`baseline image ${image} not found`, 3);
  const plan = buildPlan();
  const outDir = flags.out ?? path.join(QA_HOME, "runs", `${new Date().toISOString().replace(/[:.]/g, "-")}-${flags.label ?? "baseline"}`);
  mkdirSync(outDir, { recursive: true });
  const name = `df-q1-base-${process.pid}`;
  log(`baseline plan (${plan.length}): ${plan.map((p) => p.file.slice(0, 14)).join(" ")}`);
  try {
    await startDb(name, image);
    for (const m of plan) { const r = applySql(name, m.file, m.sql); if (!r.ok) { log(`FAIL ${m.file}: ${r.error}`); return 3; } }
    const probe = readFileSync(path.join(REPO, "scripts", "hosted", "tw4f", "probe_fingerprint.sql"), "utf8");
    const pr = psql(name, `begin read only;\n${probe}\nrollback;`, { tuples: true });
    writeFileSync(path.join(outDir, "probe_fingerprint.txt"), pr.out);
    const fp = fingerprint(name);
    writeFileSync(path.join(outDir, "fp_sql.txt"), fp.join("\n"));
    const all = pr.out.split("\n").find((l) => l.startsWith("rollup:ALL"));
    const count = psql(name, "select count(*) filter (where provolatile = 'v'), count(*) from pg_proc where pronamespace = 'public'::regnamespace and prokind in ('f','p');", { tuples: true }).out.trim();
    console.log(JSON.stringify({ plan: plan.map((p) => p.file.slice(0, 14)), applied: plan.length, probeRollupAll: all, fpSqlRows: fp.length, fpSqlMd5: createHash("md5").update(fp.join("\n")).digest("hex").slice(0, 8), publicFnVolatileAndTotal: count, outDir }, null, 2));
    return 0;
  } finally { removeAll(name); }
}

function markdown(r) {
  const L = [];
  L.push(`### TW-4F Q1 run: ${r.meta.label}`);
  L.push(`- base ${r.meta.base.ref} @ ${r.meta.base.sha.slice(0, 8)}; tests ${r.meta.testsRef.ref} @ ${r.meta.testsRef.sha.slice(0, 8)}; image ${r.meta.image} (${r.meta.imageId.slice(7, 19)}); order ${r.meta.order}`);
  L.push(`- applied: ${r.meta.plan.map((p) => `${p.file.slice(0, 14)}${p.origin === "extra" ? "*" : ""}`).join(" ")} (* = extra)`);
  if (r.chain) {
    L.push(`\n**Chain (apply / rollback / re-apply)**: ${r.chain.verdict} in ${r.chain.seconds}s`);
    L.push("| Stage | Result | Note |\n|---|---|---|");
    for (const s of r.chain.stages) L.push(`| ${s.stage} | ${s.status} | ${(s.note ?? s.error ?? (s.counts ? `diff before/after: ${s.counts.join("/")}` : "")).toString().replace(/\|/g, "/").replace(/\n/g, " ").slice(0, 160)} |`);
    for (const s of r.chain.stages.filter((x) => x.status === "FAIL" && (x.onlyBefore?.length || x.onlyAfter?.length))) {
      L.push(`\n<details><summary>${s.stage}: catalog differences</summary>\n\nonly before:\n${s.onlyBefore.map((x) => "- `" + x.slice(0, 200) + "`").join("\n") || "- none"}\n\nonly after:\n${s.onlyAfter.map((x) => "- `" + x.slice(0, 200) + "`").join("\n") || "- none"}\n</details>`);
    }
  }
  if (r.suites) {
    L.push(`\n**Suites (each on a fresh clone of the applied chain)**: ${r.suites.verdict} in ${r.suites.seconds}s`);
    L.push("| Suite | Result | Tests | Seconds | Host start -> end (CPU %/free GB/containers) | Note |\n|---|---|---|---|---|---|");
    for (const s of r.suites.results) L.push(`| ${s.suite.replace("src/lib/", "")} | ${s.status} | ${s.counts ? `${s.counts.passed}/${s.counts.total}${s.counts.skipped ? ` (+${s.counts.skipped} skipped)` : ""}` : "-"} | ${s.seconds} | ${[s.host?.start, s.host?.end].map((h) => (h ? `${h.cpuPct}%/${h.freeRamGb}/${h.containers}` : "-")).join(" -> ")}${s.hostSaturated ? " SATURATED" : ""} | ${(s.note + (s.failedTests.length ? ` failing: ${s.failedTests.slice(0, 4).join("; ")}` : "")).replace(/\|/g, "/").slice(0, 300)} |`);
  }
  return L.join("\n");
}

main().then((c) => process.exit(c), (e) => { console.error(e); process.exit(e.infra ? 3 : 1); });
