/**
 * D7 WP-3: bounded Stripe TEST-mode proof (docs/billing/D7-WP3-STRIPE-TESTMODE-PROOF-PLAN.md). TEST sandbox only.
 *
 *   npx tsx scripts/billing/price-transition-proof.ts preflight --env-file <path> --expected-account acct_...
 *   npx tsx scripts/billing/price-transition-proof.ts run       --env-file <path> --expected-account acct_... [--excluded-account acct_...]
 *
 * The key is read from the env file (STRIPE_SECRET_KEY) and is never printed. Nothing runs unless the key is a restricted
 * rk_test_ key, the retrieved account equals the approved sandbox, and every operation is on the approved allowlist.
 * Evidence is redacted and written to docs/billing/evidence/d7-wp3-testmode/.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import Stripe from "stripe";
import { PROOF_ALLOWED_OPERATIONS, checkSandboxIdentity, redactSecrets, validateProofKey } from "@/lib/billing/priceTransitionProofGuard";
import { loadKey, log, op } from "./price-transition-proof-lib";
import { runScenarios } from "./price-transition-proof-scenarios";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  if (i >= 0 && (v === undefined || v.startsWith("--"))) {
    console.error(`--${name} needs a value`);
    process.exit(2);
  }
  return v;
}

async function main() {
  const mode = process.argv[2];
  const envFile = flag("env-file");
  if (!["preflight", "run"].includes(mode ?? "") || !envFile) {
    console.error("usage: price-transition-proof.ts <preflight|run> --env-file <path> --expected-account acct_...");
    process.exit(2);
  }
  const secret = loadKey(envFile);
  const keyCheck = validateProofKey(secret);
  if (!keyCheck.ok) {
    console.error(`REFUSED before any Stripe call: ${keyCheck.reason}`);
    process.exit(2);
  }
  const stripe = new Stripe(secret);
  console.log(`Stripe SDK API version (pinned by the installed SDK): ${Stripe.API_VERSION}`);
  console.log(`Approved operation allowlist (${PROOF_ALLOWED_OPERATIONS.length}): ${PROOF_ALLOWED_OPERATIONS.join(", ")}`);

  const account = await op("accounts.retrieve", {}, () => (stripe.accounts as unknown as { retrieve(): Promise<Stripe.Account> }).retrieve());
  const excluded = (flag("excluded-account") ?? "").split(",").filter(Boolean);
  const identity = checkSandboxIdentity({ accountId: account.id, expectedAccountId: flag("expected-account"), excludedAccountIds: excluded });
  if (!identity.ok) {
    console.error(`REFUSED after identity check: ${identity.reasons.join("; ")}`);
    process.exit(2);
  }
  console.log(`Sandbox identity OK: ${account.id} (livemode keys are refused by prefix; this key is rk_test_)`);

  const dir = path.join(process.cwd(), "docs", "billing", "evidence", "d7-wp3-testmode");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${mode}-log.json`), JSON.stringify(redactSecrets({ apiVersion: Stripe.API_VERSION, account: account.id, log }), null, 2));

  if (mode === "preflight") {
    const invoices = await op("invoices.list", { limit: 1 }, () => stripe.invoices.list({ limit: 1 }));
    console.log(`invoices.list permission OK (${invoices.data.length} returned)`);
    writeFileSync(path.join(dir, "preflight-log.json"), JSON.stringify(redactSecrets({ apiVersion: Stripe.API_VERSION, account: account.id, log }), null, 2));
    return;
  }
  let outcome: Awaited<ReturnType<typeof runScenarios>>;
  try {
    outcome = await runScenarios(stripe);
  } catch (error) {
    writeFileSync(path.join(dir, "run-log.json"), JSON.stringify(redactSecrets({ apiVersion: Stripe.API_VERSION, account: account.id, aborted: (error as Error).message, entries: log.length, log }), null, 2));
    throw error;
  }
  const { results, summary } = outcome;
  const failed = results.filter((r) => !r.pass);
  writeFileSync(path.join(dir, "run-results.json"), JSON.stringify(redactSecrets({ apiVersion: Stripe.API_VERSION, account: account.id, summary, results }), null, 2));
  writeFileSync(path.join(dir, "run-log.json"), JSON.stringify(redactSecrets({ apiVersion: Stripe.API_VERSION, account: account.id, entries: log.length, log }), null, 2));
  console.log(`
RESULT: ${results.length - failed.length} passed, ${failed.length} failed of ${results.length}`);
  process.exit(failed.length === 0 ? 0 : 1);
}

{
  main().catch((error) => {
    const e = error as { type?: string; code?: string; message?: string };
    console.error(`FAILED: ${e.type ?? ""} ${e.code ?? ""} ${e.message ?? error}`.trim());
    process.exit(1);
  });
}
