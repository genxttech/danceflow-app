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
