/**
 * D7 WP-3: guard rails for the bounded Stripe TEST-mode proof (docs/billing/D7-WP3-STRIPE-TESTMODE-PROOF-PLAN.md).
 *
 * The proof may only run against an explicitly approved, isolated TEST sandbox with a restricted TEST key. These helpers are
 * pure: they validate the key, the sandbox identity and each operation BEFORE any provider call, and redact credentials from
 * the evidence log. Nothing here calls Stripe.
 */

/** Exactly the operations the approved proof plan names; anything else is refused. */
export const PROOF_ALLOWED_OPERATIONS = [
  "accounts.retrieve",
  "testHelpers.testClocks.create",
  "testHelpers.testClocks.advance",
  "testHelpers.testClocks.del",
  "customers.create",
  "customers.update",
  "paymentMethods.attach",
  "products.create",
  "prices.create",
  "prices.retrieve",
  "subscriptions.create",
  "subscriptions.retrieve",
  "subscriptions.update",
  "subscriptionSchedules.create",
  "subscriptionSchedules.update",
  "subscriptionSchedules.retrieve",
  "subscriptionSchedules.release",
  "invoices.list",
  "coupons.create",
] as const;

export type ProofOperation = (typeof PROOF_ALLOWED_OPERATIONS)[number];

export type ProofKeyCheck = { ok: true; kind: "restricted_test" } | { ok: false; reason: string };

/** Only a restricted TEST key (rk_test_) is accepted; live keys of any kind and unrestricted test secrets are refused. */
export function validateProofKey(secret: string | undefined): ProofKeyCheck {
  const key = (secret ?? "").trim();
  if (!key) return { ok: false, reason: "no key supplied" };
  if (/_live_/.test(key)) return { ok: false, reason: "live keys are never allowed in the proof" };
  if (key.startsWith("rk_test_")) return { ok: true, kind: "restricted_test" };
  if (key.startsWith("sk_test_")) return { ok: false, reason: "an unrestricted test secret key is refused; use a restricted rk_test_ key scoped to the documented operations" };
  return { ok: false, reason: "unrecognised key format" };
}

export type SandboxIdentity = { ok: true } | { ok: false; reasons: string[] };

/** The retrieved account must be exactly the sandbox the owner approved, and must not be one of the excluded accounts. */
export function checkSandboxIdentity(input: { accountId: string; expectedAccountId: string | undefined; excludedAccountIds?: string[] }): SandboxIdentity {
  const reasons: string[] = [];
  if (!input.expectedAccountId) reasons.push("no approved sandbox account id supplied (--expected-account)");
  else if (input.accountId !== input.expectedAccountId) reasons.push("account is not the approved sandbox");
  if ((input.excludedAccountIds ?? []).includes(input.accountId)) reasons.push("account is on the excluded list (e.g. the C6 invoice-testing sandbox)");
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

export function assertOperationAllowed(operation: string): asserts operation is ProofOperation {
  if (!(PROOF_ALLOWED_OPERATIONS as readonly string[]).includes(operation)) {
    throw new Error(`operation not in the approved proof plan: ${operation}`);
  }
}

const SECRET_PATTERNS = [
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
  /\b(?:sk|rk|pk)_(?:test|live)_[A-Za-z0-9]+/g, /\bwhsec_[A-Za-z0-9]+/g, /\bBearer\s+[A-Za-z0-9._-]+/gi];

/** Redacts credentials from any text or JSON destined for the evidence log. */
export function redactSecrets<T>(value: T): T {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const cleaned = SECRET_PATTERNS.reduce((acc, pattern) => acc.replace(pattern, "[REDACTED]"), text);
  return (typeof value === "string" ? cleaned : JSON.parse(cleaned)) as T;
}

export type ProofLogEntry = { operation: string; at: string; request: unknown; response: unknown };

/** Appends an allowlisted, redacted request/response pair to the evidence log. */
export function recordProofEntry(log: ProofLogEntry[], operation: string, request: unknown, response: unknown, now: Date = new Date()): void {
  assertOperationAllowed(operation);
  log.push({ operation, at: now.toISOString(), request: redactSecrets(request), response: redactSecrets(response) });
}

/** The identity check needs only these facts about the account; owner e-mail, phone, URLs and business profile never enter the evidence. */
export function scrubAccountEvidence(account: unknown): Record<string, unknown> {
  const a = (account ?? {}) as Record<string, unknown>;
  return { id: a.id, object: a.object, type: a.type, country: a.country, charges_enabled: a.charges_enabled, details_submitted: a.details_submitted };
}
