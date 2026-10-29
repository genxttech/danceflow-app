/**
 * BILLING-QA-5: read-back of an owner-run no-payment checkout smoke. See docs/qa/billing-owner-smoke-kit.md.
 *
 * Usage (from the repo root, run by the owner with their own restricted read-only key):
 *   npm run qa:billing-readback -- --read-key-file .env.billing-readback.local \
 *     --price-config price-config.json --session cs_live_... --session cs_live_... --session cs_live_... \
 *     [--smoke-customer cus_...] [--portal-customer cus_...] [--grandfathered sub_...] [--out smoke-report.json]
 *
 * Key from BILLING_QA_STRIPE_READ_KEY only: rk_live_ (restricted) in live mode, sk_test_/rk_test_ in test mode; a live
 * secret key (sk_live_) is refused. Reads Checkout Sessions and Subscriptions only; changes nothing.
 *
 * The key file option is --read-key-file, NOT --env-file: Node itself consumes --env-file anywhere on the command line
 * (even after the script name) and, if the file is missing, exits with code 9 printing the value in full, before this
 * script can refuse a pasted key.
 *
 * Exit codes: 0 PASS, 1 FAIL, 4 BLOCKED (never a pass), 2 usage error or safety refusal.
 */

import { readFileSync, writeFileSync } from "node:fs";
import Stripe from "stripe";
import type { StudioPlanCode } from "@/lib/billing/plans";
import {
  describeArgument,
  looksLikeStripeKey,
  redactKeys,
  expectationsFromPriceConfig,
  readBackSmoke,
  type BillingQaReadClient,
  type SmokeExpectations,
} from "@/lib/billing-qa/sessionReadback";
import { qaEnvironment } from "@/lib/billing-qa/envFile";
import { exitCodeFor, renderReportTable } from "@/lib/billing-qa/report";
import { assertBillingQaReadKey, BILLING_QA_READ_KEY_ENV, BillingQaSafetyError } from "@/lib/billing-qa/stripeKey";

const USAGE = `Usage: billing-session-readback --session <cs_...> [--session ...] [--price-config <report.json> | --expect <plan>=<price_...> ...]
  [--offer founder|standard] [--plans starter,growth,pro] [--smoke-customer cus_...] [--portal-customer cus_...]
  [--grandfathered sub_...] [--legacy-price price_... ...] [--since <ISO time>] [--read-key-file <path>] [--json] [--out <report.json>]
  Stripe key: ${BILLING_QA_READ_KEY_ENV} (restricted read-only).`;

const PLANS: StudioPlanCode[] = ["starter", "growth", "pro"];

function parseArgs(argv: string[]) {
  const o = {
    sessions: [] as string[], expect: {} as Partial<Record<StudioPlanCode, string>>, priceConfig: null as string | null, offer: null as SmokeExpectations["offer"] | null,
    plans: null as StudioPlanCode[] | null, smokeCustomer: null as string | null, portalCustomer: null as string | null, grandfathered: null as string | null,
    legacyPrices: [] as string[], since: null as number | null, envFile: null as string | null, json: false, out: null as string | null, help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) throw new Error(`${arg} needs a value`);
      // A key pasted as a value (e.g. --read-key-file rk_live_...) would otherwise reach a file path, an error or a file name.
      if (looksLikeStripeKey(next)) throw new Error(`${arg}: that value looks like a Stripe key. Keys go only in ${BILLING_QA_READ_KEY_ENV}`);
      i += 1;
      return next.trim();
    };
    const shaped = (v: string, pattern: RegExp, what: string) => {
      if (!pattern.test(v)) throw new Error(`${arg}: not a ${what}`);
      return v;
    };
    if (arg === "--session") o.sessions.push(value());
    else if (arg === "--price-config") o.priceConfig = value();
    else if (arg === "--expect") {
      const [plan, price] = value().split("=");
      if (!PLANS.includes(plan as StudioPlanCode) || !/^price_[A-Za-z0-9]+$/.test(price ?? "")) throw new Error("--expect takes <starter|growth|pro>=<price_...>");
      o.expect[plan as StudioPlanCode] = price;
    } else if (arg === "--offer") {
      const v = value();
      if (v !== "founder" && v !== "standard") throw new Error("--offer takes founder or standard");
      o.offer = v;
    } else if (arg === "--plans") {
      const list = value().split(",").map((p) => p.trim());
      if (!list.length || list.some((p) => !PLANS.includes(p as StudioPlanCode))) throw new Error("--plans takes a comma list of starter, growth, pro");
      o.plans = list as StudioPlanCode[];
    } else if (arg === "--smoke-customer") o.smokeCustomer = shaped(value(), /^cus_[A-Za-z0-9]+$/, "Stripe customer id");
    else if (arg === "--portal-customer") o.portalCustomer = shaped(value(), /^cus_[A-Za-z0-9]+$/, "Stripe customer id");
    else if (arg === "--grandfathered") o.grandfathered = shaped(value(), /^sub_[A-Za-z0-9]+$/, "Stripe subscription id");
    else if (arg === "--legacy-price") o.legacyPrices.push(shaped(value(), /^price_[A-Za-z0-9]+$/, "Stripe Price id"));
    else if (arg === "--since") {
      const ms = Date.parse(value());
      if (Number.isNaN(ms)) throw new Error("--since takes an ISO time");
      o.since = Math.floor(ms / 1000);
    } else if (arg === "--read-key-file") o.envFile = value();
    else if (arg === "--json") o.json = true;
    else if (arg === "--out") o.out = value();
    else if (arg === "--help" || arg === "-h") o.help = true;
    else throw new Error(`unknown argument ${describeArgument(arg)}`);
  }
  if (!o.help && o.sessions.length === 0) throw new Error("at least one --session is required");
  return o;
}

async function main() {
  let o: ReturnType<typeof parseArgs>;
  try {
    o = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`${redactKeys(String(error instanceof Error ? error.message : error))}\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  if (o.help) {
    console.log(USAGE);
    return;
  }

  try {
    const env = qaEnvironment(o.envFile);
    const { key, mode } = assertBillingQaReadKey(env[BILLING_QA_READ_KEY_ENV]);
    const fromConfig = o.priceConfig ? expectationsFromPriceConfig(JSON.parse(readFileSync(o.priceConfig, "utf8"))) : null;
    const expectations: SmokeExpectations = {
      offer: o.offer ?? fromConfig?.offer ?? "founder",
      prices: { ...(fromConfig?.prices ?? {}), ...o.expect },
      legacyPriceIds: o.legacyPrices.length ? o.legacyPrices : fromConfig?.legacyPriceIds ?? [],
      ...(fromConfig?.priceConfigOverall ? { priceConfigOverall: fromConfig.priceConfigOverall } : {}),
    };
    // Typed, not cast: the real SDK must satisfy the read-only interface, so a changed signature fails to compile.
    const sdk = new Stripe(key, { maxNetworkRetries: 1 });
    const stripe: BillingQaReadClient = {
      checkout: { sessions: { retrieve: (id, params) => sdk.checkout.sessions.retrieve(id, params), list: (params) => sdk.checkout.sessions.list(params) } },
      subscriptions: { retrieve: (id) => sdk.subscriptions.retrieve(id), list: (params) => sdk.subscriptions.list(params) },
    };
    const report = await readBackSmoke({
      stripe, keyMode: mode, sessionIds: o.sessions, expectations, plans: o.plans ?? undefined,
      smokeCustomer: o.smokeCustomer, portalCustomer: o.portalCustomer, grandfatheredSubscription: o.grandfathered, since: o.since ?? undefined,
    });
    if (o.out) writeFileSync(o.out, `${JSON.stringify(report, null, 2)}\n`);
    console.log(o.json ? JSON.stringify(report, null, 2) : renderReportTable(report));
    process.exitCode = exitCodeFor(report.overall);
  } catch (error) {
    if (error instanceof BillingQaSafetyError) console.error(`Refused: ${error.code}: ${redactKeys(error.message)}`);
    else console.error(`billing session read-back failed: ${redactKeys(String(error instanceof Error ? error.message : error))}`);
    process.exitCode = 2;
  }
}

main();
