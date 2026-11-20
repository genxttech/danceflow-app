/**
 * CF1 Stripe-TEST acceptance: the guard process (first Stripe compatibility check). See src/lib/e2e/stripeGuard.ts.
 * Exit codes: 0 ok; 2 STOP on a connected-account capability error (report the exact error, do not request onboarding); 3 STOP: the key lacks a Stripe
 * permission (the exact error names it); 1 any other stop. Accepted keys: sk_test_ and rk_test_ only.
 * Environment: E2E_STRIPE_TEST_SECRET_KEY, CF1_EXPECT_PLATFORM_ACCT, E2E_STRIPE_TEST_CONNECTED_ACCOUNT, optional E2E_BASE_URL (loopback), CF1_GUARD_REPORT_FILE.
 * Everything this process prints or writes goes through summarizeReport / serializeReport, which mask the WHOLE report (keys, webhook secrets, JWTs in any field).
 */
import { appendFileSync, writeFileSync } from "node:fs";
import Stripe from "stripe";
import { runStripeGuard, serializeReport, summarizeReport } from "../../src/lib/e2e/stripeGuard";
import { redactSecrets } from "../../src/lib/e2e/stripeRelay";

async function main() {
  const key = process.env.E2E_STRIPE_TEST_SECRET_KEY ?? "";
  const expectPlatform = process.env.CF1_EXPECT_PLATFORM_ACCT ?? "";
  const connectedAccount = process.env.E2E_STRIPE_TEST_CONNECTED_ACCOUNT ?? "";
  const base = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3000";
  if (!/^acct_[A-Za-z0-9]+$/.test(expectPlatform) || !/^acct_[A-Za-z0-9]+$/.test(connectedAccount) || expectPlatform === connectedAccount) throw new Error("refusing: account ids");
  if (!/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(base)) throw new Error("refusing: E2E_BASE_URL is not loopback");
  const stripe = new Stripe(key);
  const report = await runStripeGuard({ stripe, key, config: { expectPlatform, connectedAccount, successUrl: `${base}/cf1-canary?session={CHECKOUT_SESSION_ID}`, cancelUrl: `${base}/cf1-canary-cancel` } });
  const summary = summarizeReport(report);
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  if (process.env.CF1_GUARD_REPORT_FILE) writeFileSync(process.env.CF1_GUARD_REPORT_FILE, serializeReport(report));
  // 0 ok; 2 capability error (exact error, no onboarding); 3 the key lacks a Stripe permission (exact error names it); 1 anything else.
  process.exit(report.ok ? 0 : report.stop?.failure.kind === "capability" ? 2 : report.stop?.failure.kind === "permission" ? 3 : 1);
}

main().catch((error) => { console.error(`guard: ${redactSecrets(error instanceof Error ? error.message : "failed")}`); process.exit(1); });
