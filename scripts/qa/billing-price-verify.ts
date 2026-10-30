/**
 * BILLING-QA-1: Stripe TEST-mode studio Price verifier (read-only). See docs/qa/billing-qa.md.
 *
 * Usage (from the repo root):
 *   npm run qa:billing-prices -- --env-file .env.billing-qa.local
 *   npm run qa:billing-prices -- --env-file .env.billing-qa.local --require-regular --out report.json
 *   npm run qa:billing-prices -- --json
 *
 * Reads the studio Price ID variables and pricing flags (the same names the app uses) from the environment, with
 * values in --env-file taking precedence, and the Stripe key from BILLING_QA_STRIPE_TEST_KEY only. Calls nothing but
 * `prices.retrieve`.
 *
 * Exit codes: 0 PASS, 1 FAIL, 4 BLOCKED (never a pass), 2 usage error or safety refusal (live key, live object).
 */

import { writeFileSync } from "node:fs";
import Stripe from "stripe";
import { verifyStudioPrices } from "@/lib/billing-qa/priceVerifier";
import { qaEnvironment } from "@/lib/billing-qa/envFile";
import { exitCodeFor, renderReportTable } from "@/lib/billing-qa/report";
import { assertBillingQaTestModeKey, BILLING_QA_KEY_ENV, BillingQaSafetyError } from "@/lib/billing-qa/stripeKey";
import { PaymentHarnessSafetyError } from "@/lib/payment-harness/guards";

const USAGE = `Usage: billing-price-verify [--env-file <path>] [--require-regular] [--json] [--out <report.json>]
  Stripe key: ${BILLING_QA_KEY_ENV} (test mode only).`;

function parseArgs(argv: string[]) {
  const options = { envFile: null as string | null, requireRegular: false, json: false, out: null as string | null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) throw new Error(`${arg} needs a value`);
      i += 1;
      return next;
    };
    if (arg === "--env-file") options.envFile = value();
    else if (arg === "--out") options.out = value();
    else if (arg === "--require-regular") options.requireRegular = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`unknown argument ${arg}`);
  }
  return options;
}

async function main() {
  let options: ReturnType<typeof parseArgs>;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`${error instanceof Error ? error.message : error}\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    console.log(USAGE);
    return;
  }

  try {
    const env = qaEnvironment(options.envFile);
    const key = assertBillingQaTestModeKey(env[BILLING_QA_KEY_ENV]);
    const report = await verifyStudioPrices({
      env,
      stripe: new Stripe(key, { maxNetworkRetries: 1 }),
      requireRegular: options.requireRegular,
    });

    if (options.out) writeFileSync(options.out, `${JSON.stringify(report, null, 2)}\n`);
    console.log(options.json ? JSON.stringify(report, null, 2) : renderReportTable(report));
    process.exitCode = exitCodeFor(report.overall);
  } catch (error) {
    if (error instanceof BillingQaSafetyError || error instanceof PaymentHarnessSafetyError) {
      console.error(`Refused: ${error.code}: ${error.message}`);
    } else {
      console.error(`billing price verifier failed: ${error instanceof Error ? error.message : error}`);
    }
    process.exitCode = 2;
  }
}

main();
