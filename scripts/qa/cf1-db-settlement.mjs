#!/usr/bin/env node
/**
 * CF1 database-backed settlement QA runner. LOCAL ONLY.
 *
 * Starts ONE disposable Postgres container (own name `df-cf1r1-<pid>`, own label, NO network, NO published port), applies the repo's competition
 * migrations on top of the committed local baseline image, runs the three localStack.*.cf1 vitest suites against it, and removes the container
 * (and its anonymous volume) afterwards. It never touches a hosted database, Stripe, Twilio, PostgREST/Kong, another session's container, or
 * `sb.sh`. It honours the shared heavy-job lock (C:\dfr\heavy.lock, see C:\dfr\HEAVY_LOCK_RULES.md): it waits for it, takes it atomically with
 * mkdir, writes owner.txt, and removes ONLY a lock it created itself.
 *
 *   node scripts/qa/cf1-db-settlement.mjs [run] [--keep] [--no-lock] [--out <dir>] [--image <tag>] [--skip-migrations] [--wait-minutes 45]
 *   node scripts/qa/cf1-db-settlement.mjs down            # remove leftover df-cf1r1-* containers of this tool only
 *
 * Baseline image: `df-isoqa/base:20261205090000`, built by the TW-4F isolated-QA tooling (docs/twilio/TW-4F_Isolated_QA.md): the July production
 * schema plus the repo migrations through 20261205090000 (that already contains Phase 10C finalize/release and the PAY-WH-1 claim functions).
 * Migrations above the cutoff whose name matches competition|organizer_suite|usage_addon are applied here in version order, from THIS worktree.
 *
 * Exit codes: 0 all tests passed; 1 a test failed; 3 infrastructure error; 4 BLOCKED (docker, image, migration or lock unavailable: nothing is
 * reported as passed); 2 usage.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MIGRATIONS = path.join(ROOT, "src", "lib", "supabase", "migrations");
const CUTOFF = "20261205090000";
const PREFIX = "df-cf1r1-";
const LABEL = "df.cf1r1=1";
const LOCK = process.env.HEAVY_LOCK_DIR ?? "C:\\dfr\\heavy.lock";
const SUITES = [
  "src/lib/competition/__tests__/localStack.settlementSql.cf1.test.ts",
  "src/app/api/payments/webhook/__tests__/localStack.competitionWebhook.cf1.test.ts",
  "src/lib/competition/__tests__/localStack.settlementRepair.cf1.test.ts",
];
const MIGRATION_FILTER = /competition|organizer_suite|usage_addon/;
const REQUIRED_FUNCTIONS = [
  "finalize_competition_registration(uuid,text,text,text,bigint,text)",
  "release_competition_registration(uuid,text,text,text)",
  "claim_payment_provider_event(text,text,text,text,uuid,integer)",
  "complete_payment_provider_event(text,text,uuid,text,text,text)",
];

const args = process.argv.slice(2);
const command = args[0] && !args[0].startsWith("--") ? args[0] : "run";
const flag = (name) => args.includes(name);
const option = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
if (!["run", "down"].includes(command)) { console.error("usage: cf1-db-settlement.mjs [run|down] [--keep] [--no-lock] [--out dir] [--image tag] [--wait-minutes n]"); process.exit(2); }

const image = option("--image", `df-isoqa/base:${CUTOFF}`);
const out = path.resolve(option("--out", path.join(ROOT, ".qa-out", "cf1-db-settlement")));
const name = `${PREFIX}${process.pid}`;
let lockTaken = false;
let report = { startedAt: new Date().toISOString(), container: name, image, migrations: [], preflight: {}, vitest: null, result: "BLOCKED", reason: "not started" };

const sh = (cmd, cmdArgs, input) => spawnSync(cmd, cmdArgs, { encoding: "utf8", input, maxBuffer: 1 << 28 });
const docker = (...a) => sh("docker", a);
const psql = (sql, { tuples = true } = {}) => docker("exec", "-i", "-e", "PGPASSWORD=postgres", name, "psql", "-U", "postgres", "-d", "postgres", "-X", "-q", "-v", "ON_ERROR_STOP=1", ...(tuples ? ["-At"] : []), "-c", sql);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function finish(code, result, reason) {
  report.result = result; report.reason = reason; report.finishedAt = new Date().toISOString();
  try { mkdirSync(out, { recursive: true }); writeFileSync(path.join(out, "report.json"), JSON.stringify(report, null, 2)); } catch { /* best effort */ }
  console.log(`\nCF1 DB settlement QA: ${result}${reason ? ` (${reason})` : ""}`);
  process.exitCode = code;
}

function removeContainers(onlyThis) {
  const list = docker("ps", "-a", "--filter", `label=${LABEL}`, "--format", "{{.Names}}");
  for (const n of list.stdout.split(/\s+/).filter(Boolean)) {
    if (!n.startsWith(PREFIX)) continue; // belt and braces: never remove anything without our prefix
    if (onlyThis && n !== name) continue;
    docker("rm", "-f", "-v", n);
  }
}

async function takeLock() {
  if (flag("--no-lock")) return true;
  const deadline = Date.now() + Number(option("--wait-minutes", "45")) * 60_000;
  for (;;) {
    try { mkdirSync(LOCK); lockTaken = true; break; } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let owner = "unknown owner";
      try { owner = readFileSync(path.join(LOCK, "owner.txt"), "utf8").trim(); } catch { /* ignore */ }
      if (Date.now() > deadline) { console.error(`heavy lock still held after the wait: ${owner}`); return false; }
      console.log(`heavy lock held (${owner}); retrying in 60 s`);
      await sleep(60_000);
    }
  }
  writeFileSync(path.join(LOCK, "owner.txt"), `cf1-r1-db-settlement session (isolated Postgres ${name} + vitest localStack.*.cf1); start ${new Date().toISOString()}; ~25 min (own container, serial vitest, no emulator or Gradle)\n`);
  return true;
}
function releaseLock() {
  if (!lockTaken) return;
  try { rmSync(LOCK, { recursive: true, force: true }); } catch { /* ignore */ }
  lockTaken = false;
}
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { removeContainers(true); releaseLock(); process.exit(130); });

async function main() {
  if (command === "down") { removeContainers(false); console.log("removed leftover df-cf1r1-* containers"); return; }

  if (docker("version", "--format", "{{.Server.Version}}").status !== 0) return finish(4, "BLOCKED", "docker daemon is not reachable");
  if (docker("image", "inspect", image).status !== 0) return finish(4, "BLOCKED", `baseline image ${image} is missing (build it with the TW-4F isolated-QA tooling, docs/twilio/TW-4F_Isolated_QA.md)`);
  if (!(await takeLock())) return finish(4, "BLOCKED", "shared heavy lock unavailable");

  console.log(`starting ${name} from ${image} (no network, no published ports)`);
  const run = docker("run", "-d", "--name", name, "--label", LABEL, "--network", "none", "--memory", "1536m", "--cpus", "2", "-e", "POSTGRES_PASSWORD=postgres", image, "postgres", "-D", "/etc/postgresql", "-c", "supautils.hint_roles=");
  if (run.status !== 0) return finish(3, "BLOCKED", `docker run failed: ${run.stderr.trim()}`);
  let ready = false;
  for (let i = 0; i < 90 && !ready; i += 1) { ready = docker("exec", name, "pg_isready", "-U", "postgres").status === 0 && psql("select 1").status === 0; if (!ready) await sleep(1000); }
  if (!ready) return finish(3, "BLOCKED", "postgres did not become ready");

  // migrations above the cutoff that matter for competition settlement, in version order, from this worktree
  const files = flag("--skip-migrations") ? [] : readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql") && /^\d{14}_/.test(f) && f.slice(0, 14) > CUTOFF && MIGRATION_FILTER.test(f)).sort();
  for (const file of files) {
    const sql = readFileSync(path.join(MIGRATIONS, file), "utf8");
    const r = sh("docker", ["exec", "-i", "-e", "PGPASSWORD=postgres", name, "psql", "-U", "postgres", "-d", "postgres", "-X", "-q", "-v", "ON_ERROR_STOP=1"], sql);
    const ok = r.status === 0;
    report.migrations.push({ file, ok, error: ok ? undefined : (r.stderr.match(/ERROR:[^\n]*/)?.[0] ?? r.stderr.slice(0, 200)) });
    console.log(`${ok ? "applied " : "FAILED  "} ${file}`);
  }

  // preflight: the functions under test must exist, and service_role must be allowed to call them
  for (const sig of REQUIRED_FUNCTIONS) {
    const r = psql(`select to_regprocedure('public.${sig}') is not null and has_function_privilege('service_role', to_regprocedure('public.${sig}'), 'execute')`);
    report.preflight[sig] = r.stdout.trim() === "t";
  }
  const missing = Object.entries(report.preflight).filter(([, ok]) => !ok).map(([sig]) => sig);
  if (missing.length) return finish(4, "BLOCKED", `required functions missing or not executable by service_role: ${missing.join(", ")}`);
  const failedMigrations = report.migrations.filter((m) => !m.ok);
  if (failedMigrations.length) return finish(4, "BLOCKED", `${failedMigrations.length} competition migration(s) failed to apply (${failedMigrations.map((m) => m.file).join(", ")}); a stale function could be under test`);
  // clock skew between host and container would shift the repair age windows
  const dbNow = Number(psql("select extract(epoch from now())::bigint").stdout.trim());
  if (!Number.isFinite(dbNow) || Math.abs(dbNow - Date.now() / 1000) > 60) return finish(4, "BLOCKED", `host/container clock skew ${Math.round(dbNow - Date.now() / 1000)} s exceeds 60 s`);

  console.log("running vitest (serial; one database, real concurrent connections inside the tests)");
  mkdirSync(out, { recursive: true });
  const vitest = path.join(ROOT, "node_modules", "vitest", "vitest.mjs");
  if (!existsSync(vitest)) return finish(4, "BLOCKED", "node_modules/vitest is missing in this worktree (run npm ci in the worktree itself, never through a junction)");
  const jsonOut = path.join(out, "vitest.json");
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [vitest, "run", "--no-file-parallelism", "--reporter=default", "--reporter=json", `--outputFile.json=${jsonOut}`, ...SUITES], {
      cwd: ROOT, stdio: "inherit", env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(SUPABASE|NEXT_PUBLIC_SUPABASE|STRIPE|TWILIO|CRON_SECRET|COMPETITION_SETTLEMENT)/.test(k))), CF1_DBQA_CONTAINER: name },
    });
    child.on("close", (c) => resolve(c ?? 1));
  });
  if (flag("--tsc")) {
    // full typecheck inside the same lock window (also a heavy job)
    const tscBin = path.join(ROOT, "node_modules", "typescript", "bin", "tsc");
    report.tsc = await new Promise((resolve) => {
      const child = spawn(process.execPath, [tscBin, "--noEmit"], { cwd: ROOT, stdio: "inherit", env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=8192" } });
      child.on("close", (c) => resolve({ exitCode: c ?? 1 }));
    });
  }
  let summary = null;
  try { const j = JSON.parse(readFileSync(jsonOut, "utf8")); summary = { total: j.numTotalTests, passed: j.numPassedTests, failed: j.numFailedTests, skipped: j.numPendingTests + (j.numTodoTests ?? 0) }; } catch { /* no json */ }
  report.vitest = { exitCode: code, ...summary };
  if (!summary || summary.total === 0 || summary.skipped > 0 || summary.passed === 0) return finish(4, "BLOCKED", "vitest ran nothing, or skipped tests (a skipped suite is BLOCKED, never PASSED)");
  if (code !== 0 || summary.failed > 0) return finish(1, "FAIL", `${summary.failed} failed of ${summary.total}`);
  finish(0, "PASS", `${summary.passed}/${summary.total} passed against ${name}${failedMigrations.length ? ` (${failedMigrations.length} migration warning(s))` : ""}`);
}

try { await main(); } catch (error) { finish(3, "BLOCKED", String(error?.message ?? error)); } finally {
  if (!flag("--keep") && command === "run") removeContainers(true);
  if (command === "run") releaseLock();
}
