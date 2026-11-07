// D24 M3-D Stripe TEST proof: command line entry.
//
//   npx tsx scripts/qa/d24-m3d-proof/run.ts --dry-run      # fake client, NO network, prints the planned call list. Needs nothing.
//   npx tsx scripts/qa/d24-m3d-proof/run.ts --preflight    # local checks only (no Stripe call); prints MANUAL items the owner must confirm
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
// Optional: D24_PROOF_EVIDENCE_DIR (absolute, OUTSIDE the repository) writes a redacted evidence pack there.
// This revision is NOT authorized to run live. Nothing here has been run against Stripe.

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describeAllowList } from "./allowlist";
import { cleanup, MANUAL_CLEANUP_NOTE, type CleanupReport } from "./cleanup";
import { createFakeTransport } from "./fakeTransport";
import { createGuardedClient, HARD_CALL_CAP, type GuardedClient } from "./guarded";
import { ENV, runIdentityGate, type ConnectedFacts, type ConnectedObserved } from "./identity";
import { defaultDockerProbe, liveRefusals, runPreflight, type DockerProbe } from "./preflight";
import { EVIDENCE_ENV, evidenceDirProblem, sanitize, writeEvidence } from "./evidence";
import { STRIPE_API_VERSION } from "./config";
import { manifest } from "./manifest";
import { redactText } from "./redact";
import { runScenarios, type ScenarioResult, type Verdicts } from "./scenarios";
import { createNodeTransport } from "./transport";
import { ProofAbort, type Expect, type Transport } from "./types";

const HERE = dirname(fileURLToPath(import.meta.url));
const FLAGS = new Set(["--dry-run", "--live", "--preflight", "--print-hash", "--allow-list", "--help"]);

export { liveRefusals };

export type Io = { out: (s: string) => void; sleep: (ms: number) => Promise<void> };
export type RunDeps = { env: Record<string, string | undefined>; io: Io; liveTransport?: Transport; dir?: string; runId?: string; shouldStop?: () => boolean; docker?: DockerProbe; now?: () => Date; onClient?: (c: GuardedClient) => void };

export function parseArgs(argv: string[]): { ok: true; flag: string } | { ok: false; reason: string } {
  const flags = argv.filter((a) => a.startsWith("-"));
  const extra = argv.filter((a) => !a.startsWith("-"));
  if (extra.length > 0) return { ok: false, reason: "positional arguments are not accepted (keys and ids come from the environment only)" };
  const unknown = flags.filter((f) => !FLAGS.has(f));
  if (unknown.length > 0) return { ok: false, reason: redactText(`unknown option ${unknown.map((u) => u.split("=")[0].slice(0, 24)).join(", ")}`) };
  if (flags.length !== 1) return { ok: false, reason: "exactly one of --dry-run | --live | --preflight | --print-hash | --allow-list | --help is required" };
  return { ok: true, flag: flags[0] };
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
  const { env } = deps;
  const dir = deps.dir ?? HERE;
  const repoRoot = join(dir, "..", "..", "..");
  const lines: string[] = [];
  // everything printed is also kept (sanitised at write time) for the optional evidence pack
  // (secrets removed and account ids masked in EVERY printed line, so the terminal and the files carry the same sanitised text)
  const io: Io = { sleep: deps.io.sleep, out: (s) => { const c = sanitize(s); lines.push(c); deps.io.out(c); } };
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    io.out(`refused: ${parsed.reason}`);
    return 2;
  }
  if (parsed.flag === "--help") {
    io.out("usage: run.ts --dry-run | --live | --preflight | --print-hash | --allow-list   (see the header of run.ts)");
    return 0;
  }
  const m = manifest(dir);
  if (parsed.flag === "--print-hash") {
    io.out(`script manifest SHA-256: ${m.sha256}`);
    io.out(`files: ${m.files.length}`);
    for (const f of m.files) io.out(`  ${f.sha256}  ${f.path}`);
    return 0;
  }
  if (parsed.flag === "--allow-list") {
    io.out(`Stripe-Version required on every request: ${STRIPE_API_VERSION}`);
    for (const l of describeAllowList()) io.out(l);
    return 0;
  }
  if (parsed.flag === "--preflight") {
    const checks = await runPreflight(env, dir, deps.docker ?? defaultDockerProbe);
    for (const c of checks) io.out(`${c.status.toUpperCase().padEnd(6)} ${c.id}: ${redactText(c.detail)}`);
    const bad = checks.filter((c) => c.status === "fail").length;
    const evProblem = evidenceDirProblem(env[EVIDENCE_ENV], repoRoot);
    if (evProblem) io.out(`FAIL   evidence-dir: ${evProblem}`);
    io.out(bad === 0 && !evProblem ? "preflight: no local check failed (MANUAL items are for the owner to confirm; they are not passed)" : "preflight: FAILED, a live run would refuse");
    return bad === 0 && !evProblem ? 0 : 2;
  }

  const live = parsed.flag === "--live";
  let expect: Expect;
  let transport: Transport;
  let apiKey: string;
  let runId: string;
  let waitMs: number;
  if (live) {
    const r = liveRefusals(env, dir);
    const pf = (await runPreflight(env, dir, deps.docker ?? defaultDockerProbe)).filter((c) => c.status === "fail" && c.id !== "owner-values");
    const evProblem = evidenceDirProblem(env[EVIDENCE_ENV], repoRoot);
    if (r.problems.length > 0 || !r.expect || pf.length > 0 || evProblem) {
      io.out("refused: live mode needs every owner-supplied value and a clean local preflight; nothing was sent.");
      for (const p of r.problems) io.out(`  - ${redactText(p)}`);
      for (const c of pf) io.out(`  - preflight ${c.id}: ${redactText(c.detail)}`);
      if (evProblem) io.out(`  - ${evProblem}`);
      return 2;
    }
    expect = r.expect;
    apiKey = env[ENV.key] as string;
    transport = deps.liveTransport ?? createNodeTransport();
    runId = deps.runId ?? Math.random().toString(16).slice(2, 10).padEnd(8, "0");
    waitMs = 5 * 60_000;
  } else {
    // dry-run: synthetic ids, a fake key string that is never a real credential, the fake transport. The environment is NOT read for a key.
    const evProblem = evidenceDirProblem(env[EVIDENCE_ENV], repoRoot);
    if (evProblem) {
      io.out(`refused: ${evProblem}`);
      return 2;
    }
    expect = { platformAcct: "acct_DRYRUNPLATFORM", connectedAcct: "acct_DRYRUNCONNECTED" };
    apiKey = "rk_test_DRYRUNFAKE";
    transport = createFakeTransport({ platformId: expect.platformAcct, connectedId: expect.connectedAcct }).transport;
    runId = deps.runId ?? `dry${Math.random().toString(16).slice(2, 8).padEnd(6, "0")}`;
    waitMs = 0;
  }

  io.out(`D24 M3-D Stripe TEST proof - ${live ? "LIVE (Stripe TEST mode)" : "DRY RUN (fake client, no network)"}`);
  io.out(`script manifest SHA-256: ${m.sha256}`);
  io.out(`pinned accounts: platform=${expect.platformAcct} connected=${expect.connectedAcct}; hard call cap ${HARD_CALL_CAP}; Stripe-Version pinned on every request: ${STRIPE_API_VERSION}`);

  const client = createGuardedClient({ transport, apiKey, connectedAcct: expect.connectedAcct, paceMs: live ? 250 : 0, sleep: io.sleep, shouldStop: deps.shouldStop });
  deps.onClient?.(client);
  let results: ScenarioResult[] = [];
  let verdicts: Verdicts | null = null;
  let abort: ProofAbort | null = null;
  let connectedFacts: ConnectedFacts | null = null;
  let connectedObserved: ConnectedObserved | null = null;
  try {
    connectedFacts = (await runIdentityGate(client, expect, (o) => { connectedObserved = o; io.out(`connected account observed (enum tokens only): ${sanitize(JSON.stringify(o))}`); })).connectedFacts;
    io.out(`connected account verified: ${sanitize(JSON.stringify(connectedFacts))}`);
    const r = await runScenarios({ client, expect, runId, sleep: io.sleep, replayWaitMs: waitMs });
    results = r.results;
    verdicts = r.verdicts;
  } catch (e) {
    abort = e instanceof ProofAbort ? e : new ProofAbort("unexpected_error", `unexpected error: ${redactText(String((e as Error)?.message ?? e))}`);
  }
  const clean = await cleanup(client, expect);
  // an abort recorded by the guard (also one raised inside cleanup or swallowed by a scenario) counts, not only the one that escaped the scenarios
  const fatal = abort ?? client.aborted();
  report(io, client, results, verdicts, clean, fatal);
  const reported = [...client.versionsSeen];
  io.out(`\nStripe-Version pinned: ${STRIPE_API_VERSION}; reported by Stripe in responses: ${reported.length ? reported.join(", ") : "none"}. Record the account's default API version from the dashboard by hand.`);
  const failed = results.some((x) => x.checks.some((c) => !c.ok));
  // success needs EVERYTHING: no abort, every check passing, and cleanup verified the account empty (not skipped, not interrupted, nothing unverifiable)
  const cleanOk = clean.verifiedEmpty && !clean.skipped && !clean.stoppedBecause;
  let outcome: "OK" | "FAILED" = !fatal && !failed && cleanOk ? "OK" : "FAILED";
  const evDir = env[EVIDENCE_ENV];
  if (evDir) {
    try {
      const files = writeEvidence(
        evDir,
        {
          outcome, runId, mode: live ? "live" : "dry-run", scriptSha256: m.sha256, apiVersionPinned: STRIPE_API_VERSION, apiVersionsReported: reported,
          connectedFacts, connectedObserved, callsUsed: client.stats().used, blocked: client.stats().blocked, scenarios: results, verdicts, cleanup: clean,
          abort: fatal ? { code: fatal.code, message: fatal.message } : null, transcriptText: `${lines.join("\n")}\nOUTCOME (before the evidence write): ${outcome}\n`, finishedUtc: (deps.now ?? (() => new Date()))().toISOString(),
        },
        repoRoot,
      );
      io.out(`evidence written (redacted, account ids masked): ${sanitize(files.json)} and ${sanitize(files.transcript)}`);
    } catch (e) {
      // evidence was requested and could not be written safely: the run is not reported as OK
      outcome = "FAILED";
      io.out(`EVIDENCE NOT WRITTEN: ${redactText(String((e as Error)?.message ?? e))}`);
    }
  }
  io.out(`\nOUTCOME: ${outcome}${cleanOk ? "" : " (cleanup did not verify an empty account: see the Cleanup section and the README's manual reconciliation)"}`);
  return outcome === "OK" ? 0 : 1;
}

// executed only when run directly, never when imported by the tests
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  // Ctrl-C stops the scenarios but NOT the cleanup: the flag makes the next call abort, cleanup then runs, and waits end early
  let stop = false;
  let live: GuardedClient | null = null;
  const wake: Array<() => void> = [];
  process.on("SIGINT", () => {
    if (stop) {
      // a second Ctrl-C ends the process immediately (e.g. a hung request): say what may be left behind, then exit
      const left = live ? [...live.seen.drafts, ...live.seen.customers, ...live.uncertain].join(", ") : "unknown";
      process.stdout.write(sanitize(`\nFORCED EXIT: cleanup did not finish. Objects that may remain at Stripe (and unverifiable creates): ${left || "none known"}. Do the manual reconciliation in the README, then expire the key.\n`));
      process.exit(130);
    }
    stop = true;
    process.stdout.write("\ninterrupt received: stopping scenarios, running cleanup...\n");
    wake.splice(0).forEach((w) => w());
  });
  runProof(process.argv.slice(2), {
    env: process.env,
    shouldStop: () => stop,
    onClient: (c) => { live = c; },
    io: {
      out: (s) => process.stdout.write(`${s}\n`),
      sleep: (ms) =>
        new Promise<void>((r) => {
          if (stop) return r();
          const t = setTimeout(r, ms);
          wake.push(() => {
            clearTimeout(t);
            r();
          });
        }),
    },
  }).then((code) => process.exit(code), (e) => {
    process.stdout.write(sanitize(`\nOUTCOME: FAILED (unexpected error: ${String((e as Error)?.message ?? e)})\n`));
    process.exit(1);
  });
}
