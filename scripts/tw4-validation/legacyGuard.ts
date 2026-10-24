/**
 * The legacy Stage B/C harness only ever wrote to ONE Twilio account: the account whose SID and Standard API key it was handed (in practice the
 * PARENT account). Owner decision D2 (revised 2026-10-18) puts every studio legal business in its own subaccount, and the harness cannot tell
 * offline, or with a Standard API key (it cannot read /Accounts), which account a credential belongs to. A real run could therefore create a
 * studio's EIN-bearing draft in the wrong account, so real runs of this harness are retired and there is deliberately NO switch, flag or
 * environment variable that re-enables them. The fake adapter (dry runs, local tests) is unaffected.
 *
 * Pure and dependency-free so it can be unit-tested and called before anything else in the CLI.
 */
export const LEGACY_REAL_MODE_MESSAGE = [
  "REFUSED (exit code 2): real mode of the legacy Stage B/C harness is retired. Nothing was sent to Twilio.",
  "Why: this harness writes to the single account whose Account SID and API key it is given (the parent account). Each studio legal business now has its own",
  "Twilio subaccount, and the harness cannot verify which account a credential belongs to, so it could put a studio's identity data in the wrong account.",
  "Use instead: the production onboarding runner (platform panel): create the studio's subaccount (G-SUB), then the runner's steps S1-S10 run inside it with the",
  "subaccount's own credentials. See docs/twilio/TW-4_StageB_Execution_Runbook.md section 0 and docs/twilio/TW-4F_Production_Onboarding_Plan.md section 13.",
  "Still available: -DryRun (fake adapter, local database, no network) and the local test suites.",
].join("\n");

/** A refusal message when the arguments ask for anything but the fake adapter, otherwise null. Fails closed: every `--adapter` occurrence is judged, and a missing or unknown value is refused. */
export function legacyRealModeRefusal(argv: readonly string[]): string | null {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    let value: string | undefined;
    if (arg === "--adapter") value = argv[i + 1];
    else if (arg.startsWith("--adapter=")) value = arg.slice("--adapter=".length);
    else continue;
    if (value !== "fake") return LEGACY_REAL_MODE_MESSAGE;
  }
  return null; // no --adapter, or only "fake": the harness uses the fake adapter
}
