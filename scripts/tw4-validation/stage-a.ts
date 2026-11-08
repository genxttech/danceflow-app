/**
 * TW-4 mock-brand validation, STAGE A: read-only Twilio probe. Run by a person, never by the application, never from CI.
 * Preferred way to run it: scripts/tw4-validation/run-stage-a.ps1 (prompts for the credentials, validates them, runs once, clears them).
 *
 *   npx tsx --tsconfig scripts/tw4-validation/tsconfig.json scripts/tw4-validation/stage-a.ts --confirm-stage-a-read-only --out <NEW file> [--self-test]
 *
 * Environment (set in YOUR terminal for this one run; nothing here reads or writes env files):
 *   TWILIO_ACCOUNT_SID                       AC...
 *   TWILIO_API_KEY_SID + TWILIO_API_KEY_SECRET   a temporary Standard API key (preferred; revoke it afterwards)  -- or --
 *   TWILIO_AUTH_TOKEN                        the master token (not recommended)
 *   TWILIO_ISV_PRIMARY_PROFILE_SID           optional (defaults to the GenX Primary profile in the TW-4 design)
 *   TWILIO_ISV_{PRIMARY,SECONDARY,A2P}_POLICY_SID   optional: checked against Twilio's policy list
 *   TW4_VALIDATION_EXPECTED_NAME / _EIN      optional: compared with the Primary profile's business details, never printed
 *
 * It issues GET requests only (see src/lib/sms/twilioIsv/validation/probe.ts) and writes a credential-free JSON report.
 * --self-test answers from canned data in this process: NO network, NO Twilio; the report is marked "selfTest": true.
 * Exit codes: 0 clean, 1 ran but reported problems (report still written), 2 refused before any request (the reason is printed).
 */
import { writeFileSync } from "node:fs";
import { selfTestFetch } from "@/lib/sms/twilioIsv/validation/selfTest";
import { checkOutPath, executeStageA, SELF_TEST_FLAG } from "@/lib/sms/twilioIsv/validation/stageA";

async function main() {
  const argv = process.argv.slice(2);
  const selfTest = argv.includes(SELF_TEST_FLAG);
  const out = checkOutPath(argv);
  if (!out.ok) {
    process.stderr.write(out.text);
    process.exitCode = out.exitCode;
    return;
  }
  const outcome = await executeStageA({ argv, env: process.env, fetchImpl: selfTest ? selfTestFetch : (url, init) => fetch(url, init), selfTest });
  if (!outcome.ok) {
    process.stderr.write(outcome.text);
    process.exitCode = outcome.exitCode;
    return;
  }
  if (out.path) {
    try {
      writeFileSync(out.path, outcome.text, { encoding: "utf8", mode: 0o600, flag: "wx" });
    } catch {
      process.stderr.write(`REFUSED (exit code 2) to save the report: the file could not be created at ${out.path}.\n  To fix:  choose another --out path in a folder you can write to.\n`);
      process.stdout.write(outcome.text); // the probe already ran; do not lose its result
      process.exitCode = 2;
      return;
    }
    process.stdout.write(`${selfTest ? "[SELF-TEST: no Twilio contact] " : ""}Report written to ${out.path}\n`);
  } else {
    process.stdout.write(outcome.text);
  }
  if (outcome.notRun.length > 0) {
    const lines = outcome.notRun.map((n) => `  - ${n.section}: ${n.reason}`).join("\n");
    process.stderr.write(`Checks NOT performed (a skipped check is not a pass):\n${lines}\n`);
  }
  if (outcome.exitCode === 1) {
    process.stderr.write(`Completed WITH PROBLEMS (exit code 1):\n${outcome.problems.map((p) => `  - ${p}`).join("\n")}\n${outcome.hints.map((h) => `  Hint: ${h}`).join("\n")}\n`);
  }
  process.exitCode = outcome.exitCode;
}

void main();
