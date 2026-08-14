import Stripe from "stripe";
import {
  assertPaymentHarnessStripeTestModeKey,
  assertStripeObjectIsTestMode,
} from "@/lib/payment-harness/stripeTestMode";
import { PaymentHarnessSafetyError } from "@/lib/payment-harness/guards";

/**
 * Slice 5's only Stripe SDK usage in the Payment Harness -- everything
 * else in this module tree (stripeTestMode.ts, browser.ts through Slice 4)
 * deliberately has no `stripe` package dependency. This file exists
 * specifically to re-verify, immediately before any card details are
 * entered, that the already-captured Checkout Session is genuinely
 * test-mode -- retrieved through the harness-only
 * `PAYMENT_HARNESS_STRIPE_SECRET_KEY` (via
 * `assertPaymentHarnessStripeTestModeKey`), never the app's own
 * `STRIPE_SECRET_KEY`. `stripeTestMode.ts` itself stays SDK-free; this
 * file is the one place that actually calls Stripe.
 */

/** The minimal Stripe client surface this module calls -- lets tests
 * inject a fake without constructing a real `Stripe` instance. */
export type StripeCheckoutRetrievalClient = {
  checkout: {
    sessions: {
      retrieve: (
        id: string,
        params: Record<string, never>,
        options: { stripeAccount: string },
      ) => Promise<{ livemode?: unknown; url?: unknown }>;
    };
  };
};

export type StripeClientFactory = (apiKey: string) => StripeCheckoutRetrievalClient;

const defaultStripeClientFactory: StripeClientFactory = (apiKey) =>
  new Stripe(apiKey) as unknown as StripeCheckoutRetrievalClient;

/**
 * Slice 7 addition: the only safe, non-secret piece of data this
 * verification hands back to its caller -- the Checkout Session's own
 * hosted-payment URL, for the manual-payment handoff (see
 * `runPrePaymentReadinessPhase`'s module doc comment for the two-stage
 * workflow). `null` when Stripe's response doesn't include one (e.g. an
 * already-completed or expired session) -- a missing URL is an
 * operational inconvenience for the manual handoff, not a safety failure,
 * so it never causes this function to throw.
 */
export type CheckoutSessionVerificationResult = {
  readonly checkoutUrl: string | null;
};

/**
 * Re-verifies, from Stripe's own API response (not from anything the
 * harness assumed earlier), that the given Checkout Session is genuinely
 * test-mode and resolves cleanly through the configured connected account
 * -- "the connected-account/session context matches the expected test
 * environment where practical." A retrieval failure (wrong account,
 * session not found, network error) is exactly the "mode/account context
 * is ambiguous" case the caller must fail closed on, so it's treated the
 * same as a livemode mismatch: refuse to proceed.
 */
export async function verifyCheckoutSessionIsTestMode(params: {
  sessionId: string;
  connectedAccountId: string;
  context: string;
  createStripeClient?: StripeClientFactory;
}): Promise<CheckoutSessionVerificationResult> {
  const { sessionId, connectedAccountId, context } = params;
  const createStripeClient = params.createStripeClient ?? defaultStripeClientFactory;

  const testModeKey = assertPaymentHarnessStripeTestModeKey();
  const stripeClient = createStripeClient(testModeKey);

  let session: { livemode?: unknown; url?: unknown };
  try {
    session = await stripeClient.checkout.sessions.retrieve(
      sessionId,
      {},
      { stripeAccount: connectedAccountId },
    );
  } catch {
    // Never interpolate the underlying error -- it may echo back
    // request details; only the fact that retrieval failed matters here.
    throw new PaymentHarnessSafetyError(
      `Fail-closed (${context}): could not retrieve the Checkout Session to verify its test-mode ` +
        `status. Refusing to proceed with an unverifiable session/account context.`,
      "CHECKOUT_SESSION_CONTEXT_AMBIGUOUS",
    );
  }

  assertStripeObjectIsTestMode(session, context);

  return Object.freeze({
    checkoutUrl: typeof session.url === "string" ? session.url : null,
  });
}
