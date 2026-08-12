/**
 * Payment Harness (dev/QA Stripe test-mode) — shared types.
 *
 * Deliberately independent of src/lib/synthetic/types.ts. The Production
 * Synthetic Harness's non-capturing guarantee rests on being structurally
 * incapable of creating payments; the Payment Harness's whole purpose is
 * the opposite (real Stripe test-mode sessions in dev/QA only). Sharing a
 * types/config/guards module between the two would let a future change
 * made for this harness silently affect the other's safety posture. Only
 * *patterns* are reused (see guards.ts/deployment.ts doc comments), never
 * runtime imports across the two module trees.
 *
 * Slice 1 scope only: the environment/tenant-identity types this slice's
 * config and guards actually need. No browser, Stripe, evidence, or
 * fixture types here yet -- those are added in the slices that need them.
 */

/**
 * Environments the Payment Harness is allowed to run in at all. This is a
 * positive allowlist, not a "not production" negative check -- an
 * environment value that isn't literally one of these two is rejected by
 * default, including values nobody has thought of yet.
 */
export const PAYMENT_HARNESS_ALLOWED_ENVIRONMENTS = ["development", "preview"] as const;

export type PaymentHarnessEnvironment = (typeof PAYMENT_HARNESS_ALLOWED_ENVIRONMENTS)[number];

/**
 * The harness's fully-resolved, validated configuration. Every field here
 * has already passed its own fail-closed check by the time this type is
 * constructed -- there is no "config with some fields possibly missing"
 * intermediate state exposed to callers.
 */
export type PaymentHarnessConfig = {
  readonly studioId: string;
  readonly clientId: string;
  readonly environment: PaymentHarnessEnvironment;
};
