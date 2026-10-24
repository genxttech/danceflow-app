/**
 * TW-4 mock-brand validation, STAGES B and C: a person-operated harness for ONE non-pilot test studio in the LOCAL QA Supabase stack.
 * Never run by the application, never from CI, never against shared DEV or PROD (the database must be loopback).
 *
 *   npx tsx --tsconfig scripts/tw4-validation/tsconfig.json scripts/tw4-validation/stage-bc.ts <command> [options]
 *
 * Commands
 *   seed      --business <json>       create the local test studio + owner + platform admin, pilot switch on (LOCAL db only), save the
 *                                     wizard fields from the JSON file, store the EIN (encrypted with a throwaway local key) and submit.
 *                                     The EIN comes from TW4_VALIDATION_EIN or a hidden prompt; it is never printed or written in clear.
 *   run       --stages B | C        --confirm-studio <studio uuid printed by seed> [--adapter fake]   (real is RETIRED: refused by legacyGuard.ts) [--forbid <uuid,..>] [--hours 1|2] [--out file]
 *   authorize-b [--minutes 30]       RETIRED (real adapter only, now always refused): was the explicit Stage B authorization (binds studio, expiry, mailbox, key SID, Primary profile)
 *   authorize-c [--minutes 60]       after READING the stage B report: prints the short-lived stage C authorization (needs S1-S10 succeeded)
 *   evidence                          print the ledger (step, status, provider sid, mock flag) for the test studio: the cleanup inventory
 *   cleanup                           cancel the onboarding (erases the EIN), delete the local fixtures and the throwaway key
 *
 * Local stack variables (same as the R1 dry run): TW4A_LOCAL_URL, TW4A_LOCAL_JWT_SECRET, TW4A_LOCAL_DB_CONTAINER.
 * Adapter `fake` (default) is in-process and needs TW4_ISV_FAKE=on. Adapter `real` is RETIRED (parent-account harness; studios use subaccounts): any other
 * `--adapter` value is refused before every command (legacyGuard.ts).
 * NOTE: one stage per invocation. The fake adapter keeps its Twilio state in memory, so a fake stage C started in a new process cannot find
 * stage B's fake resources (it stops with a harmless exception); the Stage C gate itself is covered by the unit tests.
 * Stage C additionally needs --stage-c-token and --stage-c-expires from `authorize-c`; without them it is refused (src/.../validation/stage.ts).
 * Every stage is refused unless the guards in src/lib/sms/twilioIsv/validation/stage.ts hold (typed studio confirmation, not a forbidden
 * studio, loopback database, mock-brand switch on, 1-2 hour window that is always closed again).
 */
import { ADAPTER_KIND } from "./fence"; // MUST stay the first import: installs the network fence before any other module loads
import { execFileSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { cancelOnboarding, saveOnboardingDraft, setPilotAccess, storeEinCiphertext, submitOnboarding } from "@/lib/sms/onboarding/client";
import { encryptEin } from "@/lib/sms/onboarding/ein";
import { DRAFT_FIELD_KEYS, normalizeEin, validateDraftFields } from "@/lib/sms/onboarding/fields";
import { loadIsvConfig, type IsvConfig } from "@/lib/sms/twilioIsv/config";
import { isLoopbackHost } from "@/lib/sms/twilioIsv/loopback";
import { FakeIsvAdapter } from "@/lib/sms/twilioIsv/fake";
import { createRealIsvAdapter } from "@/lib/sms/twilioIsv/real";
import { legacyRealModeRefusal } from "./legacyGuard";
import { SupabaseRunnerStore } from "@/lib/sms/twilioIsv/store";
import { issueStageBAuthorization, issueStageCAuthorization, runValidationStage, type LedgerRow, type StageName, type StageReport } from "@/lib/sms/twilioIsv/validation/stage";

const OWNER = "7a1d0000-0000-4000-8000-000000000101";
const PADMIN = "7a1d0000-0000-4000-8000-000000000401";
const FAKE_PRIMARY = `BU${"f".repeat(32)}`;
const FAKE_POLICY = `RN${"f".repeat(32)}`;

const URL_ = process.env.TW4A_LOCAL_URL ?? "";
const JWT_SECRET = process.env.TW4A_LOCAL_JWT_SECRET ?? "";
const PG = process.env.TW4A_LOCAL_DB_CONTAINER ?? "";
const KEY_FILE = process.env.TW4_VALIDATION_KEY_FILE ?? join(tmpdir(), "tw4-validation-local-ein.key");
const STUDIO_FILE = `${KEY_FILE}.studio`;
const UUID_RE = /^7a1d0000-0000-4000-8000-[0-9a-f]{12}$/;

/**
 * The test studio id is generated fresh by every `seed` (and stored beside the key file). Resource names embed it, so a later seed
 * can never find, adopt and build on the Twilio resources of an earlier one (they might already be submitted for review).
 */
function studioId(): string {
  if (!existsSync(STUDIO_FILE)) throw new Error("No test studio: run `seed` first.");
  const value = readFileSync(STUDIO_FILE, "utf8").trim();
  if (!UUID_RE.test(value)) throw new Error("The stored test studio id is malformed; run `cleanup` and seed again.");
  return value;
}

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
function sign(payload: Record<string, unknown>) {
  const head = `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}`;
  return `${head}.${createHmac("sha256", JWT_SECRET).update(head).digest("base64url")}`;
}
const service = () => sign({ iss: "supabase-demo", role: "service_role", exp: 1983812996 });
const anon = () => sign({ iss: "supabase-demo", role: "anon", exp: 1983812996 });
const userJwt = (sub: string) => sign({ sub, role: "authenticated", aud: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600 });
const client = (token: string | null, key: string): SupabaseClient =>
  createClient(URL_, key, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: token ? { Authorization: `Bearer ${token}` } : {} } });
const psqlFile = (sql: string) => execFileSync("docker", ["exec", "-i", PG, "psql", "-U", "postgres", "-q", "-v", "ON_ERROR_STOP=1"], { input: sql, encoding: "utf8" });
const psql = (sql: string) => execFileSync("docker", ["exec", "-i", PG, "psql", "-U", "postgres", "-At", "-v", "ON_ERROR_STOP=1", "-c", sql], { encoding: "utf8" }).trim();

/** True once a stage has begun (Twilio calls may have been made). A refusal BEFORE this point is exit code 2; anything after it is 1. */
let stageStarted = false;

function arg(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

/** --out must have a value, must not look like a flag, and must not overwrite an existing file. */
function outPath(): string | null {
  const index = process.argv.indexOf("--out");
  if (index < 0) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error("--out needs a file path.");
  if (existsSync(value)) throw new Error("--out refuses to overwrite an existing file.");
  return value;
}

function requireLocalStack() {
  let host = "";
  try {
    host = new URL(URL_).hostname;
  } catch {
    /* handled below */
  }
  if (!URL_ || !JWT_SECRET || !PG || !isLoopbackHost(host)) {
    throw new Error("Set TW4A_LOCAL_URL (loopback), TW4A_LOCAL_JWT_SECRET and TW4A_LOCAL_DB_CONTAINER for the LOCAL QA stack.");
  }
  // The database is reached through `docker exec`, so the URL check alone does not protect it: pin the container to the local QA stack and
  // refuse a remote docker daemon / non-default context.
  if (!/^supabase_db_danceflow-e2e-qa$/.test(PG)) throw new Error("TW4A_LOCAL_DB_CONTAINER must be the local QA database container (supabase_db_danceflow-e2e-qa).");
  if (process.env.DOCKER_HOST) throw new Error("DOCKER_HOST is set: a remote docker daemon is not allowed; the harness uses the local docker engine only.");
  // The active docker context must point at a LOCAL engine (a named pipe on Windows, a unix socket elsewhere). Docker Desktop's local
  // engine uses a context called "desktop-linux", so the endpoint is checked, not the name.
  let dockerEndpoint = "";
  try {
    dockerEndpoint = execFileSync("docker", ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"], { encoding: "utf8" }).trim();
  } catch {
    throw new Error("Docker is not available.");
  }
  if (!(dockerEndpoint.startsWith("npipe:////./pipe/") || dockerEndpoint.startsWith("unix:///"))) throw new Error("The active docker context points at a non-local engine (" + dockerEndpoint + "); switch to the local engine first.");
  process.env.NEXT_PUBLIC_SUPABASE_URL = URL_;
}

function loadLocalKey(create: boolean) {
  if (!existsSync(KEY_FILE)) {
    if (!create) throw new Error("No local EIN key: run `seed` first.");
    writeFileSync(KEY_FILE, randomBytes(32).toString("base64"), { encoding: "utf8", mode: 0o600 });
  }
  process.env.SMS_EIN_ENCRYPTION_KEY = readFileSync(KEY_FILE, "utf8").trim();
  delete process.env.SMS_EIN_ENCRYPTION_KEY_ID;
}

/** Hidden prompt: the typed characters are not echoed. */
function readHidden(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const write = (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput;
    process.stdout.write(prompt);
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = () => undefined;
    rl.question("", (answer) => {
      (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = write;
      process.stdout.write("\n");
      rl.close();
      resolve(answer.trim());
    });
  });
}

const FIXTURE_ALL = (insert: boolean, STUDIO: string) => `
begin;
delete from public.studio_sms_registrations where studio_id = '${STUDIO}';
delete from public.studios where id = '${STUDIO}';
delete from auth.users where id in ('${OWNER}', '${PADMIN}');
${insert ? `
insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at) values
  ('${OWNER}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner@tw4-validation.test', now(), now()),
  ('${PADMIN}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'padmin@tw4-validation.test', now(), now());
insert into public.profiles (id, platform_role) values ('${OWNER}', null), ('${PADMIN}', 'platform_admin')
  on conflict (id) do update set platform_role = excluded.platform_role;
insert into public.studios (id, name, slug, public_name) values ('${STUDIO}', 'TW4 Validation Studio', 'tw4-validation', null);
insert into public.user_studio_roles (user_id, studio_id, role, active) values ('${OWNER}', '${STUDIO}', 'studio_owner', true);` : ""}
commit;`;

async function seed() {
  requireLocalStack();
  const file = arg("--business");
  if (!file) throw new Error("--business <json file> is required (non-secret wizard fields; the EIN is asked separately).");
  let business: Record<string, string>;
  try {
    business = JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
  } catch {
    throw new Error("The business file could not be read as JSON.");
  }
  const einText = process.env.TW4_VALIDATION_EIN?.trim() || (process.stdin.isTTY ? await readHidden("EIN (hidden): ") : "");
  delete process.env.TW4_VALIDATION_EIN; // do not leave the EIN in the environment inherited by child processes
  const ein = normalizeEin(einText);
  if (!ein.ok) throw new Error("A valid 9-digit EIN is required (TW4_VALIDATION_EIN or the hidden prompt).");
  const { fields, errors } = validateDraftFields(Object.fromEntries(DRAFT_FIELD_KEYS.map((key) => [key, String(business[key] ?? "")])));
  if (Object.keys(errors).length > 0) throw new Error(`Business file has invalid fields: ${Object.keys(errors).join(", ")}`);
  if (existsSync(STUDIO_FILE)) throw new Error("A test studio already exists: run `cleanup` before seeding again.");
  loadLocalKey(true);
  const STUDIO = `7a1d0000-0000-4000-8000-${randomBytes(6).toString("hex")}`;
  writeFileSync(STUDIO_FILE, STUDIO, { encoding: "utf8", mode: 0o600 });
  psqlFile(FIXTURE_ALL(true, STUDIO));
  if (process.env.TW4_TEST_SEED_FAIL === "1" && process.env.TW4_ISV_FAKE === "on" && process.env.NODE_ENV !== "production") throw new Error("test seam: simulated seed failure after the marker was written");
  const admin = client(null, service());
  await setPilotAccess(client(userJwt(PADMIN), anon()) as never, STUDIO, true, "tw4 validation test studio (local database only)");
  const owner = client(userJwt(OWNER), anon());
  const saved = await saveOnboardingDraft(owner as never, STUDIO, fields);
  const encrypted = encryptEin(STUDIO, { digits: ein.digits, last4: ein.last4 });
  await storeEinCiphertext(admin as never, { studioId: STUDIO, actorUserId: OWNER, ciphertext: encrypted.ciphertext, keyId: encrypted.keyId, last4: encrypted.last4 });
  const submitted = await submitOnboarding(owner as never, STUDIO, { authorized: true, accurate: true, opt_in_only: true, fees_terms: true });
  process.stdout.write(`${JSON.stringify({ studio: STUDIO, missing: saved.missing, submitted: submitted.submitted, state: submitted.state, einLast4: ein.last4 })}\n`);
}

function stageCAuthorization(): { token: string; expiresAt: string } | undefined {
  const token = arg("--stage-c-token");
  const expiresAt = arg("--stage-c-expires");
  return token && expiresAt ? { token, expiresAt } : undefined;
}

function readLedger(STUDIO: string): LedgerRow[] {
  const raw = psql(`select coalesce(json_agg(r), '[]'::json) from (select step_key, status, provider_sid, submission_seq as seq from public.studio_sms_provisioning_steps where studio_id = '${STUDIO}') r`);
  return JSON.parse(raw) as LedgerRow[];
}

/**
 * The REAL-adapter authorizations are issued only by a person at an interactive terminal who types a confirmation phrase naming the studio.
 * An automated session or a script cannot satisfy this (no TTY, no typed phrase).
 */
async function requireHuman(action: string, studio: string): Promise<void> {
  // The prompt goes to STDERR and the check uses stdin + stderr, so a launcher can capture the JSON on stdout while the person still sees and answers the prompt.
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    throw new Error(`${action} can only be authorized by a person in an interactive terminal (it asks for a typed confirmation); it cannot run non-interactively.`);
  }
  const phrase = `I authorize ${action} for ${studio}`;
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  const answer = await new Promise<string>((resolve) => rl.question(`Type exactly the following to continue:\n  ${phrase}\n> `, (a) => { rl.close(); resolve(a.trim()); }));
  if (answer !== phrase) throw new Error("The confirmation did not match; nothing was authorized.");
}

function stageBAuthorization(): { token: string; expiresAt: string } | undefined {
  const token = arg("--stage-b-token");
  const expiresAt = arg("--stage-b-expires");
  return token && expiresAt ? { token, expiresAt } : undefined;
}

async function authorizeB() {
  requireLocalStack();
  if (ADAPTER_KIND !== "real") throw new Error("authorize-b is only for the real adapter, which is retired; the fake adapter needs no authorization.");
  const STUDIO = studioId();
  const secret = readFileSync(KEY_FILE, "utf8").trim();
  const loaded = loadIsvConfig(process.env);
  if (!loaded.ok) throw new Error(`Twilio configuration incomplete (missing: ${loaded.missing.join(", ")}).`);
  await requireHuman("real Twilio draft writes (stage B, steps S1-S10 only)", STUDIO);
  const issued = issueStageBAuthorization({ secret, studioId: STUDIO, config: loaded.config, minutes: Number(arg("--minutes") ?? "30") });
  if (!issued.ok) throw new Error(`Not authorized: ${issued.reason}`);
  process.stdout.write(`${JSON.stringify({ studio: STUDIO, "stage-b-token": issued.authorization.token, "stage-b-expires": issued.authorization.expiresAt })}\n`);
}

async function authorizeC() {
  requireLocalStack();
  const STUDIO = studioId();
  const secret = readFileSync(KEY_FILE, "utf8").trim();
  const { config } = buildAdapter(ADAPTER_KIND);
  if (ADAPTER_KIND === "real") await requireHuman("stage C (submission to Twilio review, MOCK brand)", STUDIO);
  const issued = issueStageCAuthorization({ secret, studioId: STUDIO, ledger: readLedger(STUDIO), config, minutes: Number(arg("--minutes") ?? "60") });
  if (!issued.ok) throw new Error(`Not authorized: ${issued.reason}`);
  process.stdout.write(`${JSON.stringify({ studio: STUDIO, "stage-c-token": issued.authorization.token, "stage-c-expires": issued.authorization.expiresAt })}\n`);
}

function buildAdapter(kind: string): { adapter: FakeIsvAdapter | ReturnType<typeof createRealIsvAdapter>; config: IsvConfig } {
  if (kind === "fake") {
    const config: IsvConfig = {
      accountSid: `AC${"0".repeat(32)}`, authToken: "fake", primaryProfileSid: FAKE_PRIMARY, primaryProfilePolicySid: FAKE_POLICY, secondaryProfilePolicySid: `RN${"0".repeat(32)}`,
      a2pPolicySid: `RN${"0".repeat(32)}`, complianceEmail: "sms-compliance@fake.invalid", envName: "development", mockBrand: String(process.env.TW4_ISV_MOCK_BRAND ?? "") === "on",
    };
    return { adapter: new FakeIsvAdapter(FAKE_PRIMARY, { primaryPolicySid: FAKE_POLICY }), config };
  }
  const loaded = loadIsvConfig(process.env);
  if (!loaded.ok) throw new Error(`Twilio configuration incomplete (missing: ${loaded.missing.join(", ")}).`);
  // Decision D1: the validation harness signs with a Standard API key only; the auth token is never used here, not even as a fallback.
  if (!loaded.config.apiKeySid) throw new Error("The validation harness requires a Standard API key (TWILIO_ISV_API_KEY_SID / TWILIO_ISV_API_KEY_SECRET); the auth token is not permitted.");
  return { adapter: createRealIsvAdapter(loaded.config, process.env), config: loaded.config };
}

async function run() {
  requireLocalStack();
  const out = outPath(); // validated BEFORE anything is run: a bad path must not lose a report after the side effects
  const STUDIO = studioId();
  const kind = ADAPTER_KIND;
  const stages = (arg("--stages") ?? "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean) as StageName[];
  if (stages.length !== 1 || (stages[0] !== "B" && stages[0] !== "C")) throw new Error("--stages must be exactly one of B or C: run one stage per invocation and read its report before starting the next.");
  loadLocalKey(false);
  const { adapter, config } = buildAdapter(kind);
  const store = new SupabaseRunnerStore(client(null, service()));
  const reports: StageReport[] = [];
  // Ctrl-C mid-run: close the window before exiting (the database expiry is only the backstop).
  const closeWindowAndExit = () => {
    void store.setWindow(STUDIO, PADMIN, 0, "tw4 validation interrupted").catch(() => undefined).finally(() => process.exit(130));
  };
  // Ctrl-C, a closed console window, Ctrl-Break (Windows) and a termination request all close the window before exiting.
  for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK", "SIGHUP"] as const) process.once(signal, closeWindowAndExit);
  for (const stage of stages) {
    stageStarted = true;
    const outcome = await runValidationStage({
      guard: {
        stage, studioId: STUDIO, confirmStudioId: arg("--confirm-studio") ?? "",
        forbiddenStudioIds: (arg("--forbid") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
        supabaseUrl: URL_, adapterKind: kind, config, windowHours: Number(arg("--hours") ?? "1"), env: process.env,
      },
      store, adapter, actorId: PADMIN,
      readLedger: async () => readLedger(STUDIO),
      stageB: stage === "B" && kind === "real" ? { secret: readFileSync(KEY_FILE, "utf8").trim(), authorization: stageBAuthorization() } : undefined,
      stageC: stage === "C" ? { secret: readFileSync(KEY_FILE, "utf8").trim(), authorization: stageCAuthorization() } : undefined,
    });
    if (!outcome.ok) {
      stageStarted = false; // refused by a guard: nothing was sent
      throw new Error(`Refused: ${outcome.reason}`);
    }
    reports.push(outcome.report);
    const result = outcome.report.result;
    const cleanEnd = stage === "B" ? result.outcome === "retry_later" && result.detail === "step_limit" : result.outcome === "brand_submitted" || result.outcome === "brand_in_review";
    if (!cleanEnd) {
      process.stderr.write(`Stage ${stage} did NOT end cleanly (outcome: ${result.outcome}${result.detail ? `, ${result.detail}` : ""}); exit code 1. Read the report before doing anything else.\n`);
      process.exitCode = 1;
    }
    if (!outcome.report.windowClosed) {
      process.stderr.write("WARNING: the runner window could NOT be confirmed closed; close it with hours=0 or wait for its expiry.\n");
      process.exitCode = 1;
      break;
    }
  }
  const text = `${JSON.stringify({ reports }, null, 2)}\n`;
  if (out) writeFileSync(out, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
  process.stdout.write(out ? `Report written to ${out}\n` : text);
}

function evidenceJson(STUDIO: string): string {
  return psql(`select coalesce(json_agg(r order by r.submission_seq, r.created_at), '[]'::json) from (select submission_seq, created_at, step_key, status, provider_sid, friendly_name, mock, fee_bearing from public.studio_sms_provisioning_steps where studio_id = '${STUDIO}') r`);
}

function evidence() {
  requireLocalStack();
  if (process.env.TW4_TEST_EVIDENCE_FAIL === "1" && process.env.TW4_ISV_FAKE === "on" && process.env.NODE_ENV !== "production") throw new Error("test seam: simulated evidence read failure");
  process.stdout.write(`${evidenceJson(studioId())}\n`);
}

async function cleanup() {
  requireLocalStack();
  if (!existsSync(STUDIO_FILE)) {
    process.stdout.write(`${JSON.stringify({ cleaned: true, note: "no test studio was seeded" })}\n`);
    rmSync(KEY_FILE, { force: true });
    return;
  }
  const STUDIO = studioId();
  // The ledger is the ONLY inventory of the Twilio resources this studio created. Cleanup deletes it, so it first requires the inventory
  // to be saved (to a NEW file) whenever any provider SID exists.
  const rowCount = Number(psql(`select count(*) from public.studio_sms_provisioning_steps where studio_id = '${STUDIO}'`));
  const sidCount = Number(psql(`select count(*) from public.studio_sms_provisioning_steps where studio_id = '${STUDIO}' and provider_sid is not null`));
  if (rowCount > 0) {
    const evidenceFile = arg("--evidence-file");
    if (!evidenceFile || evidenceFile.startsWith("--")) {
      throw new Error(`Cleanup refused: the ledger holds ${rowCount} row(s) (${sidCount} with a Twilio SID; rows without one still carry the friendly name that locates an orphaned resource) and cleanup deletes it. Pass --evidence-file <NEW file> to save the inventory first.`);
    }
    try {
      writeFileSync(evidenceFile, `${evidenceJson(STUDIO)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    } catch {
      throw new Error("Cleanup refused: the evidence file could not be created (it must be a NEW file in an existing folder).");
    }
    process.stdout.write(`Evidence saved to ${evidenceFile}\n`);
  }
  try {
    await cancelOnboarding(client(userJwt(OWNER), anon()) as never, STUDIO);
  } catch {
    /* already cancelled or never seeded */
  }
  psqlFile(FIXTURE_ALL(false, STUDIO));
  const left = psql(`select (select count(*) from public.studios where id = '${STUDIO}') + (select count(*) from public.studio_sms_onboarding where studio_id = '${STUDIO}') + (select count(*) from public.studio_sms_provisioning_steps where studio_id = '${STUDIO}')`);
  const cleaned = left === "0";
  // keep the key (and the studio marker) unless the database is verified clean: without the key a stored EIN could no longer be decrypted or audited
  if (cleaned) {
    rmSync(KEY_FILE, { force: true });
    rmSync(STUDIO_FILE, { force: true });
  } else {
    process.exitCode = 1;
  }
  process.stdout.write(`${JSON.stringify({ cleaned, keyFileRemoved: !existsSync(KEY_FILE) })}\n`);
}

async function main() {
  // Real mode of this legacy harness is retired (legacyGuard.ts): refuse before ANY command, including the ones that only prepare a real run.
  const refusal = legacyRealModeRefusal(process.argv.slice(2));
  if (refusal) throw new Error(refusal);
  const command = process.argv[2];
  if (command === "seed") await seed();
  else if (command === "run") await run();
  else if (command === "authorize-b") await authorizeB();
  else if (command === "authorize-c") await authorizeC();
  else if (command === "evidence") evidence();
  else if (command === "cleanup") await cleanup();
  else throw new Error("Usage: stage-bc.ts seed|run|authorize-b|authorize-c|evidence|cleanup");
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "failed"}\n`);
  if (stageStarted) process.stderr.write("The stage had already started: Twilio calls may have been made. Read the ledger (evidence command) before doing anything else.\n");
  // 2 = refused or failed BEFORE any stage started (nothing was sent); 1 = something went wrong after a stage started.
  process.exitCode = stageStarted ? 1 : 2;
});
