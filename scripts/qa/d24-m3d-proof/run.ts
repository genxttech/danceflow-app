// D24 M3-D Stripe TEST proof: command line entry.
//
//   npx tsx scripts/qa/d24-m3d-proof/run.ts --dry-run      # fake client, NO network, prints the planned call list. Needs nothing.
//   npx tsx scripts/qa/d24-m3d-proof/run.ts --print-hash   # prints the script SHA-256 the owner pins
//   npx tsx scripts/qa/d24-m3d-proof/run.ts --allow-list   # prints the allow-list
//   npx tsx scripts/qa/d24-m3d-proof/run.ts --live         # REAL Stripe TEST calls. Refuses unless EVERY owner-supplied variable below is present and valid.
//
// Live mode requires (all from the shell environment; keys are never read from a file or argv):
//   D24_PROOF_STRIPE_KEY               restricted test key rk_test_…
//   D24_PROOF_EXPECT_PLATFORM_ACCT     sandbox account id acct_…
//   D24_PROOF_EXPECT_CONNECTED_ACCT    connected test account id acct_…
//   D24_PROOF_PINNED_SHA256            must equal the manifest hash this checkout prints with --print-hash
//   D24_PROOF_AUTHORIZATION            the owner's exact approval sentence
// This revision is NOT authorized to run live. Nothing here has been run against Stripe.

import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { describeAllowList } from "./allowlist";
import { cleanup, MANUAL_CLEANUP_NOTE, type CleanupReport } from "./cleanup";
import { createFakeTransport } from "./fakeTransport";
import { createGuardedClient, HARD_CALL_CAP, type GuardedClient } from "./guarded";
import { AUTHORIZATION_PHRASE, checkEnvironment, checkKeyShape, checkPinnedIds, ENV, runIdentityGate } from "./identity";
import { manifest } from "./manifest";
import { redactText } from "./redact";
import { runScenarios, type ScenarioResult, type Verdicts } from "./scenarios";
import { createFetchTransport } from "./transport";
import { ProofAbort, type Expect, type Transport } from "./types";

const HERE = dirname(fileURLToPath(import.meta.url));
const FLAGS = new Set(["--dry-run", "--live", "--print-hash", "--allow-list", "--help"]);

export type Io = { out: (s: string) => void; sleep: (ms: number) => Promise<void> };
export type RunDeps = { env: Record<string, string | undefined>; io: Io; liveTransport?: Transport; dir?: string; runId?: string };

export function parseArgs(argv: string[]): { ok: true; flag: string } | { ok: false; reason: string } {
  const flags = argv.filter((a) => a.startsWith("-"));
  const extra = argv.filter((a) => !a.startsWith("-"));
  if (extra.length > 0) return { ok: false, reason: "positional arguments are not accepted (keys and ids come from the environment only)" };
  const unknown = flags.filter((f) => !FLAGS.has(f));
  if (unknown.length > 0) return { ok: false, reason: `unknown option ${unknown.map((u) => u.split("=")[0]).join(", ")}` };
  if (flags.length !== 1) return { ok: false, reason: "exactly one of --dry-run | --live | --print-hash | --allow-list | --help is required" };
  return { ok: true, flag: flags[0] };
}

export function liveRefusals(env: Record<string, string | undefined>, dir: string): { problems: string[]; expect?: Expect } {
  const problems: string[] = [];
  const k = checkKeyShape(env[ENV.key]);
  if (!k.ok) problems.push(`${ENV.key}: ${k.reason}`);
  const ids = checkPinnedIds(env);
  if (!ids.ok) problems.push(ids.reason);
  const pinned = env[ENV.pinnedSha] ?? "";
  const actual = manifest(dir).sha256;
  if (!/^[0-9a-f]{64}$/.test(pinned)) problems.push(`${ENV.pinnedSha} must be the 64-hex script hash printed by --print-hash`);
  else if (pinned !== actual) problems.push(`${ENV.pinnedSha} does not match this checkout's script hash (the script changed since it was pinned)`);
  if (env[ENV.phrase] !== AUTHORIZATION_PHRASE) problems.push(`${ENV.phrase} must be the owner's exact approval sentence`);
  problems.push(...checkEnvironment(env));
  return { problems, expect: ids.ok ? ids.expect : undefined };
}

function report(io: Io, client: GuardedClient, results: ScenarioResult[], verdicts: Verdicts | null, clean: CleanupReport | null, abort: ProofAbort | null) {
  io.out("\n== Transcript (redacted: id/livemode/status/total only) ==");
  for (const t of client.transcript) {
    io.out(`${String(t.n).padStart(2)}. ${t.atUtc} ${t.method} ${t.path}${t.query ? `?${t.query}` : ""} acct=${t.stripeAccount} idem=${t.idempotencyKey} -> ${t.status} req=${t.requestId}${t.replayed ? " replayed" : ""} ${JSON.stringify(t.summary)}${t.note ? ` (${redactText(t.note)})` : ""}`);
  }
  const s = client.stats();
  io.out(`\nCalls used: ${s.used} of hard cap ${HARD_CALL_CAP}; blocked before network: ${s.blocked}`);
  io.out("\n== Scenario checks ==");
  for (const r of results) {
    io.out(`${r.id} ${r.title}`);
    for (const c of r.checks) io.out(`   ${c.ok ? "PASS" : "FAIL"}  ${c.id}: ${c.detail}`);
  }
  if (verdicts) {
    io.out("\n== Verdicts (V1-V7) ==");
    for (const [k, v] of Object.entries(verdicts)) io.out(`${k}: ${v.verdict}  - ${v.basis}`);
  }
  if (abort) io.out(`\nABORTED: ${abort.code}: ${redactText(abort.message)}`);
  if (clean) {
    io.out("\n== Cleanup ==");
    io.out(JSON.stringify(clean));
    io.out(MANUAL_CLEANUP_NOTE);
  }
}

export async function runProof(argv: string[], deps: RunDeps): Promise<number> {
  const { env, io } = deps;
  const dir = deps.dir ?? HERE;
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    io.out(`refused: ${parsed.reason}`);
    return 2;
  }
  if (parsed.flag === "--help") {
    io.out("usage: run.ts --dry-run | --live | --print-hash | --allow-list   (see the header of run.ts)");
    return 0;
  }
  const m = manifest(dir);
  if (parsed.flag === "--print-hash") {
    io.out(`script manifest SHA-256: ${m.sha256}`);
    for (const f of m.files) io.out(`  ${f.sha256}  ${f.path}`);
    return 0;
  }
  if (parsed.flag === "--allow-list") {
    for (const l of describeAllowList()) io.out(l);
    return 0;
  }

  const live = parsed.flag === "--live";
  let expect: Expect;
  let transport: Transport;
  let apiKey: string;
  let runId: string;
  let waitMs: number;
  if (live) {
    const r = liveRefusals(env, dir);
    if (r.problems.length > 0 || !r.expect) {
      io.out("refused: live mode needs every owner-supplied value; nothing was sent.");
      for (const p of r.problems) io.out(`  - ${redactText(p)}`);
      return 2;
    }
    expect = r.expect;
    apiKey = env[ENV.key] as string;
    transport = deps.liveTransport ?? createFetchTransport();
    runId = deps.runId ?? Math.random().toString(16).slice(2, 10).padEnd(8, "0");
    waitMs = 5 * 60_000;
  } else {
    // dry-run: synthetic ids, a fake key string that is never a real credential, the fake transport. The environment is NOT read for a key.
    expect = { platformAcct: "acct_DRYRUNPLATFORM", connectedAcct: "acct_DRYRUNCONNECTED" };
    apiKey = "rk_test_DRYRUNFAKE";
    transport = createFakeTransport({ platformId: expect.platformAcct, connectedId: expect.connectedAcct }).transport;
    runId = "dryrun00";
    waitMs = 0;
  }

  io.out(`D24 M3-D Stripe TEST proof - ${live ? "LIVE (Stripe TEST mode)" : "DRY RUN (fake client, no network)"}`);
  io.out(`script manifest SHA-256: ${m.sha256}`);
  io.out(`pinned accounts: platform=${expect.platformAcct} connected=${expect.connectedAcct}; hard call cap ${HARD_CALL_CAP}`);

  const client = createGuardedClient({ transport, apiKey, connectedAcct: expect.connectedAcct, paceMs: live ? 250 : 0, sleep: io.sleep });
  let results: ScenarioResult[] = [];
  let verdicts: Verdicts | null = null;
  let abort: ProofAbort | null = null;
  try {
    await runIdentityGate(client, expect);
    const r = await runScenarios({ client, expect, runId, sleep: io.sleep, replayWaitMs: waitMs });
    results = r.results;
    verdicts = r.verdicts;
  } catch (e) {
    abort = e instanceof ProofAbort ? e : new ProofAbort("blocked_request", `unexpected error: ${(e as Error).message}`);
  }
  const clean = await cleanup(client, expect);
  report(io, client, results, verdicts, clean, abort);
  const failed = results.some((x) => x.checks.some((c) => !c.ok));
  return abort || failed ? 1 : 0;
}

// executed only when run directly, never when imported by the tests
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  runProof(process.argv.slice(2), {
    env: process.env,
    io: { out: (s) => process.stdout.write(`${s}\n`), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) },
  }).then((code) => process.exit(code));
}
