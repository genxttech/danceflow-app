import {
  PAYMENT_HARNESS_ALLOWED_ENVIRONMENTS,
  type PaymentHarnessConfig,
  type PaymentHarnessEnvironment,
} from "@/lib/payment-harness/types";

/**
 * Fail-closed safety error for the Payment Harness. Deliberately a
 * separate class from src/lib/synthetic/types.ts's SyntheticSafetyError --
 * see types.ts's module doc comment for why these two harnesses never
 * share runtime code. Every guard in this file throws this and only this;
 * there is no warn-and-continue path anywhere in the harness.
 */
export class PaymentHarnessSafetyError extends Error {
  code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "PaymentHarnessSafetyError";
    this.code = code;
  }
}

/**
 * Re-assertable environment guard. deployment.ts performs the *initial*
 * resolution (turning env vars into a valid value or throwing); this
 * guard lets any later code -- not just the one startup call site --
 * re-confirm a config's environment is still on the allowlist before a
 * write, the same "check before every write, not just once" discipline
 * the Production Synthetic Harness's assertSyntheticStudio uses.
 */
export function assertPaymentHarnessEnvironmentAllowed(
  environment: string | null | undefined,
  context: string,
): asserts environment is PaymentHarnessEnvironment {
  if (
    !environment ||
    !(PAYMENT_HARNESS_ALLOWED_ENVIRONMENTS as readonly string[]).includes(environment)
  ) {
    throw new PaymentHarnessSafetyError(
      `Fail-closed (${context}): "${environment ?? "unset"}" is not on the Payment Harness ` +
        `environment allowlist (${PAYMENT_HARNESS_ALLOWED_ENVIRONMENTS.join(", ")}). Refusing to proceed.`,
      "ENVIRONMENT_NOT_ALLOWED",
    );
  }
}

/**
 * Call before every write that touches a studio-scoped record, with
 * whatever studio_id the operation is about to act on. This is the single
 * most important check in the whole harness -- mirrors
 * src/lib/synthetic/guards.ts's assertSyntheticStudio exactly in shape and
 * intent, reimplemented independently against the Payment Harness's own
 * configured tenant rather than importing the synthetic one.
 */
export function assertPaymentHarnessStudio(
  config: PaymentHarnessConfig,
  resolvedStudioId: string | null | undefined,
  context: string,
): void {
  if (!resolvedStudioId || resolvedStudioId !== config.studioId) {
    throw new PaymentHarnessSafetyError(
      `Fail-closed (${context}): resolved studio_id does not match the configured Payment ` +
        `Harness studio. Refusing to proceed.`,
      "STUDIO_MISMATCH",
    );
  }
}

/**
 * Call before every write that touches a client-scoped record, with
 * whatever client_id the operation is about to act on. Independent of
 * assertPaymentHarnessStudio -- a caller that only resolved a client id
 * (not yet a studio id) can still fail closed immediately rather than
 * proceeding on the studio check alone.
 */
export function assertPaymentHarnessClient(
  config: PaymentHarnessConfig,
  resolvedClientId: string | null | undefined,
  context: string,
): void {
  if (!resolvedClientId || resolvedClientId !== config.clientId) {
    throw new PaymentHarnessSafetyError(
      `Fail-closed (${context}): resolved client_id does not match the configured Payment ` +
        `Harness client. Refusing to proceed.`,
      "CLIENT_MISMATCH",
    );
  }
}

/**
 * Call wherever a run's explicit "yes, I mean to do this" confirmation
 * needs to be re-checked -- e.g. immediately before the first Stripe call
 * a later slice adds, not only once during CLI argument parsing. Kept
 * intentionally trivial (a boolean in, throw-or-not out) so it has no
 * dependency on how confirmation was actually collected (CLI flag,
 * environment variable, etc. -- that parsing belongs to a later slice's
 * CLI entry point, not here).
 */
export function assertConfirmed(confirmed: boolean, context: string): void {
  if (!confirmed) {
    throw new PaymentHarnessSafetyError(
      `Fail-closed (${context}): this run was not explicitly confirmed. Refusing to proceed.`,
      "NOT_CONFIRMED",
    );
  }
}
