import { PaymentHarnessSafetyError } from "@/lib/payment-harness/guards";

/**
 * Stripe test-mode safety for the Payment Harness -- the two independent
 * layers the approved design calls for:
 *
 *   1. Pre-flight: the configured secret key must look like a Stripe
 *      test-mode key before the harness ever calls Stripe with it.
 *   2. Post-creation: every Stripe object the harness later creates or
 *      reads back must be independently confirmed `livemode: false` by
 *      Stripe's own response, not just trusted because the key looked
 *      right.
 *
 * Neither check imports the `stripe` package -- this module has no Stripe
 * SDK dependency at all. The pre-flight check is pure string-shape
 * validation on an env var; the post-creation check only ever inspects a
 * `livemode` field on a duck-typed object, so a later slice can pass it a
 * real Stripe.Checkout.Session/Stripe.PaymentIntent without this module
 * needing to know the full shape of either.
 */

const TEST_KEY_PATTERN = /^(sk|rk)_test_/;
const LIVE_KEY_PATTERN = /^(sk|rk)_live_/;

/**
 * Reads and validates `PAYMENT_HARNESS_STRIPE_SECRET_KEY` -- never the
 * application's own `STRIPE_SECRET_KEY` (see config.ts's identical
 * reasoning: a harness that could silently inherit the app's runtime
 * Stripe key would defeat the entire point of this being a separate,
 * dev/QA-only capability). Returns the validated key on success so a
 * later slice can construct its own Stripe client from it; throws on
 * anything else. The key's own value is never interpolated into any
 * thrown message.
 */
export function assertPaymentHarnessStripeTestModeKey(): string {
  const key = process.env.PAYMENT_HARNESS_STRIPE_SECRET_KEY?.trim();

  if (!key) {
    throw new PaymentHarnessSafetyError(
      "Fail-closed: missing PAYMENT_HARNESS_STRIPE_SECRET_KEY. The Payment Harness will not " +
        "start without an explicit, configured Stripe test-mode secret key.",
      "STRIPE_KEY_MISSING",
    );
  }

  if (LIVE_KEY_PATTERN.test(key)) {
    throw new PaymentHarnessSafetyError(
      "Fail-closed: PAYMENT_HARNESS_STRIPE_SECRET_KEY is a live-mode Stripe key " +
        "(sk_live_/rk_live_). The Payment Harness refuses to run against live mode under any " +
        "circumstance.",
      "STRIPE_KEY_LIVE_MODE",
    );
  }

  if (!TEST_KEY_PATTERN.test(key)) {
    throw new PaymentHarnessSafetyError(
      "Fail-closed: PAYMENT_HARNESS_STRIPE_SECRET_KEY does not match a recognized Stripe " +
        "test-mode key shape (sk_test_.../rk_test_...). Refusing to proceed with an " +
        "unrecognized key prefix.",
      "STRIPE_KEY_MALFORMED",
    );
  }

  return key;
}

/**
 * Call on every Stripe object the harness creates or reads back, before
 * treating it as safe to act on further. Fails closed -- not just on
 * `livemode === true`, but on `livemode` being absent or not a boolean at
 * all, since either of those means "we cannot confirm this is test mode,"
 * which is exactly as unsafe as a confirmed live object for this
 * purpose. Only ever inspects the one `livemode` field; never
 * interpolates the rest of the object (which could carry Stripe IDs,
 * customer emails, or other object-specific data) into the thrown
 * message.
 */
export function assertStripeObjectIsTestMode(
  stripeObject: { livemode?: unknown } | null | undefined,
  context: string,
): void {
  if (!stripeObject || typeof stripeObject.livemode !== "boolean") {
    throw new PaymentHarnessSafetyError(
      `Fail-closed (${context}): Stripe object has no confirmed boolean livemode field. ` +
        `Refusing to treat this as verified test mode.`,
      "STRIPE_LIVEMODE_UNKNOWN",
    );
  }

  if (stripeObject.livemode) {
    throw new PaymentHarnessSafetyError(
      `Fail-closed (${context}): Stripe object has livemode=true. Refusing to proceed.`,
      "STRIPE_LIVEMODE_TRUE",
    );
  }
}
