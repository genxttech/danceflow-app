import { assertPaymentHarnessEnvironmentAllowed } from "@/lib/payment-harness/guards";
import type { PaymentHarnessEnvironment } from "@/lib/payment-harness/types";

/**
 * Resolves and validates the environment the Payment Harness is running
 * in. `PAYMENT_HARNESS_ENVIRONMENT` takes precedence when set explicitly;
 * `VERCEL_ENV` is the fallback for runs where Vercel already sets it.
 * Deliberately does **not** fall back to `NODE_ENV` or any
 * `SYNTHETIC_*`/application env var -- an unresolved environment is a
 * fail-closed condition, not something to guess at from an unrelated
 * variable.
 *
 * Validation is delegated entirely to
 * assertPaymentHarnessEnvironmentAllowed's positive allowlist check, so
 * there is exactly one place that decides which environment values are
 * acceptable -- this function never itself special-cases "production" or
 * any other value. `production`, `test`, and every value not on the
 * allowlist are all rejected the same way: by not being `development` or
 * `preview`, not by a negative "is this production" check.
 */
export function resolvePaymentHarnessEnvironment(): PaymentHarnessEnvironment {
  const raw =
    process.env.PAYMENT_HARNESS_ENVIRONMENT?.trim() ||
    process.env.VERCEL_ENV?.trim() ||
    null;

  assertPaymentHarnessEnvironmentAllowed(raw, "environment resolution");

  return raw;
}
