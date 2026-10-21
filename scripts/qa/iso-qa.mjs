#!/usr/bin/env node
/**
 * TW-4F isolated QA harness (local developer / release-gate tool). Runs the SQL / local-stack regression suites against a DISPOSABLE Postgres + PostgREST + Kong
 * stack instead of the shared `supabase_*_danceflow-e2e-qa` stack, so a crash or leftover fixtures from one session can never contaminate another session's run.
 *
 *   baseline  [--cutoff 20261205090000] [--ref origin/main] [--base <schema.sql>]   build the local image df-isoqa/base:<cutoff> (July production schema + replayed migrations)
 *   up        <scenario> [--name n] [--migration ref:version]... [--cutoff c] [--no-api]   start a stack, apply the scenario's migrations in order, print the env
 *   run       <scenario> [--name n] [--keep] [--tests-ref ref] [--migration ...] -- <vitest args>   up, run vitest, classify, tear down
 *   matrix    <scenario> [--parallel 3] [--tests-ref ref] [--migration ...]          every local-stack suite (files carrying TW4A_LOCAL_URL), each in its OWN fresh database
 *   compare   <scenarioA> <scenarioB>                                                catalog fingerprint diff: does the migration order change the resulting schema?
 *   down      --name n | --all [--force]                                             remove stacks (--all only removes stacks whose owner process is gone, unless --force)
 *   selftest                                                                         negative controls: skipped suite, nothing ran, failing test, crashed database, bad / duplicate migration, concurrency
 *   repro                                                                            re-run the preserved minimal SQL case that segfaults image 17.6.1.106
 *   list | scenarios
 *
 * Isolation rules (enforced here): every container carries the labels df.isoqa=1 and df.isoqa.owner=<pid> and the prefix df-isoqa-; they live on their own docker
 * network and the only published port is Kong's, on 127.0.0.1:56600-56799 (asserted after every start). A stack is never replaced or removed while its owner process
 * is alive. Migrations come from git refs, never from a working tree; other commits' suites run from a private detached worktree under QA_HOME.
 *
 * Exit codes of run / matrix: 0 every test passed (none skipped); 1 tests failed with a healthy database; 3 INFRASTRUCTURE failure (database crashed / restarted /
 * was OOM-killed / never ready, a migration failed, the stack could not start: never an application result); 4 a suite was SKIPPED, ran nothing, or the matrix was
 * incomplete (never a pass); 6 (matrix only) every failure is a KNOWN, explained pre-existing one from expected-results.json (not green); 2 usage error. compare: 0 identical, 1 different, 3 incomplete / infrastructure.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const here = path.dirname(SELF);
const REPO = path.resolve(here, "..", "..");
const QA_HOME = process.env.ISO_QA_HOME ?? path.resolve(REPO, "..", "danceflow-iso-qa");
const NET = "df-isoqa-net";
const LABEL = "df.isoqa=1";
const PG_IMAGE = process.env.ISO_QA_PG_IMAGE ?? "public.ecr.aws/supabase/postgres:17.6.1.106";
const REST_IMAGE = process.env.ISO_QA_REST_IMAGE ?? "public.ecr.aws/supabase/postgrest:v14.8";
const KONG_IMAGE = process.env.ISO_QA_KONG_IMAGE ?? "public.ecr.aws/supabase/kong:2.8.1";
const DEFAULT_CUTOFF = "20261205090000";
const MIGRATIONS = "src/lib/supabase/migrations";
const LIMITS = {
  db: ["--memory", process.env.ISO_QA_DB_MEMORY ?? "1500m", "--cpus", process.env.ISO_QA_DB_CPUS ?? "1.5"],
  rest: ["--memory", process.env.ISO_QA_REST_MEMORY ?? "256m", "--cpus", "0.5"],
  kong: ["--memory", process.env.ISO_QA_KONG_MEMORY ?? "1280m", "--cpus", "1"],
};
/** The supautils extension of image 17.6.1.106 segfaults on any "permission denied for function" error for anon / authenticated / service_role (docs/twilio/TW-4F_Isolated_QA.md).
 *  Emptying its hint feature avoids it; the canary test pins that the stack survives. ISO_QA_UNMITIGATED=1 exists only so the self-test can prove the crash detector. */
const PG_ARGS = process.env.ISO_QA_UNMITIGATED === "1" ? ["postgres", "-D", "/etc/postgresql"] : ["postgres", "-D", "/etc/postgresql", "-c", "supautils.hint_roles="];

process.env.MSYS_NO_PATHCONV = "1"; // Git Bash must not rewrite /etc/... container paths

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 600_000, maxBuffer: 1 << 28, ...opts }).trim();
const docker = (...args) => sh("docker", args);
const dockerTry = (...args) => { try { return { ok: true, out: docker(...args) }; } catch (e) { return { ok: false, out: String(e.stderr ?? e.message) }; } };
/** The container's complete log. `docker logs` writes the container's stderr to its own stderr, so BOTH streams are read (stdout alone is empty for Postgres). */
const dockerLogs = (name) => {
  const r = spawnSync("docker", ["logs", name], { encoding: "utf8", maxBuffer: 1 << 28 });
  return `${r.stdout ?? ""}${r.stderr ?? ""}`;
};
const log = (...a) => console.error("[iso-qa]", ...a);
const die = (msg, code = 2) => { console.error(`[iso-qa] ${msg}`); process.exit(code); };
const git = (...args) => sh("git", ["-C", REPO, ...args]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const napSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const ERROR_RE = /(^|\n)(psql:[^\n]*?: )?(ERROR|FATAL|PANIC):/;
const WARNING_RE = /(^|\n)(psql:[^\n]*?: )?WARNING:/;

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// scenarios: explicit migration manifests resolved against git refs
// ---------------------------------------------------------------------------------------------------------------------------------------------------
const MANIFEST = JSON.parse(readFileSync(path.join(here, "scenarios.json"), "utf8"));
const refOf = (key) => process.env[`ISO_QA_REF_${key}`] ?? MANIFEST.refs[key] ?? die(`unknown ref key ${key}`);
const REF_MAIN = refOf("MAIN");
const SCENARIOS = Object.fromEntries(Object.entries(MANIFEST.scenarios).map(([k, v]) => [k, { description: v.description, migrations: v.migrations.map(([key, version]) => [refOf(key), version]) }]));
const resolveRef = (ref) => { try { return git("rev-parse", "--verify", `${ref}^{commit}`); } catch { throw new Error(`cannot resolve git ref ${ref}`); } };

function migrationFileAt(ref, version) {
  const names = git("ls-tree", "--name-only", `${ref}:${MIGRATIONS}`).split("\n").filter((n) => n.startsWith(`${version}`) && n.endsWith(".sql"));
  if (names.length !== 1) throw new Error(`expected exactly one migration ${version}* at ${ref}, found ${names.length}`);
  return names[0];
}
const migrationSql = (ref, file) => git("show", `${ref}:${MIGRATIONS}/${file}`);

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// docker helpers (label-fenced, owner-aware)
// ---------------------------------------------------------------------------------------------------------------------------------------------------
const ensureNetwork = () => { if (!dockerTry("network", "inspect", NET).ok) docker("network", "create", "--label", LABEL, NET); };
const labelOf = (name, key) => { const r = dockerTry("inspect", "--format", `{{ index .Config.Labels "${key}" }}`, name); return r.ok ? r.out : null; };
const ours = (name) => name.startsWith("df-isoqa-") && labelOf(name, "df.isoqa") === "1";
function assertOurs(name) { if (!ours(name)) die(`refusing to touch ${name}: not an isolated-QA container`); }
const pidAlive = (pid) => { try { process.kill(Number(pid), 0); return true; } catch (e) { return e.code === "EPERM"; } };
/** A stack whose owner process is alive and is not this one belongs to someone else's run. */
function assertNotForeignLive(name) {
  const owner = labelOf(name, "df.isoqa.owner");
  if (owner && Number(owner) !== process.pid && pidAlive(owner)) throw new Error(`${name} belongs to a live harness process (pid ${owner}); refusing to replace it (choose another --name)`);
}
const OWNER = () => ["--label", LABEL, "--label", `df.isoqa.owner=${process.pid}`];
const psqlIn = (container, sql, { user = "postgres", extra = [], single = false } = {}) => {
  assertOurs(container);
  const r = spawnSync("docker", ["exec", "-i", "-e", "PGPASSWORD=postgres", container, "psql", "-U", user, "-d", "postgres", "-q", "-v", "ON_ERROR_STOP=1", ...(single ? ["-1"] : []), ...extra], { input: sql, encoding: "utf8", maxBuffer: 1 << 28 });
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};
async function waitReady(container, timeoutMs = 600_000) {
  const t0 = Date.now();
  let ok = 0;
  while (Date.now() - t0 < timeoutMs) {
    const r = dockerTry("exec", container, "psql", "-U", "postgres", "-d", "postgres", "-At", "-c", "select 1");
    // the image restarts the server once after initialisation: require three consecutive successes a few seconds apart
    ok = r.ok ? ok + 1 : 0;
    if (ok >= 3) return;
    await sleep(r.ok ? 4000 : 3000);
  }
  throw new Error(`${container} did not become ready`);
}
/** Lines of the database log that mean a backend or the server died or the cluster restarted. */
const CRASH_RE = /terminated by signal|was terminated by|exited with exit code [1-9]|reinitializing|PANIC:|out of memory/i;
const crashLines = (container) => dockerLogs(container).split("\n").filter((l) => CRASH_RE.test(l));
const dbState = (container) => {
  const r = dockerTry("inspect", "--format", "{{.State.Running}}|{{.State.OOMKilled}}|{{.State.StartedAt}}|{{.RestartCount}}", container);
  if (!r.ok) return { running: false, oom: true, startedAt: "", restarts: -1 };
  const [running, oom, startedAt, restarts] = r.out.split("|");
  return { running: running === "true", oom: oom === "true", startedAt, restarts: Number(restarts) };
};
/** Throws when the database crashed, restarted, was OOM-killed or stopped since `since` (a dbState taken after start). */
function assertHealthy(container, since) {
  const lines = crashLines(container);
  const st = dbState(container);
  const problems = [];
  if (lines.length) problems.push(`${lines.length} crash/restart log line(s): ${lines[0].slice(0, 140)}`);
  if (!st.running) problems.push("the container is not running");
  if (st.oom) problems.push("the container was OOM-killed");
  if (since && (st.startedAt !== since.startedAt || st.restarts !== since.restarts)) problems.push("the container restarted");
  if (problems.length) throw Object.assign(new Error(`database unhealthy (${container}): ${problems.join("; ")}`), { infra: true });
}

// cross-process mutex (directory creation is atomic), synchronous and asynchronous
function lockPath(name) { mkdirSync(QA_HOME, { recursive: true }); return path.join(QA_HOME, `${name}.lock`); }
function tryLock(lock) {
  try { mkdirSync(lock); return true; } catch (e) {
    if (e.code !== "EEXIST") throw e;
    try {
      // only a lock whose recorded holder is dead (or that is very old) may be broken
      const holder = readFileSync(path.join(lock, "pid"), "utf8");
      if (!pidAlive(holder)) rmSync(lock, { recursive: true, force: true });
    } catch { try { if (Date.now() - statSync(lock).mtimeMs > 300_000) rmSync(lock, { recursive: true, force: true }); } catch { /* raced */ } }
    return false;
  }
}
const stamp = (lock) => writeFileSync(path.join(lock, "pid"), String(process.pid));
async function withLock(name, fn, waitMs = 300_000) {
  const lock = lockPath(name);
  const t0 = Date.now();
  while (!tryLock(lock)) { if (Date.now() - t0 > waitMs) throw new Error(`could not acquire the ${name} lock`); await sleep(300); }
  stamp(lock);
  try { return await fn(); } finally { rmSync(lock, { recursive: true, force: true }); }
}
function withLockSync(name, fn, waitMs = 60_000) {
  const lock = lockPath(name);
  const t0 = Date.now();
  while (!tryLock(lock)) { if (Date.now() - t0 > waitMs) throw new Error(`could not acquire the ${name} lock`); napSync(150); }
  stamp(lock);
  try { return fn(); } finally { rmSync(lock, { recursive: true, force: true }); }
}
const writeAtomic = (file, text) => { const tmp = `${file}.${process.pid}.tmp`; writeFileSync(tmp, text); renameSync(tmp, file); };

const CLAIMS = () => path.join(QA_HOME, "port-claims.json");
const readClaims = () => { try { return JSON.parse(readFileSync(CLAIMS(), "utf8")); } catch (e) { if (e.code === "ENOENT") return {}; throw new Error(`port-claims.json is unreadable: ${e.message}`); } };
const writeClaims = (c) => writeAtomic(CLAIMS(), JSON.stringify(c, null, 2));
const usedHostPorts = () => new Set((dockerTry("ps", "--filter", `label=${LABEL}`, "--format", "{{.Ports}}").out.match(/:(\d+)->/g) ?? []).map((m) => Number(m.slice(1, -2))));
const freePort = (start, taken) => new Promise((resolve, reject) => {
  const tryPort = (p) => {
    if (p > 56799) return reject(new Error("no free port in 56600-56799"));
    if (taken.has(p)) return tryPort(p + 1);
    const s = net.createServer();
    s.once("error", () => tryPort(p + 1));
    s.listen(p, "127.0.0.1", () => s.close(() => resolve(p)));
  };
  tryPort(start);
});
/** Chooses the API host port for an instance under the cross-process lock and records the claim (claims of dead processes and claims older than 30 minutes are ignored). */
const claimPort = (instance) => withLock("start", async () => {
  const now = Date.now();
  const claims = Object.fromEntries(Object.entries(readClaims()).filter(([, v]) => now - v.at < 30 * 60_000 && pidAlive(v.pid)));
  const taken = usedHostPorts();
  for (const v of Object.values(claims)) taken.add(v.port);
  const port = await freePort(56600, taken);
  claims[instance] = { port, at: now, pid: process.pid };
  writeClaims(claims);
  return port;
});
const releasePort = (instance) => { try { withLockSync("start", () => { const c = readClaims(); delete c[instance]; writeClaims(c); }); } catch (e) { log(`could not release the port claim of ${instance}: ${e.message}`); } };

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// baseline: the production schema dump of 2026-07-15 (schema only, local and git-ignored) + the repo's own migrations replayed from a git REF up to the cutoff
// ---------------------------------------------------------------------------------------------------------------------------------------------------
const KNOWN_UNREPLAYABLE = path.join(here, "known-unreplayable.txt");
const versionOf = (name) => name.replace(/^[0-9]{2}-/, "").slice(0, 14).replace(/[^0-9]/g, "").padEnd(8, "0");
const defaultBaseSchema = () => path.join(path.dirname(git("rev-parse", "--path-format=absolute", "--git-common-dir")), "backups", "danceflow-production-pre-accounting-v1-2026-07-15.sql");
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
// What the Supabase auth service (GoTrue) migrations provide on a real stack and the bare database image does not: auth.uid() / auth.role() / auth.email() / auth.jwt() that
// understand the claims JSON PostgREST sets (request.jwt.claims). Without them every user-JWT call reaches the database as an anonymous user and "refused" assertions pass for the
// wrong reason. Definitions are the ones in the shared QA stack's catalog.
const BOOTSTRAP_SQL = `
create or replace function auth.uid() returns uuid language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid
$$;
create or replace function auth.role() returns text language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'))::text
$$;
create or replace function auth.email() returns text language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.email', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email'))::text
$$;
create or replace function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim', true), ''), nullif(current_setting('request.jwt.claims', true), ''))::jsonb
$$;
grant execute on function auth.uid(), auth.role(), auth.email(), auth.jwt() to anon, authenticated, service_role;
`;
/** The identity round trip every stack must pass before any test runs (PostgREST sets the claims JSON; the database must resolve it). */
const IDENTITY_CHECK_SQL = `select set_config('request.jwt.claims', '{"sub":"11111111-2222-4333-8444-555555555555","role":"authenticated","email":"qa@example.test"}', false) is not null
  and auth.uid() = '11111111-2222-4333-8444-555555555555'::uuid and auth.role() = 'authenticated' and auth.email() = 'qa@example.test';`;
/** The known-unreplayable list: file, then the error it is expected to fail with. TW-4F migrations can never be listed. */
function loadKnown() {
  const entries = new Map();
  for (const line of readFileSync(KNOWN_UNREPLAYABLE, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"))) {
    const [file, ...reason] = line.split(/\s+/);
    if (versionOf(file) >= "20261116" || /sms|twilio|tw4/i.test(file)) throw new Error(`known-unreplayable.txt lists ${file}: TW-4F migrations may never be skipped`);
    entries.set(file, reason.join(" "));
  }
  return entries;
}
/** Files with only a date in their version (no time) have no intrinsic order: tie-break by the commit that added them, then by name. */
function replayOrder(ref, cutoff) {
  const names = git("ls-tree", "--name-only", `${ref}:${MIGRATIONS}`).split("\n").filter((n) => n.endsWith(".sql"));
  const addedAt = (n) => Number(git("log", ref, "--diff-filter=A", "--format=%ct", "--", `${MIGRATIONS}/${n}`).split("\n").filter(Boolean).pop() ?? 0);
  return names.map((n) => ({ n, v: versionOf(n).padEnd(14, "0"), dateOnly: !/^[0-9]{14}/.test(n.replace(/^[0-9]{2}-/, "")) }))
    .filter((x) => x.v >= "20260715000000" && x.v <= cutoff)
    .map((x) => ({ ...x, t: x.dateOnly ? addedAt(x.n) : 0 }))
    .sort((p, q) => (p.v !== q.v ? (p.v < q.v ? -1 : 1) : p.t !== q.t ? p.t - q.t : p.n < q.n ? -1 : 1));
}

async function cmdBaseline(flags) {
  const cutoff = flags.cutoff ?? DEFAULT_CUTOFF;
  const ref = flags.ref ?? REF_MAIN;
  const refSha = resolveRef(ref);
  const baseSchema = flags.base ?? process.env.ISO_QA_BASE_SCHEMA ?? defaultBaseSchema();
  if (!existsSync(baseSchema)) die(`base schema dump not found: ${baseSchema} (set ISO_QA_BASE_SCHEMA)`);
  const dump = readFileSync(baseSchema, "utf8");
  const known = loadKnown();
  const files = replayOrder(ref, cutoff);
  const builder = `df-isoqa-baseline-builder-${process.pid}`;
  log(`building the baseline: ${path.basename(baseSchema)} + ${files.length} migrations from ${ref} (${refSha.slice(0, 12)}) through ${cutoff} ...`);
  ensureNetwork();
  try {
    docker("run", "-d", "--name", builder, ...OWNER(), "--network", NET, ...LIMITS.db, "-e", "POSTGRES_PASSWORD=postgres", PG_IMAGE, ...PG_ARGS);
    await waitReady(builder);
    let r = psqlIn(builder, BOOTSTRAP_SQL, { user: "supabase_admin" });
    if (r.code !== 0) throw new Error(`bootstrap failed: ${r.out.slice(0, 400)}`);
    if (psqlIn(builder, IDENTITY_CHECK_SQL, { extra: ["-At"] }).out.trim().split("\n").pop() !== "t") throw new Error("bootstrap identity check failed");
    r = psqlIn(builder, dump);
    if (r.code !== 0 || ERROR_RE.test(r.out)) throw new Error(`base schema load failed:\n${r.out.split("\n").filter((l) => /ERROR/.test(l)).slice(0, 8).join("\n")}`);
    const failed = new Map();
    const problems = [];
    let applied = 0;
    for (const { n } of files) {
      // all or nothing: a migration that fails leaves NOTHING behind
      const sql = git("show", `${ref}:${MIGRATIONS}/${n}`);
      const res = psqlIn(builder, sql, { single: !/\bconcurrently\b/i.test(sql) });
      if (res.code !== 0 || ERROR_RE.test(res.out)) {
        const firstError = (res.out.split("\n").find((l) => /ERROR|FATAL/.test(l)) ?? res.out).replace(/^.*?(ERROR|FATAL):\s*/, "");
        failed.set(n, firstError);
        if (!known.has(n)) problems.push(`migration ${n} failed and is not in known-unreplayable.txt: ${firstError.slice(0, 300)}`);
        else if (!firstError.includes(known.get(n).slice(0, 30))) problems.push(`migration ${n} failed with a DIFFERENT error than recorded:\n    recorded: ${known.get(n)}\n    actual:   ${firstError.slice(0, 300)}`);
      } else applied += 1;
    }
    for (const k of known.keys()) if (!failed.has(k)) problems.push(`known-unreplayable.txt lists ${k}, which now replays cleanly (remove it)`);
    // every discrepancy is reported at once, then the build is refused: the image is only committed from a baseline that matches the list exactly
    if (problems.length) throw new Error(`the baseline does not match known-unreplayable.txt:\n  - ${problems.join("\n  - ")}`);
    const tag = `df-isoqa/base:${cutoff}`;
    docker("stop", "-t", "120", builder);
    docker("commit", "--change", 'ENTRYPOINT ["docker-entrypoint.sh"]', "--change", 'CMD ["postgres","-D","/etc/postgresql"]',
      "--change", `LABEL df.isoqa.ref=${ref}@${refSha.slice(0, 12)}`, "--change", `LABEL df.isoqa.cutoff=${cutoff}`, "--change", `LABEL df.isoqa.dump=${sha256(dump).slice(0, 16)}`,
      "--change", `LABEL df.isoqa.known=${sha256(readFileSync(KNOWN_UNREPLAYABLE, "utf8")).slice(0, 16)}`, builder, tag);
    const labels = docker("image", "inspect", tag, "--format", "{{json .Config.Labels}}");
    if (/desktop\.docker\.io\/ports\/[0-9]/.test(labels)) throw new Error(`the baseline image carries Docker Desktop port labels (${labels.slice(0, 200)}): it would publish a host port for every stack`);
    log(`baseline image ${tag} built: ${applied} migrations applied, ${failed.size} known-unreplayable skipped (${ref}@${refSha.slice(0, 12)})`);
  } finally {
    dockerTry("rm", "-f", builder);
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// up / down / run
// ---------------------------------------------------------------------------------------------------------------------------------------------------
const names = (instance) => ({ db: `df-isoqa-${instance}-db`, rest: `df-isoqa-${instance}-rest`, kong: `df-isoqa-${instance}-kong` });
const kongYml = (rest) => `_format_version: "2.1"
services:
  - name: rest-v1
    url: http://${rest}:3000/
    routes:
      - name: rest-v1
        strip_path: true
        paths: ["/rest/v1/"]
`;
function parseMigration(m) { const i = m.indexOf(":"); return [m.slice(0, i), m.slice(i + 1)]; }
function baselineIdentity(image) {
  const labels = JSON.parse(docker("image", "inspect", image, "--format", "{{json .Config.Labels}}"));
  return { id: docker("image", "inspect", image, "--format", "{{.Id}}"), ref: labels["df.isoqa.ref"], dump: labels["df.isoqa.dump"], known: labels["df.isoqa.known"] };
}

async function cmdUp(scenarioName, flags, instance) {
  const noApi = Boolean(flags["no-api"]);
  const preset = SCENARIOS[scenarioName];
  if (!preset) throw Object.assign(new Error(`unknown scenario ${scenarioName}`), { usage: true });
  const list = [...preset.migrations, ...(flags.migration ?? []).map(parseMigration)];
  const cutoff = flags.cutoff ?? DEFAULT_CUTOFF;
  const image = `df-isoqa/base:${cutoff}`;
  if (!dockerTry("image", "inspect", image).ok) throw new Error(`baseline image ${image} not found: run \`baseline\` first`);
  const identity = baselineIdentity(image);
  // the baseline must come from the dump and the known list that are on disk now
  const dumpFile = process.env.ISO_QA_BASE_SCHEMA ?? defaultBaseSchema();
  if (existsSync(dumpFile) && identity.dump !== sha256(readFileSync(dumpFile, "utf8")).slice(0, 16)) throw new Error("the baseline image was built from a different base schema dump: rebuild it (`baseline`)");
  if (identity.known !== sha256(readFileSync(KNOWN_UNREPLAYABLE, "utf8")).slice(0, 16)) throw new Error("the baseline image was built with a different known-unreplayable.txt: rebuild it (`baseline`)");
  const n = names(instance);
  for (const c of [n.kong, n.rest, n.db]) if (dockerTry("inspect", c).ok) { assertOurs(c); assertNotForeignLive(c); }
  const jwt = randomBytes(24).toString("hex");
  ensureNetwork();
  const ymlPath = path.join(QA_HOME, `kong-${instance}.yml`);
  mkdirSync(QA_HOME, { recursive: true });
  writeFileSync(ymlPath, kongYml(n.rest));
  const apiPort = noApi ? 0 : await claimPort(instance);
  for (const c of [n.kong, n.rest, n.db]) if (dockerTry("inspect", c).ok) docker("rm", "-f", c);
  docker("run", "-d", "--name", n.db, ...OWNER(), "--network", NET, ...LIMITS.db, "-e", "POSTGRES_PASSWORD=postgres", image, ...PG_ARGS);
  await waitReady(n.db);
  const since = dbState(n.db);
  const applied = [];
  for (const [ref, version] of list) {
    const file = migrationFileAt(ref, version);
    log(`applying ${file} (from ${ref})`);
    const r = psqlIn(n.db, migrationSql(ref, file));
    if (r.code !== 0 || ERROR_RE.test(r.out)) throw new Error(`migration ${file} failed:\n${r.out.slice(0, 800)}`);
    if (WARNING_RE.test(r.out)) log(`  warnings from ${file}: ${r.out.split("\n").filter((l) => /WARNING:/.test(l)).slice(0, 3).join(" | ")}`);
    applied.push({ file, ref, sha: resolveRef(ref).slice(0, 12) });
  }
  const ident = psqlIn(n.db, IDENTITY_CHECK_SQL, { extra: ["-At"] }).out.trim().split("\n").pop();
  if (ident !== "t") throw new Error("identity round trip failed: auth.uid() / auth.role() do not resolve request.jwt.claims (every user-JWT test would run as anonymous)");
  assertHealthy(n.db, since);
  const meta = { scenario: scenarioName, instance, cutoff, baseline: identity, migrations: applied, since };
  if (noApi) {
    const got = docker("inspect", n.db, "--format", "{{json .HostConfig.PortBindings}}");
    if (got !== "{}") throw new Error(`unexpected host port bindings on ${n.db}: ${got}`);
    return { env: { TW4A_LOCAL_DB_CONTAINER: n.db, ISO_QA_SCENARIO: scenarioName, ISO_QA_INSTANCE: instance }, meta };
  }
  const pw = psqlIn(n.db, "alter role authenticator with password 'postgres';", { user: "supabase_admin" });
  if (pw.code !== 0) throw new Error(`could not set the API role password: ${pw.out.slice(0, 300)}`);
  docker("run", "-d", "--name", n.rest, ...OWNER(), "--network", NET, ...LIMITS.rest,
    "-e", `PGRST_DB_URI=postgres://authenticator:postgres@${n.db}:5432/postgres`, "-e", "PGRST_DB_SCHEMAS=public", "-e", "PGRST_DB_ANON_ROLE=anon",
    "-e", `PGRST_JWT_SECRET=${jwt}`, "-e", "PGRST_DB_USE_LEGACY_GUCS=false", REST_IMAGE);
  docker("create", "--name", n.kong, ...OWNER(), "--network", NET, ...LIMITS.kong, "-p", `127.0.0.1:${apiPort}:8000`,
    "-e", "KONG_DATABASE=off", "-e", "KONG_NGINX_WORKER_PROCESSES=1", "-e", "KONG_DECLARATIVE_CONFIG=/home/kong/kong.yml", "-e", "KONG_PROXY_LISTEN=0.0.0.0:8000", "-e", "KONG_DNS_ORDER=LAST,A,CNAME", KONG_IMAGE);
  docker("cp", ymlPath, `${n.kong}:/home/kong/kong.yml`);
  docker("start", n.kong);
  for (const [c, want] of [[n.db, "{}"], [n.rest, "{}"], [n.kong, `{"8000/tcp":[{"HostIp":"127.0.0.1","HostPort":"${apiPort}"}]}`]]) {
    const got = docker("inspect", c, "--format", "{{json .HostConfig.PortBindings}}");
    if (got !== want) throw new Error(`unexpected host port bindings on ${c}: ${got} (expected ${want})`);
  }
  const env = { TW4A_LOCAL_URL: `http://127.0.0.1:${apiPort}`, TW4A_LOCAL_DB_CONTAINER: n.db, TW4A_LOCAL_JWT_SECRET: jwt, TW4_ISO_QA: "1", ISO_QA_SCENARIO: scenarioName, ISO_QA_INSTANCE: instance };
  const t0 = Date.now();
  for (;;) {
    try { const res = await fetch(`${env.TW4A_LOCAL_URL}/rest/v1/`, { headers: { apikey: "x" }, signal: AbortSignal.timeout(8000) }); if (res.status < 500) break; } catch { /* not yet */ }
    if (Date.now() - t0 > 240_000) throw new Error("the API did not come up");
    await sleep(1500);
  }
  assertHealthy(n.db, since);
  return { env, meta };
}

function cmdDown(instance, { force = false } = {}) {
  releasePort(instance);
  const n = names(instance);
  for (const c of [n.kong, n.rest, n.db]) {
    if (!dockerTry("inspect", c).ok) continue;
    assertOurs(c);
    if (!force) assertNotForeignLive(c);
    docker("rm", "-f", c);
  }
}
function cmdDownAll(force) {
  const all = dockerTry("ps", "-a", "--filter", `label=${LABEL}`, "--format", "{{.Names}}").out.split("\n").filter(Boolean);
  let removed = 0;
  for (const c of all) {
    if (!ours(c)) continue;
    const owner = labelOf(c, "df.isoqa.owner");
    if (!force && owner && Number(owner) !== process.pid && pidAlive(owner)) { log(`keeping ${c}: its owner (pid ${owner}) is alive (use --force)`); continue; }
    docker("rm", "-f", c);
    removed += 1;
  }
  withLockSync("start", () => { const claims = readClaims(); for (const [k, v] of Object.entries(claims)) if (!pidAlive(v.pid)) delete claims[k]; writeClaims(claims); });
  log(`removed ${removed} container(s)`);
}

/** A private detached worktree (under QA_HOME) of a ref, so another commit's own suites run without touching any session's worktree. Created under a lock, with a verified node_modules link. */
function testWorktree(ref) {
  const sha = resolveRef(ref);
  const dir = path.join(QA_HOME, "wt", sha.slice(0, 12));
  withLockSync("worktree", () => {
    if (!existsSync(path.join(dir, ".git"))) {
      mkdirSync(path.dirname(dir), { recursive: true });
      rmSync(dir, { recursive: true, force: true });
      git("worktree", "add", "--detach", dir, sha);
    }
    if (!existsSync(path.join(dir, "node_modules"))) symlinkSync(path.join(REPO, "node_modules"), path.join(dir, "node_modules"), "junction");
  }, 300_000);
  if (!existsSync(path.join(dir, "node_modules", "vitest", "vitest.mjs"))) throw new Error(`no vitest in ${dir}/node_modules (the link to ${REPO}/node_modules failed)`);
  return { dir, sha };
}

async function cmdRun(scenarioName, flags, vitestArgs, instance) {
  const cleanup = () => { try { cmdDown(instance, { force: true }); } catch { /* best effort */ } };
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { cleanup(); process.exit(130); });
  const t0 = Date.now();
  let up;
  let exit = 3;
  const finish = (code) => { if (!flags.keep) cleanup(); process.exit(code); };
  try {
    up = await cmdUp(scenarioName, flags, instance);
  } catch (e) {
    if (e.usage) die(e.message, 2);
    log(`INFRASTRUCTURE FAILURE while starting: ${e.message}`);
    cleanup();
    process.exit(3);
  }
  const runDir = path.join(QA_HOME, "runs", `${new Date().toISOString().replace(/[:.]/g, "-")}-${instance}`);
  try {
    mkdirSync(runDir, { recursive: true });
    const tests = flags["tests-ref"] ? testWorktree(flags["tests-ref"]) : { dir: REPO, sha: git("rev-parse", "HEAD") };
    const vitestBin = path.join(tests.dir, "node_modules", "vitest", "vitest.mjs");
    if (!existsSync(vitestBin)) throw new Error(`vitest not found at ${vitestBin}`);
    const jsonOut = path.join(runDir, "vitest.json");
    const args = [vitestBin, "run", "--no-file-parallelism", "--reporter=default", "--reporter=json", `--outputFile.json=${jsonOut}`, ...vitestArgs];
    const r = spawnSync(process.execPath, args, { cwd: tests.dir, env: { ...process.env, ...up.env }, encoding: "utf8", maxBuffer: 1 << 28 });
    const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
    writeFileSync(path.join(runDir, "vitest.log"), out);
    const dbName = names(instance).db;
    writeFileSync(path.join(runDir, "postgres.log"), dockerLogs(dbName));
    let unhealthy = null;
    try { assertHealthy(dbName, up.meta.since); } catch (e) { unhealthy = e.message; }
    let counts = { passed: 0, failed: 0, skipped: 0, todo: 0, total: 0 };
    let failedTests = [];
    try {
      const j = JSON.parse(readFileSync(jsonOut, "utf8"));
      counts = { passed: j.numPassedTests, failed: j.numFailedTests, skipped: j.numPendingTests, todo: j.numTodoTests, total: j.numTotalTests };
      failedTests = (j.testResults ?? []).flatMap((f) => (f.assertionResults ?? []).filter((a) => a.status === "failed").map((a) => a.fullName ?? a.title));
      if (counts.failed > 0 && failedTests.length === 0) failedTests = ["(unnamed failure)"];
      if ((j.testResults ?? []).some((f) => f.status === "failed" && (f.assertionResults ?? []).length === 0)) failedTests.push("(a suite failed to load or its setup threw)");
    } catch { /* no JSON: handled below */ }
    const summary = (out.match(/Tests\s+.*$/m) ?? [""])[0];
    if (unhealthy) { log(`INFRASTRUCTURE FAILURE: ${unhealthy} (not an application result)`); exit = 3; }
    else if (counts.total === 0) { log("NOTHING RAN: no test result was produced (a missing or empty test file is not a pass)"); exit = 4; }
    else if (r.status === 0 && (counts.skipped > 0 || counts.todo > 0 || counts.passed === 0)) { log(`SKIPPED TESTS: ${counts.skipped} skipped / ${counts.todo} todo / ${counts.passed} passed: a skipped suite is not a pass (its environment gate must be on)`); exit = 4; }
    else exit = r.status === 0 ? 0 : 1;
    const dirty = tests.dir === REPO ? git("status", "--porcelain", "--", "src", "scripts").length > 0 : false;
    writeFileSync(path.join(runDir, "result.json"), JSON.stringify({
      scenario: scenarioName, instance, exit, unhealthy, counts, failedTests, summary, seconds: Math.round((Date.now() - t0) / 1000), vitestArgs,
      testsCommit: tests.sha, testsDirty: dirty, baseline: up.meta.baseline, migrations: up.meta.migrations,
    }, null, 2));
    console.log(out);
    log(`scenario=${scenarioName} exit=${exit} ${unhealthy ? "UNHEALTHY " : ""}${summary.trim()} evidence=${runDir}`);
  } catch (e) {
    log(`INFRASTRUCTURE FAILURE after the stack started: ${e.message}`);
    exit = 3;
  }
  finish(exit);
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// compare: a wide catalog fingerprint of the public schema
// ---------------------------------------------------------------------------------------------------------------------------------------------------
const FINGERPRINT_SQL = `
select 'fn ' || p.oid::regprocedure::text || ' ' || md5(p.prosrc) || ' secdef=' || p.prosecdef || ' cfg=' || coalesce(p.proconfig::text, '-') || ' owner=' || p.proowner::regrole::text
  || ' ret=' || pg_get_function_result(p.oid) || ' vol=' || p.provolatile::text || ' strict=' || p.proisstrict || ' lang=' || p.prolang::reglanguage::text || ' acl=' || coalesce(p.proacl::text, '-')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'
union all select 'tbl ' || c.relname || ' rls=' || c.relrowsecurity || '/' || c.relforcerowsecurity || ' owner=' || c.relowner::regrole::text || ' acl=' || coalesce(c.relacl::text, '-') || ' cols=' ||
  (select string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull || ':' || coalesce(pg_get_expr(d.adbin, d.adrelid), '-') || ':' || a.attidentity || a.attgenerated, ',' order by a.attnum)
     from pg_attribute a left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped)
  from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r', 'p')
union all select 'con ' || conrelid::regclass::text || ' ' || conname || ' ' || md5(pg_get_constraintdef(oid)) from pg_constraint where connamespace = 'public'::regnamespace
union all select 'idx ' || tablename || ' ' || indexname || ' ' || md5(indexdef) from pg_indexes where schemaname = 'public'
union all select 'pol ' || tablename || ' ' || policyname || ' ' || cmd || ' ' || permissive || ' ' || roles::text || ' ' || md5(coalesce(qual, '') || '|' || coalesce(with_check, '')) from pg_policies where schemaname = 'public'
union all select 'trg ' || tgrelid::regclass::text || ' ' || tgname || ' ' || md5(pg_get_triggerdef(oid)) || ' enabled=' || tgenabled from pg_trigger where not tgisinternal and tgrelid in (select oid from pg_class where relnamespace = 'public'::regnamespace)
union all select 'view ' || c.relname || ' ' || md5(pg_get_viewdef(c.oid)) || ' acl=' || coalesce(c.relacl::text, '-') from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('v', 'm')
union all select 'seq ' || c.relname || ' acl=' || coalesce(c.relacl::text, '-') from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'S'
union all select 'type ' || t.typname || ' ' || t.typtype::text || ' ' || coalesce((select string_agg(e.enumlabel, ',' order by e.enumsortorder) from pg_enum e where e.enumtypid = t.oid), '-') from pg_type t where t.typnamespace = 'public'::regnamespace and t.typtype in ('e', 'd')
union all select 'defacl ' || defaclrole::regrole::text || ' ' || coalesce(defaclnamespace::regnamespace::text, '-') || ' ' || defaclobjtype::text || ' ' || defaclacl::text from pg_default_acl
union all select 'schema ' || nspname || ' ' || coalesce(nspacl::text, '-') from pg_namespace where nspname = 'public'
order by 1;`;
const fingerprint = (db) => {
  const r = psqlIn(db, FINGERPRINT_SQL, { extra: ["-At"] });
  if (r.code !== 0 || ERROR_RE.test(r.out)) throw Object.assign(new Error(`fingerprint query failed: ${r.out.slice(0, 300)}`), { infra: true });
  return r.out.split("\n").filter(Boolean);
};

async function cmdCompare(a, b, flags) {
  const inst = [`cmp-a-${process.pid}`, `cmp-b-${process.pid}`];
  const prints = [];
  let code = 3;
  try {
    for (const [i, sc] of [a, b].entries()) {
      const up = await cmdUp(sc, { ...flags, "no-api": true }, inst[i]);
      const fp = fingerprint(names(inst[i]).db);
      assertHealthy(names(inst[i]).db, up.meta.since);
      const kinds = fp.reduce((m, x) => { const k = x.split(" ")[0]; m[k] = (m[k] ?? 0) + 1; return m; }, {});
      for (const k of ["fn", "tbl", "con", "idx", "pol", "trg"]) if (!kinds[k]) throw Object.assign(new Error(`INCOMPLETE COMPARISON: no '${k}' entries read for ${sc}`), { infra: true });
      if (fp.length < 1000) throw Object.assign(new Error(`INCOMPLETE COMPARISON: only ${fp.length} catalog entries read for ${sc}`), { infra: true });
      prints.push({ fp, kinds, meta: up.meta });
    }
    const [A, B] = prints;
    const sa = new Set(A.fp), sb = new Set(B.fp);
    const onlyA = A.fp.filter((x) => !sb.has(x)), onlyB = B.fp.filter((x) => !sa.has(x));
    console.log(`${a}: ${A.fp.length} catalog entries   ${b}: ${B.fp.length}   only-in-${a}: ${onlyA.length}   only-in-${b}: ${onlyB.length}`);
    console.log(`compared ${JSON.stringify(A.kinds)}: function bodies+owner+security definer+config+ACL, table columns/defaults/not-null+RLS+owner+ACL, constraints, indexes, policies, triggers, views, sequences, enums, default privileges, schema ACL`);
    console.log(`baseline ${A.meta.baseline.ref} | ${a}: ${A.meta.migrations.map((m) => `${m.file}@${m.sha}`).join(", ") || "-"} | ${b}: ${B.meta.migrations.map((m) => `${m.file}@${m.sha}`).join(", ") || "-"}`);
    for (const x of onlyA.slice(0, 40)) console.log(`  < ${x.slice(0, 220)}`);
    for (const x of onlyB.slice(0, 40)) console.log(`  > ${x.slice(0, 220)}`);
    code = onlyA.length + onlyB.length === 0 ? 0 : 1;
  } catch (e) {
    if (e.usage) { for (const i of inst) cmdDown(i, { force: true }); die(e.message, 2); }
    log(`${e.infra ? "" : "INFRASTRUCTURE FAILURE: "}${e.message}`);
    code = 3;
  } finally {
    for (const i of inst) { try { cmdDown(i, { force: true }); } catch { /* best effort */ } }
  }
  process.exit(code);
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// matrix
// ---------------------------------------------------------------------------------------------------------------------------------------------------
/** Failures that are KNOWN and explained (scripts/qa/expected-results.json). A suite is "known" only when EVERY failing test is listed and EVERY listed test still fails. */
const EXPECTED = JSON.parse(readFileSync(path.join(here, "expected-results.json"), "utf8")).known;
function classify(file, scenarioName, runDirFromTail) {
  let r;
  try { r = JSON.parse(readFileSync(path.join(runDirFromTail, "result.json"), "utf8")); } catch { return null; }
  if (r.exit !== 1) return null;
  const rules = EXPECTED.filter((e) => e.suite === file && (e.scenarios.includes("*") || e.scenarios.includes(scenarioName)));
  if (rules.length === 0) return null;
  const listed = rules.flatMap((e) => e.failing);
  const allKnown = r.failedTests.every((t) => listed.some((k) => t.includes(k)));
  const allStillFail = listed.every((k) => r.failedTests.some((t) => t.includes(k)));
  return allKnown && allStillFail ? { reason: rules[0].reason } : null;
}

async function cmdMatrix(scenarioName, flags) {
  if (!SCENARIOS[scenarioName]) die(`unknown scenario ${scenarioName}`);
  const parallel = flags.parallel === undefined ? 3 : Number(flags.parallel);
  if (!Number.isInteger(parallel) || parallel < 1 || parallel > 6) die("--parallel must be an integer from 1 to 6");
  const ref = flags["tests-ref"];
  if (ref) testWorktree(ref); // created once, here, before any child needs it
  // the suites of the commit under test: every test file that carries the local-stack gate variable (local-stack suites, dry runs, the canary)
  const grep = ref ? git("grep", "-l", "TW4A_LOCAL_URL", resolveRef(ref), "--", "src") : git("grep", "-l", "TW4A_LOCAL_URL", "--", "src");
  const files = [...new Set(grep.split("\n").filter(Boolean).map((l) => l.replace(/^[0-9a-f]{40}:/, "")))].filter((f) => /\.test\.ts$/.test(f)).sort();
  if (files.length === 0) { log("INCOMPLETE MATRIX: no suites found"); process.exit(4); }
  const forward = [...(flags.migration ?? []).flatMap((m) => ["--migration", m]), ...(flags.cutoff ? ["--cutoff", flags.cutoff] : []), ...(ref ? ["--tests-ref", ref] : [])];
  const results = [];
  const run1 = (f, i) => new Promise((resolve) => {
    const instance = `${scenarioName}-m${i}-${process.pid}`;
    const p = spawn(process.execPath, [SELF, "run", scenarioName, "--name", instance, ...forward, "--", f], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => { err += d; });
    p.on("close", (status) => {
      const tail = err.split("\n").filter((l) => l.includes("[iso-qa] scenario=")).pop() ?? err.split("\n").filter((l) => l.includes("[iso-qa]")).pop() ?? "";
      const evidence = (tail.match(/evidence=(.*)$/) ?? [])[1];
      const known = status === 1 && evidence ? classify(f, scenarioName, evidence.trim()) : null;
      results.push({ file: f, status: status ?? 3, known: known?.reason ?? null, tail });
      console.log(`${status === 0 ? "PASS " : status === 3 ? "INFRA" : status === 4 ? "SKIP " : known ? "KNOWN" : "FAIL "} ${f}  ${tail.replace(/.*\[iso-qa\] /, "").replace(/.*scenario=/, "")}${known ? `  [known: ${known.reason.slice(0, 90)}]` : ""}`);
      resolve();
    });
  });
  const queue = files.map((f, i) => [f, i]);
  await Promise.all(Array.from({ length: parallel }, async () => { for (let j = queue.shift(); j; j = queue.shift()) await run1(...j); }));
  // a listed suite that PASSES means its expectation is stale: say so (and fail), so the list can never silently rot
  const stale = EXPECTED.filter((e) => (e.scenarios.includes("*") || e.scenarios.includes(scenarioName)) && results.some((r) => r.file === e.suite && r.status === 0));
  for (const e of stale) console.log(`STALE EXPECTATION: ${e.suite} now passes in ${scenarioName}: remove it from expected-results.json`);
  const bad = results.filter((r) => r.status !== 0);
  const unexpected = bad.filter((r) => !r.known);
  const complete = results.length === files.length;
  console.log(`\n${results.length - bad.length}/${files.length} suites passed in scenario ${scenarioName}${complete ? "" : " (INCOMPLETE: not every suite reported)"}; known pre-existing ${bad.filter((r) => r.known).length}; unexpected failures ${unexpected.filter((r) => r.status === 1).length}, skipped/empty ${unexpected.filter((r) => r.status === 4).length}, infrastructure ${unexpected.filter((r) => r.status === 3).length}, stale expectations ${stale.length}`);
  mkdirSync(QA_HOME, { recursive: true });
  writeFileSync(path.join(QA_HOME, `matrix-${scenarioName}${ref ? "-" + resolveRef(ref).slice(0, 8) : ""}.json`), JSON.stringify({ scenario: scenarioName, testsRef: ref ?? null, files, results }, null, 2));
  // 0 all passed; 6 only KNOWN, explained failures (never reported as green); 3 / 4 / 1 as before for anything unexpected
  process.exit(!complete ? 4 : stale.length ? 1 : bad.length === 0 ? 0 : unexpected.length === 0 ? 6 : unexpected.some((r) => r.status === 3) ? 3 : unexpected.some((r) => r.status === 4) ? 4 : 1);
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// repro + selftest + list
// ---------------------------------------------------------------------------------------------------------------------------------------------------
async function cmdRepro() {
  const sql = readFileSync(path.join(here, "repro", "supautils-function-acl-segfault.sql"), "utf8");
  const variants = [
    { name: "17.6.1.106, image defaults (supautils.hint_roles = anon, authenticated, service_role)", image: "public.ecr.aws/supabase/postgres:17.6.1.106", args: ["postgres", "-D", "/etc/postgresql"], expect: "CRASH" },
    { name: "17.6.1.106 with supautils.hint_roles emptied (the harness workaround)", image: "public.ecr.aws/supabase/postgres:17.6.1.106", args: ["postgres", "-D", "/etc/postgresql", "-c", "supautils.hint_roles="], expect: "survive" },
    { name: "17.11.0.004, image defaults", image: "public.ecr.aws/supabase/postgres:17.11.0.004", args: ["postgres", "-D", "/etc/postgresql"], expect: "survive" },
  ];
  let bad = 0;
  ensureNetwork();
  for (const v of variants) {
    const name = `df-isoqa-repro-${process.pid}`;
    dockerTry("rm", "-f", name);
    try {
      docker("run", "-d", "--name", name, ...OWNER(), "--network", NET, ...LIMITS.db, "-e", "POSTGRES_PASSWORD=postgres", v.image, ...v.args);
      await waitReady(name);
      const version = psqlIn(name, "show server_version;", { extra: ["-At"] }).out.trim();
      const before = crashLines(name).length;
      const r = spawnSync("docker", ["exec", "-i", "-e", "PGPASSWORD=postgres", name, "psql", "-U", "postgres", "-d", "postgres", "-q"], { input: sql, encoding: "utf8" });
      await sleep(1500);
      const crashed = crashLines(name).length > before;
      const signal = (dockerLogs(name).match(/terminated by signal [0-9]+: [A-Za-z ]+/) ?? [""])[0];
      const outcome = crashed ? "CRASH" : "survive";
      const ok = outcome === v.expect;
      if (!ok) bad += 1;
      console.log(`${ok ? "ok  " : "BAD "} ${v.name}\n     PostgreSQL ${version}: ${outcome}${signal ? ` (${signal})` : ""}; client saw: ${`${r.stdout}${r.stderr}`.trim().split(/\r?\n/).filter(Boolean).slice(-1)[0]?.slice(0, 100) ?? ""}`);
    } finally {
      dockerTry("rm", "-f", name);
    }
  }
  console.log(bad === 0 ? "\nreproduction confirmed (and the workaround and the newer image behave as documented)" : "\nUNEXPECTED RESULT: the documented behaviour no longer holds");
  process.exit(bad === 0 ? 0 : 1);
}

/** Negative controls for the harness itself: every way a run could be mistaken for a pass must be reported as a failure with the documented exit code. */
async function cmdSelftest() {
  const cfg = ["--config", "scripts/qa/selftest/vitest.config.mts"];
  const sfx = `-${process.pid}`;
  const run = (name, scenario, env, extra, expectCode) => new Promise((resolve) => {
    const p = spawn(process.execPath, [SELF, "run", scenario, "--name", `st-${name}${sfx}`, ...extra], { env: { ...process.env, ...env }, stdio: ["ignore", "ignore", "pipe"], cwd: REPO });
    let err = "";
    p.stderr.on("data", (d) => { err += d; });
    p.on("close", (code) => resolve({ name, code, expectCode, ok: code === expectCode, note: (err.split("\n").filter((l) => l.includes("[iso-qa]")).pop() ?? "").replace(/.*\[iso-qa\] /, "").slice(0, 150) }));
  });
  const t = (f) => `scripts/qa/selftest/${f}`;
  const cases = [
    () => run("pass", "baseline", {}, ["--", ...cfg, t("pass.test.ts")], 0),
    () => run("fail", "baseline", {}, ["--", ...cfg, t("fail.test.ts")], 1),
    () => run("skip", "baseline", {}, ["--", ...cfg, t("skipped.test.ts")], 4),
    () => run("none", "baseline", {}, ["--", ...cfg, t("does-not-exist.test.ts")], 4),
    () => run("crash", "baseline", { ISO_QA_UNMITIGATED: "1" }, ["--", ...cfg, t("crash.test.ts")], 3),
    () => run("badmig", "baseline", {}, ["--migration", `${REF_MAIN}:99999999`, "--", ...cfg, t("pass.test.ts")], 3),
    () => run("dupmig", "baseline", {}, ["--migration", `${REF_MAIN}:20261207`, "--migration", `${REF_MAIN}:20261207`, "--", ...cfg, t("pass.test.ts")], 3),
    () => run("badscenario", "no-such-scenario", {}, ["--", ...cfg, t("pass.test.ts")], 2),
    () => run("badflag", "baseline", {}, ["--migrations", `${REF_MAIN}:20261207`, "--", ...cfg, t("pass.test.ts")], 2),
  ];
  const results = [];
  const claimsSeen = new Set();
  let portsUnique = true;
  for (let i = 0; i < cases.length; i += 3) {
    const wave = cases.slice(i, i + 3).map((f) => f());
    const sampler = setInterval(() => { const ps = Object.values(readClaims()).map((v) => v.port); if (new Set(ps).size !== ps.length) portsUnique = false; for (const p of ps) claimsSeen.add(p); }, 400);
    results.push(...(await Promise.all(wave)));
    clearInterval(sampler);
  }
  for (const r of results) console.log(`${r.ok ? "ok  " : "BAD "} ${r.name}: exit ${r.code} (expected ${r.expectCode}) ${r.note}`);
  const leftovers = dockerTry("ps", "-a", "--filter", `label=${LABEL}`, "--filter", `name=df-isoqa-st-`, "--format", "{{.Names}}").out.split("\n").filter((n) => n.endsWith(`${sfx}-db`) || n.endsWith(`${sfx}-rest`) || n.endsWith(`${sfx}-kong`));
  console.log(`${leftovers.length === 0 ? "ok  " : "BAD "} cleanup: ${leftovers.length} self-test container(s) left${leftovers.length ? `: ${leftovers.join(", ")}` : ""}`);
  console.log(`${portsUnique ? "ok  " : "BAD "} ports: ${claimsSeen.size} distinct port(s) claimed; no two live claims ever shared a port: ${portsUnique}`);
  // ownership: a live foreign owner is never replaced or removed
  let foreignOk = false;
  const probe = `df-isoqa-st-owner-${process.pid}`;
  try {
    ensureNetwork();
    docker("create", "--name", probe, "--label", LABEL, "--label", `df.isoqa.owner=${process.ppid}`, "--network", NET, PG_IMAGE, "true");
    try { assertNotForeignLive(probe); } catch { foreignOk = pidAlive(process.ppid); }
    if (!pidAlive(process.ppid)) foreignOk = true;
  } catch { foreignOk = true; } finally { dockerTry("rm", "-f", probe); }
  console.log(`${foreignOk ? "ok  " : "BAD "} ownership: a stack owned by a live process is refused`);
  const good = results.every((r) => r.ok) && leftovers.length === 0 && portsUnique && foreignOk;
  console.log(good ? "\nself-test passed: no false pass is possible through the tested paths" : "\nSELF-TEST FAILED");
  process.exit(good ? 0 : 1);
}

const cmdList = () => console.log(dockerTry("ps", "-a", "--filter", `label=${LABEL}`, "--format", "{{.Names}}\t{{.Status}}\t{{.Ports}}").out);

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// argument parsing with strict validation (an unknown scenario or flag must never silently test the wrong schema)
// ---------------------------------------------------------------------------------------------------------------------------------------------------
const ALLOWED = {
  baseline: ["cutoff", "ref", "base"], up: ["name", "migration", "cutoff", "no-api"], run: ["name", "keep", "migration", "cutoff", "tests-ref"],
  matrix: ["parallel", "tests-ref", "migration", "cutoff"], compare: ["cutoff"], down: ["name", "all", "force"], list: [], repro: [], selftest: [], scenarios: [],
};
const BOOLEAN = new Set(["keep", "all", "force", "no-api"]);
function parse(argv) {
  const flags = {};
  const rest = [];
  const dd = argv.indexOf("--");
  const head = dd >= 0 ? argv.slice(0, dd) : argv;
  const tail = dd >= 0 ? argv.slice(dd + 1) : [];
  for (let i = 0; i < head.length; i += 1) {
    const a = head[i];
    if (!a.startsWith("--")) { rest.push(a); continue; }
    const key = a.slice(2);
    if (BOOLEAN.has(key)) flags[key] = true;
    else {
      const value = head[++i];
      if (value === undefined || value.startsWith("--")) die(`flag --${key} needs a value`);
      if (key === "migration") (flags.migration ??= []).push(value);
      else flags[key] = value;
    }
  }
  return { flags, rest, tail };
}
function validate(cmd, scenario, rest, flags, tail) {
  if (!cmd || !(cmd in ALLOWED)) die(`commands: ${Object.keys(ALLOWED).join(" | ")}`);
  for (const k of Object.keys(flags)) if (!ALLOWED[cmd].includes(k)) die(`unknown flag --${k} for '${cmd}' (allowed: ${ALLOWED[cmd].map((f) => `--${f}`).join(" ") || "none"})`);
  if (flags.name !== undefined && !/^[a-z0-9][a-z0-9-]{0,40}$/.test(flags.name)) die("--name must match [a-z0-9][a-z0-9-]{0,40}");
  if (flags.cutoff !== undefined && !/^[0-9]{14}$/.test(flags.cutoff)) die("--cutoff must be 14 digits");
  for (const m of flags.migration ?? []) if (!/^[A-Za-z0-9_./@^~-]+:[0-9]{8,14}$/.test(m)) die(`--migration must look like <git-ref>:<version> (got ${m})`);
  if (["up", "run", "matrix"].includes(cmd)) {
    if (!scenario) die(`usage: ${cmd} <scenario>`);
    if (!SCENARIOS[scenario]) die(`unknown scenario '${scenario}' (known: ${Object.keys(SCENARIOS).join(", ")})`);
  }
  if (cmd === "compare") for (const s of rest.slice(1, 3)) if (!SCENARIOS[s]) die(`unknown scenario '${s}'`);
  if (cmd === "compare" && rest.length !== 3) die("usage: compare <scenarioA> <scenarioB>");
  if (cmd === "run" && tail.length === 0) die("usage: run <scenario> -- <vitest args>");
  if (cmd === "down" && !flags.all && !flags.name) die("usage: down --name <instance> | down --all [--force]");
  for (const ref of [flags["tests-ref"], ...(flags.migration ?? []).map((m) => parseMigration(m)[0])]) if (ref) { try { resolveRef(ref); } catch (e) { die(e.message); } }
}

const { flags, rest, tail } = parse(process.argv.slice(2));
const [cmd, scenario] = rest;
validate(cmd, scenario, rest, flags, tail);
const instanceOf = () => flags.name ?? `${scenario}-${process.pid}`;
switch (cmd) {
  case "baseline": await cmdBaseline(flags); break;
  case "up": { const instance = instanceOf(); try { const up = await cmdUp(scenario, flags, instance); console.log(JSON.stringify({ instance, ...up.env }, null, 2)); } catch (e) { log(`INFRASTRUCTURE FAILURE: ${e.message}`); process.exit(3); } break; }
  case "run": await cmdRun(scenario, flags, tail, instanceOf()); break;
  case "down": if (flags.all) cmdDownAll(Boolean(flags.force)); else cmdDown(flags.name, { force: Boolean(flags.force) }); break;
  case "list": cmdList(); break;
  case "repro": await cmdRepro(); break;
  case "selftest": await cmdSelftest(); break;
  case "matrix": await cmdMatrix(scenario, flags); break;
  case "compare": await cmdCompare(rest[1], rest[2], flags); break;
  case "scenarios": for (const [k, v] of Object.entries(SCENARIOS)) console.log(`${k}\t${v.description}`); break;
}
