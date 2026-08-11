/**
 * Manual trigger for the Production Synthetic Testing harness.
 *
 * FlowOps quality/PRODUCTION-SYNTHETIC-TESTING.md: "Manual trigger only at
 * launch." This is a human-operated CLI script, not wired into any cron,
 * webhook, or CI pipeline. Nothing in this application auto-invokes it.
 *
 * Usage (from the repo root):
 *   node --env-file=.env.local --import tsx scripts/run-synthetic-suite.ts --confirm
 *   node --env-file=.env.local --import tsx scripts/run-synthetic-suite.ts --confirm --suite=auth,client
 *
 * The --confirm flag is required and deliberate -- it is a second,
 * explicit "yes I mean to do this" gate on top of the environment-variable
 * fail-closed checks in src/lib/synthetic/config.ts, so this can never run
 * by accident from a bare invocation.
 *
 * Requires SYNTHETIC_* environment variables (see .env.example) to be
 * set for whichever identities/suites you're running. Missing config
 * causes an immediate, explicit failure -- never a silent no-op and never
 * a fallback to some other tenant.
 *
 * Outside of Vitest, a deployment identity is also required: either run
 * where Vercel sets VERCEL_GIT_COMMIT_SHA/VERCEL_ENV automatically, or set
 * SYNTHETIC_DEPLOYMENT_SHA and SYNTHETIC_ENVIRONMENT explicitly. Without
 * one of those, runSyntheticSuite() fails closed rather than recording a
 * run attributed to an "unknown" deployment (src/lib/synthetic/deployment.ts).
 *
 * Exits 0 only if every requested suite passed. Exits 1 for any failure,
 * error, or unconfigured/invalid invocation, so this is safe to wire into
 * a CI "did the last deploy verify" gate later without additional parsing
 * beyond the exit code, on top of the JSON printed to stdout.
 */

import { runSyntheticSuite } from "@/lib/synthetic/runner";
import { ALL_SUITES, SyntheticSafetyError } from "@/lib/synthetic/types";
import type { SyntheticSuite } from "@/lib/synthetic/types";

function parseArgs(argv: string[]) {
  const confirm = argv.includes("--confirm");
  const suiteArg = argv.find((arg) => arg.startsWith("--suite="));
  const requestedSuites = suiteArg
    ? (suiteArg.slice("--suite=".length).split(",").map((s) => s.trim()) as SyntheticSuite[])
    : null;

  if (requestedSuites) {
    for (const suite of requestedSuites) {
      if (!ALL_SUITES.includes(suite)) {
        throw new Error(
          `Unknown suite "${suite}". Valid suites: ${ALL_SUITES.join(", ")}`,
        );
      }
    }
  }

  return { confirm, suites: requestedSuites ?? undefined };
}

async function main() {
  const { confirm, suites } = parseArgs(process.argv.slice(2));

  if (!confirm) {
    console.error(
      "Refusing to run without --confirm. This script executes real writes " +
        "against the configured synthetic tenant. Re-run with --confirm once " +
        "you have verified SYNTHETIC_STUDIO_ID and the identity env vars point " +
        "at the intended synthetic tenant, not a real customer tenant.",
    );
    process.exitCode = 1;
    return;
  }

  try {
    const result = await runSyntheticSuite({
      suites,
      triggeredBy: "cli",
      triggeredByActor: process.env.USER || process.env.USERNAME || "unknown-operator",
    });

    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.overallStatus === "passed" ? 0 : 1;
  } catch (error) {
    if (error instanceof SyntheticSafetyError) {
      console.error(`Fail-closed: ${error.code}: ${error.message}`);
    } else {
      console.error("Synthetic runner failed to start:", error instanceof Error ? error.message : error);
    }
    process.exitCode = 1;
  }
}

main();
