/**
 * BILLING-QA-1. Key guard for the billing QA tools: test-mode keys only.
 *
 * The key comes from BILLING_QA_STRIPE_TEST_KEY and never from the app's own STRIPE_SECRET_KEY, so loading an app env
 * file can never hand the verifier whatever key the app happens to run with. The key value is never put in a message.
 * Live-mode read-only verification is a separate, later capability with its own guard and owner approval.
 */

export const BILLING_QA_KEY_ENV = "BILLING_QA_STRIPE_TEST_KEY";

export class BillingQaSafetyError extends Error {
  code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "BillingQaSafetyError";
    this.code = code;
  }
}

export function assertBillingQaTestModeKey(raw: string | undefined): string {
  const key = raw?.trim();
  if (!key) {
    throw new BillingQaSafetyError(`${BILLING_QA_KEY_ENV} is not set. Provide a Stripe test-mode key (sk_test_ or rk_test_).`, "STRIPE_KEY_MISSING");
  }
  if (/^(sk|rk)_live_/.test(key)) {
    throw new BillingQaSafetyError(`${BILLING_QA_KEY_ENV} is a live-mode key. This tool runs in Stripe test mode only.`, "STRIPE_KEY_LIVE_MODE");
  }
  if (!/^(sk|rk)_test_[A-Za-z0-9]+$/.test(key)) {
    throw new BillingQaSafetyError(`${BILLING_QA_KEY_ENV} is not a recognized Stripe test-mode key (sk_test_ or rk_test_).`, "STRIPE_KEY_MALFORMED");
  }
  return key;
}

/**
 * BILLING-QA-5. Key guard for the owner's session read-back: from BILLING_QA_STRIPE_READ_KEY only. In live mode only
 * a RESTRICTED key (rk_live_) is accepted, so the most a leaked or misused key can do is read; a live secret key
 * (sk_live_) is refused even though the tool would only read with it. Test mode accepts sk_test_ or rk_test_.
 */
export const BILLING_QA_READ_KEY_ENV = "BILLING_QA_STRIPE_READ_KEY";

export function assertBillingQaReadKey(raw: string | undefined): { key: string; mode: "live" | "test" } {
  const key = raw?.trim();
  if (!key) {
    throw new BillingQaSafetyError(`${BILLING_QA_READ_KEY_ENV} is not set. Provide a restricted read-only key (rk_live_ or rk_test_).`, "STRIPE_KEY_MISSING");
  }
  if (/^sk_live_/.test(key)) {
    throw new BillingQaSafetyError(`${BILLING_QA_READ_KEY_ENV} is a live SECRET key. Create a restricted read-only key (rk_live_) instead.`, "STRIPE_LIVE_SECRET_KEY_REFUSED");
  }
  if (/^rk_live_[A-Za-z0-9]+$/.test(key)) return { key, mode: "live" };
  if (/^(sk|rk)_test_[A-Za-z0-9]+$/.test(key)) return { key, mode: "test" };
  throw new BillingQaSafetyError(`${BILLING_QA_READ_KEY_ENV} is not a recognized Stripe key (rk_live_, rk_test_ or sk_test_).`, "STRIPE_KEY_MALFORMED");
}
