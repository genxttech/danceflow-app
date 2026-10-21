#!/usr/bin/env node
/**
 * TW-4F isolated QA harness (local only). Runs the SQL / local-stack regression suites against a DISPOSABLE Postgres + PostgREST + Kong stack instead of
 * the shared `supabase_*_danceflow-e2e-qa` stack, so a crash or leftover fixtures from one session can never contaminate another session's run.
 *
 *   node scripts/qa/iso-qa.mjs baseline [--cutoff 20261205090000] [--ref origin/main]   build the local image `df-isoqa/base:<cutoff>` (July production schema + replayed migrations)
 *   node scripts/qa/iso-qa.mjs up   <scenario> [--migration ref:file]... start a stack, apply the migrations in the given order, print the env
 *   node scripts/qa/iso-qa.mjs run  <scenario> [--keep] -- <vitest args>   up, run vitest against it, classify the result, tear down
 *   node scripts/qa/iso-qa.mjs run  <scenario> --tests-ref <ref> -- ...   run the suites of ANOTHER commit (a private detached worktree under QA_HOME), e.g. PR #251's own tests
 *   node scripts/qa/iso-qa.mjs matrix <scenario> [--parallel 3]          every local-stack suite, each in its OWN fresh database, with a pass / fail / infrastructure summary
 *   node scripts/qa/iso-qa.mjs compare <scenarioA> <scenarioB>            catalog fingerprint diff: does the migration order change the resulting schema?
 *   node scripts/qa/iso-qa.mjs down <scenario> | down --all | list
 *   node scripts/qa/iso-qa.mjs repro                                       re-run the preserved minimal SQL case that segfaults image 17.6.1.106 (and show 17.11.0.004 / the workaround survive)
 *   node scripts/qa/iso-qa.mjs scenarios                                  list the built-in scenarios
 *
 * Isolation rules (enforced here): every container carries the label df.isoqa=1 and the prefix df-isoqa-; they live on their own docker network
 * (df-isoqa-net) and on host ports 56600-56799 bound to 127.0.0.1; the harness never starts, stops, writes to or execs into any container without that label.
 * It never reads or writes any other stack, and takes migrations from git refs, never from a working tree.
 *
 * Exit codes of `run`: 0 every test passed (none skipped); 1 tests failed with a healthy database; 3 INFRASTRUCTURE failure (the database crashed or never became ready: not an application
 * result); 4 a suite was SKIPPED or ran nothing (never reported as a pass); 2 harness usage error.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, "..", "..");
const QA_HOME = process.env.ISO_QA_HOME ?? path.resolve(REPO, "..", "danceflow-iso-qa");
const NET = "df-isoqa-net";
const LABEL = "df.isoqa=1";
const PG_IMAGE = process.env.ISO_QA_PG_IMAGE ?? "public.ecr.aws/supabase/postgres:17.6.1.106";
const REST_IMAGE = process.env.ISO_QA_REST_IMAGE ?? "public.ecr.aws/supabase/postgrest:v14.8";
const KONG_IMAGE = process.env.ISO_QA_KONG_IMAGE ?? "public.ecr.aws/supabase/kong:2.8.1";
const DEFAULT_CUTOFF = "20261205090000";
const MIGRATIONS = "src/lib/supabase/migrations";
/** The supautils extension of image 17.6.1.106 segfaults on any "permission denied for function" error for anon/authenticated/service_role (see docs/twilio/TW-4F_Isolated_QA.md). Emptying its hint feature avoids it; the canary test pins that the stack survives. */
const LIMITS = {
  db: ["--memory", process.env.ISO_QA_DB_MEMORY ?? "1500m", "--cpus", process.env.ISO_QA_DB_CPUS ?? "1.5"],
  rest: ["--memory", process.env.ISO_QA_REST_MEMORY ?? "256m", "--cpus", "0.5"],
  kong: ["--memory", process.env.ISO_QA_KONG_MEMORY ?? "512m", "--cpus", "0.5"],
};
const PG_ARGS = ["postgres", "-D", "/etc/postgresql", "-c", "supautils.hint_roles="];

process.env.MSYS_NO_PATHCONV = "1"; // Git Bash must not rewrite /etc/... container paths

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts }).trim();
const docker = (...args) => sh("docker", args);
const dockerTry = (...args) => { try { return { ok: true, out: docker(...args) }; } catch (e) { return { ok: false, out: String(e.stderr ?? e.message) }; } };
/** The container's complete log. `docker logs` writes the container's stderr to its own stderr, so both streams are read (stdout alone is empty for Postgres). */
const dockerLogs = (name) => {
  const r = spawnSync("docker", ["logs", name], { encoding: "utf8", maxBuffer: 1 << 28 });
  return `${r.stdout ?? ""}${r.stderr ?? ""}`;
};
const log = (...a) => console.error("[iso-qa]", ...a);
const die = (msg, code = 2) => { console.error(`[iso-qa] ${msg}`); process.exit(code); };
const git = (...args) => sh("git", ["-C", REPO, ...args]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// scenarios: ordered migration lists taken from git REFS (never from another session's working tree)
// ---------------------------------------------------------------------------------------------------------------------------------------------------
const MANIFEST = JSON.parse(readFileSync(path.join(here, "scenarios.json"), "utf8"));
const refOf = (key) => process.env[`ISO_QA_REF_${key}`] ?? MANIFEST.refs[key] ?? die(`unknown ref key ${key}`);
const REF_MAIN = refOf("MAIN");
const SCENARIOS = Object.fromEntries(Object.entries(MANIFEST.scenarios).map(([k, v]) => [k, { description: v.description, migrations: v.migrations.map(([key, version]) => [refOf(key), version]) }]));

function migrationFileAt(ref, version) {
  const names = git("ls-tree", "--name-only", `${ref}:${MIGRATIONS}`).split("\n").filter((n) => n.startsWith(`${version}`) && n.endsWith(".sql"));
  if (names.length !== 1) die(`expected exactly one migration ${version}* at ${ref}, found ${names.length}`);
  return names[0];
}
const migrationSql = (ref, file) => git("show", `${ref}:${MIGRATIONS}/${file}`);
const rollbackSql = (ref, file) => git("show", `${ref}:${MIGRATIONS}/rollback/${file.replace(/\.sql$/, "_rollback.sql")}`);

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// docker helpers (label-fenced)
// ---------------------------------------------------------------------------------------------------------------------------------------------------
function ensureNetwork() {
  if (!dockerTry("network", "inspect", NET).ok) docker("network", "create", "--label", LABEL, NET);
}
function ours(name) {
  const r = dockerTry("inspect", "--format", '{{ index .Config.Labels "df.isoqa" }}', name);
  return r.ok && r.out === "1";
}
function assertOurs(name) {
  if (!name.startsWith("df-isoqa-") || !ours(name)) die(`refusing to touch ${name}: not an isolated-QA container`);
}
const psqlIn = (container, sql, { user = "postgres", okOnError = false, extra = [] } = {}) => {
  assertOurs(container);
  const r = spawnSync("docker", ["exec", "-i", "-e", "PGPASSWORD=postgres", container, "psql", "-U", user, "-d", "postgres", "-q", "-v", okOnError ? "ON_ERROR_STOP=0" : "ON_ERROR_STOP=1", ...extra], { input: sql, encoding: "utf8", maxBuffer: 1 << 28 });
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};
async function waitReady(container, timeoutMs = 240_000) {
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
const crashCount = (container) => (dockerLogs(container).match(/terminated by signal|server process .* was terminated/g) ?? []).length;
function freePort(start, taken) {
  return new Promise((resolve, reject) => {
    const tryPort = (p) => {
      if (p > 56799) return reject(new Error("no free port in 56600-56799"));
      if (taken.has(p)) return tryPort(p + 1);
      const s = net.createServer();
      s.once("error", () => tryPort(p + 1));
      s.listen(p, "127.0.0.1", () => s.close(() => resolve(p)));
    };
    tryPort(start);
  });
}
const usedHostPorts = () => new Set((dockerTry("ps", "--filter", `label=${LABEL}`, "--format", "{{.Ports}}").out.match(/:(\d+)->/g) ?? []).map((m) => Number(m.slice(1, -2))));

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// baseline: the production schema dump of 2026-07-15 (pre-accounting, schema only, local and git-ignored) + the repo's own migrations replayed in version order
// from a git REF up to the cutoff. Nothing is read from the shared QA database or from any working tree, so another session's unmerged objects can never leak in.
// ---------------------------------------------------------------------------------------------------------------------------------------------------
const KNOWN_UNREPLAYABLE = path.join(here, "known-unreplayable.txt");
const versionOf = (name) => name.replace(/^[0-9]{2}-/, "").slice(0, 14).replace(/[^0-9]/g, "").padEnd(8, "0");
const defaultBaseSchema = () => {
  const common = git("rev-parse", "--path-format=absolute", "--git-common-dir");
  return path.join(path.dirname(common), "backups", "danceflow-production-pre-accounting-v1-2026-07-15.sql");
};

// the pieces a bare Supabase image does not carry: GoTrue creates auth.jwt(); storage-api creates the storage tables that some migrations reference
const BOOTSTRAP_SQL = `
create or replace function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim', true), ''), nullif(current_setting('request.jwt.claims', true), ''))::jsonb
$$;
grant execute on function auth.jwt() to anon, authenticated, service_role;
`;

async function startDb(name, port, image = PG_IMAGE) {
  ensureNetwork();
  dockerTry("rm", "-f", name);
  docker("run", "-d", "--name", name, "--label", LABEL, "--network", NET, ...LIMITS.db, "-p", `127.0.0.1:${port}:5432`, "-e", "POSTGRES_PASSWORD=postgres", image, ...PG_ARGS);
  await waitReady(name);
}

async function cmdBaseline(flags) {
  const cutoff = flags.cutoff ?? DEFAULT_CUTOFF;
  const ref = flags.ref ?? REF_MAIN;
  const baseSchema = flags.base ?? process.env.ISO_QA_BASE_SCHEMA ?? defaultBaseSchema();
  if (!existsSync(baseSchema)) die(`base schema dump not found: ${baseSchema} (set ISO_QA_BASE_SCHEMA)`);
  const known = new Set(readFileSync(KNOWN_UNREPLAYABLE, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).map((l) => l.split(/\s+/)[0]));
  const files = git("ls-tree", "--name-only", `${ref}:${MIGRATIONS}`).split("\n").filter((n) => n.endsWith(".sql"))
    .map((n) => ({ n, v: versionOf(n).padEnd(14, "0") })).filter((x) => x.v >= "20260715000000" && x.v <= cutoff)
    .sort((p, q) => (p.v === q.v ? (p.n < q.n ? -1 : 1) : p.v < q.v ? -1 : 1));
  const port = await freePort(56600, usedHostPorts());
  const builder = "df-isoqa-baseline-builder";
  log(`starting a fresh database; base ${path.basename(baseSchema)} + ${files.length} migrations from ${ref} through ${cutoff} ...`);
  await startDb(builder, port);
  let r = psqlIn(builder, BOOTSTRAP_SQL, { user: "supabase_admin" });
  if (r.code !== 0) throw new Error(`bootstrap failed: ${r.out.slice(0, 400)}`);
  r = psqlIn(builder, readFileSync(baseSchema, "utf8"), { okOnError: true });
  const loadErrors = r.out.split("\n").filter((l) => /ERROR/.test(l));
  if (loadErrors.length) throw new Error(`base schema load errors:\n${loadErrors.slice(0, 10).join("\n")}`);
  const failed = [];
  let applied = 0;
  for (const { n } of files) {
    const res = psqlIn(builder, git("show", `${ref}:${MIGRATIONS}/${n}`), { okOnError: true });
    if (res.code !== 0 || /ERROR/.test(res.out)) {
      failed.push(n);
      if (!known.has(n)) throw new Error(`migration ${n} failed and is not in known-unreplayable.txt:\n${(res.out.split("\n").find((l) => /ERROR/.test(l)) ?? res.out).slice(0, 500)}`);
    } else applied += 1;
  }
  const stale = [...known].filter((k) => !failed.includes(k));
  if (stale.length) log(`note: ${stale.length} entries of known-unreplayable.txt replayed cleanly this time: ${stale.join(", ")}`);
  const head = git("rev-parse", ref).slice(0, 12);
  const tag = `df-isoqa/base:${cutoff}`;
  docker("stop", builder);
  docker("commit", "--change", 'ENTRYPOINT ["docker-entrypoint.sh"]', "--change", 'CMD ["postgres","-D","/etc/postgresql"]', "--change", `LABEL df.isoqa.ref=${ref}@${head}`, "--change", `LABEL df.isoqa.cutoff=${cutoff}`, builder, tag);
  docker("rm", "-f", builder);
  log(`baseline image ${tag} built: ${applied} migrations applied, ${failed.length} known-unreplayable skipped (${ref}@${head})`);
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// up / down / run
// ---------------------------------------------------------------------------------------------------------------------------------------------------
const names = (scenario) => ({ db: `df-isoqa-${scenario}-db`, rest: `df-isoqa-${scenario}-rest`, kong: `df-isoqa-${scenario}-kong` });

function kongYml(rest) {
  return `_format_version: "2.1"
services:
  - name: rest-v1
    url: http://${rest}:3000/
    routes:
      - name: rest-v1
        strip_path: true
        paths: ["/rest/v1/"]
`;
}

async function cmdUp(scenarioName, flags, instance = scenarioName) {
  const extra = flags.migration ?? [];
  const preset = SCENARIOS[scenarioName];
  const list = [...(preset ? preset.migrations : []), ...extra.map((m) => { const i = m.indexOf(":"); return [m.slice(0, i), m.slice(i + 1)]; })];
  const cutoff = flags.cutoff ?? DEFAULT_CUTOFF;
  const image = `df-isoqa/base:${cutoff}`;
  if (!dockerTry("image", "inspect", image).ok) die(`baseline image ${image} not found: run \`snapshot\` and \`baseline\` first`);
  const n = names(instance);
  const taken = usedHostPorts();
  const dbPort = await freePort(56600, taken);
  taken.add(dbPort);
  const apiPort = await freePort(dbPort + 1, taken);
  const jwt = randomBytes(24).toString("hex");
  ensureNetwork();
  for (const c of [n.kong, n.rest, n.db]) if (dockerTry("inspect", c).ok) { assertOurs(c); docker("rm", "-f", c); }
  docker("run", "-d", "--name", n.db, "--label", LABEL, "--network", NET, ...LIMITS.db, "-p", `127.0.0.1:${dbPort}:5432`, "-e", "POSTGRES_PASSWORD=postgres", image, ...PG_ARGS);
  await waitReady(n.db);
  // the migrations, in order, each in its own transaction scope exactly as the repo's files are written (they carry their own begin/commit)
  for (const [ref, version] of list) {
    const file = migrationFileAt(ref, version);
    log(`applying ${file} (from ${ref})`);
    const r = psqlIn(n.db, migrationSql(ref, file));
    if (r.code !== 0 || /(^|\n)(psql: )?(ERROR|FATAL):/.test(r.out)) throw new Error(`migration ${file} failed:\n${r.out.slice(0, 800)}`);
    if (/(^|\n)WARNING:/.test(r.out)) log(`  warnings from ${file}: ${r.out.split('\n').filter((l) => /WARNING:/.test(l)).slice(0, 3).join(' | ')}`);
  }
  // the API role the PostgREST container logs in as (the bare image carries no password for it)
  const pw = psqlIn(n.db, "alter role authenticator with password 'postgres';", { user: "supabase_admin" });
  if (pw.code !== 0) throw new Error(`could not set the API role password: ${pw.out.slice(0, 300)}`);
  docker("run", "-d", "--name", n.rest, "--label", LABEL, "--network", NET, ...LIMITS.rest,
    "-e", `PGRST_DB_URI=postgres://authenticator:postgres@${n.db}:5432/postgres`, "-e", "PGRST_DB_SCHEMAS=public", "-e", "PGRST_DB_ANON_ROLE=anon",
    "-e", `PGRST_JWT_SECRET=${jwt}`, "-e", "PGRST_DB_USE_LEGACY_GUCS=false", REST_IMAGE);
  docker("create", "--name", n.kong, "--label", LABEL, "--network", NET, ...LIMITS.kong, "-p", `127.0.0.1:${apiPort}:8000`,
    "-e", "KONG_DATABASE=off", "-e", "KONG_DECLARATIVE_CONFIG=/home/kong/kong.yml", "-e", "KONG_PROXY_LISTEN=0.0.0.0:8000", "-e", "KONG_DNS_ORDER=LAST,A,CNAME", KONG_IMAGE);
  const ymlPath = path.join(QA_HOME, `kong-${instance}.yml`);
  mkdirSync(QA_HOME, { recursive: true });
  writeFileSync(ymlPath, kongYml(n.rest));
  docker("cp", ymlPath, `${n.kong}:/home/kong/kong.yml`);
  docker("start", n.kong);
  const env = { TW4A_LOCAL_URL: `http://127.0.0.1:${apiPort}`, TW4A_LOCAL_DB_CONTAINER: n.db, TW4A_LOCAL_JWT_SECRET: jwt, TW4_ISO_QA: "1", ISO_QA_SCENARIO: scenarioName, ISO_QA_INSTANCE: instance };
  // wait for the API to answer through Kong
  const t0 = Date.now();
  for (;;) {
    try { const res = await fetch(`${env.TW4A_LOCAL_URL}/rest/v1/`, { headers: { apikey: "x" } }); if (res.status < 500) break; } catch { /* not yet */ }
    if (Date.now() - t0 > 90_000) throw new Error("the API did not come up");
    await sleep(1500);
  }
  writeFileSync(path.join(QA_HOME, `env-${instance}.json`), JSON.stringify(env, null, 2));
  return env;
}

function cmdDown(scenarioName) {
  const n = names(scenarioName);
  for (const c of [n.kong, n.rest, n.db]) if (dockerTry("inspect", c).ok) { assertOurs(c); docker("rm", "-f", c); }
}

async function cmdRun(scenarioName, flags, vitestArgs) {
  const instance = flags.name ?? scenarioName;
  const cleanup = () => { try { cmdDown(instance); } catch { /* best effort */ } };
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { cleanup(); process.exit(130); });
  let env;
  const out = [];
  const t0 = Date.now();
  let exit = 3;
  try {
    env = await cmdUp(scenarioName, flags, instance);
  } catch (e) {
    log(`INFRASTRUCTURE FAILURE while starting: ${e.message}`);
    cmdDown(instance);
    process.exit(3);
  }
  const runDir = path.join(QA_HOME, "runs", `${new Date().toISOString().replace(/[:.]/g, "-")}-${instance}`);
  mkdirSync(runDir, { recursive: true });
  const crashesBefore = crashCount(names(instance).db);
  const jsonOut = path.join(runDir, "vitest.json");
  const args = ["vitest", "run", "--no-file-parallelism", "--reporter=default", "--reporter=json", `--outputFile.json=${jsonOut}`, ...vitestArgs];
  const testRoot = flags["tests-ref"] ? testWorktree(flags["tests-ref"]) : REPO;
  const r = spawnSync("npx", args, { cwd: testRoot, env: { ...process.env, ...env }, encoding: "utf8", shell: process.platform === "win32", maxBuffer: 1 << 28 });
  out.push(r.stdout ?? "", r.stderr ?? "");
  writeFileSync(path.join(runDir, "vitest.log"), out.join("\n"));
  const crashes = crashCount(names(instance).db) - crashesBefore;
  // a suite that was SKIPPED (its environment gate was off) or ran nothing is not a pass
  let counts = { passed: 0, failed: 0, skipped: 0, todo: 0, total: 0 };
  try {
    const j = JSON.parse(readFileSync(jsonOut, "utf8"));
    counts = { passed: j.numPassedTests, failed: j.numFailedTests, skipped: j.numPendingTests, todo: j.numTodoTests, total: j.numTotalTests };
  } catch { /* no JSON: handled below as an infrastructure/usage failure */ }
  const dbLog = dockerLogs(names(instance).db);
  writeFileSync(path.join(runDir, "postgres.log"), dbLog);
  const summary = (out.join("\n").match(/Tests\s+.*$/m) ?? [""])[0];
  if (crashes > 0) {
    log(`INFRASTRUCTURE FAILURE: the database crashed ${crashes} time(s) during the run (not an application result). Evidence: ${runDir}`);
    exit = 3;
  } else if (counts.total === 0) {
    log("NOTHING RAN: no test result was produced (a missing or empty test file is not a pass)");
    exit = 4;
  } else if (r.status === 0 && (counts.skipped > 0 || counts.todo > 0 || counts.passed === 0)) {
    log(`SKIPPED TESTS: ${counts.skipped} skipped / ${counts.todo} todo / ${counts.passed} passed: a skipped suite is not a pass (its environment gate must be on)`);
    exit = 4;
  } else {
    exit = r.status === 0 ? 0 : 1;
  }
  writeFileSync(path.join(runDir, "result.json"), JSON.stringify({ scenario: scenarioName, instance, exit, crashes, counts, summary, seconds: Math.round((Date.now() - t0) / 1000), vitestArgs }, null, 2));
  console.log(out.join("\n"));
  log(`scenario=${scenarioName} exit=${exit} crashes=${crashes} ${summary.trim()} evidence=${runDir}`);
  if (!flags.keep) cmdDown(instance);
  process.exit(exit);
}

/** A private detached worktree (under QA_HOME) of a ref, so another commit's own suites can run without touching any session's worktree. */
function testWorktree(ref) {
  const sha = git("rev-parse", ref);
  const dir = path.join(QA_HOME, "wt", sha.slice(0, 12));
  if (!existsSync(dir)) {
    mkdirSync(path.dirname(dir), { recursive: true });
    git("worktree", "add", "--detach", dir, sha);
    spawnSync("cmd", ["/c", "mklink", "/J", path.join(dir, "node_modules"), path.join(REPO, "node_modules")], { stdio: "ignore" });
  }
  return dir;
}

const FINGERPRINT_SQL = `
select 'fn ' || p.oid::regprocedure::text || ' ' || md5(p.prosrc) || ' ' || coalesce(p.proacl::text, '-') from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'
union all select 'tbl ' || c.relname || ' ' || coalesce(c.relacl::text, '-') || ' ' || (select string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod), ',' order by a.attnum) from pg_attribute a where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped)
  from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r', 'p')
union all select 'con ' || conrelid::regclass::text || ' ' || conname || ' ' || md5(pg_get_constraintdef(oid)) from pg_constraint where connamespace = 'public'::regnamespace
union all select 'trg ' || tgrelid::regclass::text || ' ' || tgname || ' ' || md5(pg_get_triggerdef(oid)) from pg_trigger where not tgisinternal and tgrelid in (select oid from pg_class where relnamespace = 'public'::regnamespace)
order by 1;`;
const fingerprint = (db) => psqlIn(db, FINGERPRINT_SQL, { extra: ["-At"] }).out.split("\n").filter(Boolean);

async function cmdCompare(a, b, flags) {
  const fa = await cmdUp(a, flags, `cmp-a`).then(() => fingerprint(names("cmp-a").db));
  const fb = await cmdUp(b, flags, `cmp-b`).then(() => fingerprint(names("cmp-b").db));
  cmdDown("cmp-a"); cmdDown("cmp-b");
  const sa = new Set(fa), sb = new Set(fb);
  const onlyA = fa.filter((x) => !sb.has(x)), onlyB = fb.filter((x) => !sa.has(x));
  console.log(`${a}: ${fa.length} catalog entries   ${b}: ${fb.length}   only-in-${a}: ${onlyA.length}   only-in-${b}: ${onlyB.length}`);
  for (const x of onlyA.slice(0, 40)) console.log(`  < ${x.slice(0, 200)}`);
  for (const x of onlyB.slice(0, 40)) console.log(`  > ${x.slice(0, 200)}`);
  process.exit(onlyA.length + onlyB.length === 0 ? 0 : 1);
}

async function cmdMatrix(scenarioName, flags) {
  const files = execFileSync("git", ["-C", REPO, "ls-files", "src/**/localStack*.test.ts"], { encoding: "utf8" }).split("\n").filter(Boolean);
  const parallel = Number(flags.parallel ?? 3);
  const results = [];
  {
    const run1 = (f, i) => new Promise((resolve) => {
      const instance = `${scenarioName}-m${i}`;
      const extra = flags["tests-ref"] ? ["--tests-ref", flags["tests-ref"]] : [];
      const p = spawn("node", [fileURLToPath(import.meta.url), "run", scenarioName, "--name", instance, ...extra, "--", f], { stdio: ["ignore", "ignore", "pipe"] });
      let err = "";
      p.stderr.on("data", (d) => { err += d; });
      p.on("close", (status) => {
        const tail = err.split("\n").filter((l) => l.includes("[iso-qa] scenario=")).pop() ?? "";
        results.push({ file: f, status, tail });
        console.log(`${status === 0 ? "PASS " : status === 3 ? "INFRA" : status === 4 ? "SKIP " : "FAIL "} ${f}  ${tail.replace(/.*scenario=/, "")}`);
        resolve();
      });
    });
    const q = files.map((f, i) => [f, i]);
    const lanes = Array.from({ length: parallel }, async () => { for (let j = q.shift(); j; j = q.shift()) await run1(...j); });
    await Promise.all(lanes);
  }
  const bad = results.filter((r) => r.status !== 0);
  console.log(`\n${results.length - bad.length}/${results.length} suites passed in scenario ${scenarioName}; infrastructure failures: ${results.filter((r) => r.status === 3).length}`);
  writeFileSync(path.join(QA_HOME, `matrix-${scenarioName}.json`), JSON.stringify(results, null, 2));
  process.exit(bad.length === 0 ? 0 : results.some((r) => r.status === 3) ? 3 : 1);
}

/** Runs the preserved minimal SQL case against each image / setting combination and states what happened. Self-contained: its own containers, removed afterwards. */
async function cmdRepro() {
  const sql = readFileSync(path.join(here, "repro", "supautils-function-acl-segfault.sql"), "utf8");
  const variants = [
    { name: "17.6.1.106, image defaults (supautils.hint_roles = anon, authenticated, service_role)", image: "public.ecr.aws/supabase/postgres:17.6.1.106", args: ["postgres", "-D", "/etc/postgresql"], expect: "CRASH" },
    { name: "17.6.1.106 with supautils.hint_roles emptied (the harness workaround)", image: "public.ecr.aws/supabase/postgres:17.6.1.106", args: PG_ARGS, expect: "survive" },
    { name: "17.11.0.004, image defaults", image: "public.ecr.aws/supabase/postgres:17.11.0.004", args: ["postgres", "-D", "/etc/postgresql"], expect: "survive" },
  ];
  let bad = 0;
  ensureNetwork();
  for (const v of variants) {
    const name = "df-isoqa-repro";
    dockerTry("rm", "-f", name);
    docker("run", "-d", "--name", name, "--label", LABEL, "--network", NET, ...LIMITS.db, "-e", "POSTGRES_PASSWORD=postgres", v.image, ...v.args);
    await waitReady(name);
    const version = psqlIn(name, "show server_version;", { extra: ["-At"] }).out.trim();
    const before = crashCount(name);
    const r = psqlIn(name, sql, { okOnError: true });
    await sleep(1500);
    const crashed = crashCount(name) > before;
    const signal = (dockerLogs(name).match(/terminated by signal [0-9]+: [A-Za-z ]+/) ?? [""])[0];
    const outcome = crashed ? "CRASH" : "survive";
    const ok = outcome === v.expect;
    if (!ok) bad += 1;
    console.log(`${ok ? "ok  " : "BAD "} ${v.name}
     PostgreSQL ${version}: ${outcome}${signal ? ` (${signal})` : ""}; client saw: ${r.out.trim().split(/\r?\n/).filter(Boolean).slice(-1)[0]?.slice(0, 100) ?? ""}`);
    dockerTry("rm", "-f", name);
  }
  console.log(bad === 0 ? "\nreproduction confirmed (and the workaround and the newer image behave as documented)" : "\nUNEXPECTED RESULT: the documented behaviour no longer holds");
  process.exit(bad === 0 ? 0 : 1);
}

function cmdList() {
  console.log(dockerTry("ps", "-a", "--filter", `label=${LABEL}`, "--format", "{{.Names}}\t{{.Status}}\t{{.Ports}}").out);
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
function parse(argv) {
  const flags = {};
  const rest = [];
  const dd = argv.indexOf("--");
  const head = dd >= 0 ? argv.slice(0, dd) : argv;
  const tail = dd >= 0 ? argv.slice(dd + 1) : [];
  for (let i = 0; i < head.length; i += 1) {
    const a = head[i];
    if (a === "--migration") (flags.migration ??= []).push(head[++i]);
    else if (a === "--keep" || a === "--all") flags[a.slice(2)] = true;
    else if (a.startsWith("--")) flags[a.slice(2)] = head[++i];
    else rest.push(a);
  }
  return { flags, rest, tail };
}

const { flags, rest, tail } = parse(process.argv.slice(2));
const [cmd, scenario] = rest;
switch (cmd) {
  case "baseline": await cmdBaseline(flags); break;
  case "up": { if (!scenario) die("usage: up <scenario>"); const env = await cmdUp(scenario, flags); console.log(JSON.stringify(env, null, 2)); break; }
  case "run": if (!scenario) die("usage: run <scenario> [--keep] -- <vitest args>"); await cmdRun(scenario, flags, tail); break;
  case "down": if (flags.all) { for (const c of dockerTry("ps", "-a", "--filter", `label=${LABEL}`, "--format", "{{.Names}}").out.split("\n").filter(Boolean)) docker("rm", "-f", c); } else cmdDown(scenario); break;
  case "list": cmdList(); break;
  case "repro": await cmdRepro(); break;
  case "matrix": await cmdMatrix(scenario, flags); break;
  case "compare": await cmdCompare(rest[1], rest[2], flags); break;
  case "scenarios": for (const [k, v] of Object.entries(SCENARIOS)) console.log(`${k}\t${v.description}`); break;
  default: die("commands: baseline | up | run | down | list | scenarios");
}
