/**
 * CF1 Stripe-TEST acceptance: first Stripe compatibility check (the "guard"), before any registration is built.
 *
 * Accepted keys: sk_test_ (standard) or rk_test_ (restricted) ONLY; never a live key. Restricted keys are supported (permission list in
 * docs/qa/cf1-stripe-test/RESTRICTED_KEY_PERMISSIONS.md); a missing permission is reported as its own failure kind with Stripe's exact error.
 * Order, each step stopping the run on failure with Stripe's exact error:
 *   1. identity: a TEST key; a standard key must read its own account and equal the pinned sandbox platform; a restricted key proves its platform by
 *      retrieving the PINNED connected account (only the owning platform's key can);
 *   2. connected account: read and RECORD its state (restricted, capabilities, outstanding requirement count). Not a gate: a sandbox may accept
 *      Checkout before `card_payments` is active (Stripe sandbox docs), so the state is evidence, not a verdict;
 *   3. canary C (first, owner decision 2026-11-20): a direct $1 PaymentIntent on the connected account, confirmed with a TEST card and the same application fee
 *      (documented endpoints only): proves the ACCOUNT can take a card payment and carry the fee, whatever key type is used and whether or not Checkout works;
 *   4. canary A: create one $1 Checkout Session on the connected account WITH an application fee, then expire it. This proves session creation only;
 *   5. canary B (Checkout payment probe): create a second $1 session, pay it through the payment page (an undocumented endpoint that no restricted-key
 *      permission is documented to cover) with a TEST card, and verify the session is paid and the fee is on the PaymentIntent and the charge.
 *      B needs a Checkout Session, so it cannot run if A is refused; the report lists every canary that was not attempted.
 * Effects are injected (a Stripe-shaped object), so the unit tests need no Stripe account. Nothing here logs a key; only Stripe's error fields
 * (type, code, message, param, request id) are reported, because the run must STOP and quote the exact error before any onboarding is requested.
 */
import type Stripe from "stripe";
import { assertTestKey, redactSecrets } from "./stripeRelay";

export type StripeFailure = {
  kind: "capability" | "permission" | "authentication" | "other";
  type?: string; code?: string; param?: string; message: string; requestId?: string; statusCode?: number;
};

const CAPABILITY_CODES = new Set(["account_invalid", "platform_account_required", "capability_not_enabled", "transfers_not_enabled", "charges_not_enabled", "account_country_invalid_address"]);
const PERMISSION_TEXT = /required permissions?|does not have the required permission|rak_[a-z_]+_(read|write)|permission would allow/i;
const CAPABILITY_TEXT = /set an account or business name|capabilit|card_payments|transfers|charges (are )?not enabled|cannot (create|accept|process) (charges|payments)|not (yet )?(enabled|activated)|restricted|requirements|onboarding|verification/i;

/** Stripe's own error fields, with nothing added. A capability-class failure is identified by code or wording so the run can say STOP before onboarding. */
export function classifyStripeError(error: unknown): StripeFailure {
  const e = error as { type?: string; code?: string; param?: string; message?: string; requestId?: string; statusCode?: number; raw?: { type?: string; code?: string; param?: string; message?: string; request_id?: string; statusCode?: number } };
  const raw = e?.raw ?? {};
  // Every string field is masked, not just the message: a credential must not reach a log, a summary or a file through any Stripe error field.
  const safe = (value: unknown) => (typeof value === "string" ? redactSecrets(value) : undefined);
  const failure: StripeFailure = {
    type: safe(e?.type ?? raw.type), code: safe(e?.code ?? raw.code), param: safe(e?.param ?? raw.param),
    message: redactSecrets(String(e?.message ?? raw.message ?? error ?? "unknown error")).slice(0, 600),
    requestId: safe(e?.requestId ?? raw.request_id), statusCode: typeof (e?.statusCode ?? raw.statusCode) === "number" ? (e?.statusCode ?? raw.statusCode) : undefined,
    kind: "other",
  };
  // A restricted key missing a permission is NOT an account-capability problem even though Stripe's text says "restricted": it is checked first.
  if (failure.type === "StripeAuthenticationError" || failure.statusCode === 401) failure.kind = "authentication";
  else if (failure.type === "StripePermissionError" || failure.statusCode === 403 || PERMISSION_TEXT.test(failure.message)) failure.kind = "permission";
  else if ((failure.code && CAPABILITY_CODES.has(failure.code)) || CAPABILITY_TEXT.test(failure.message)) failure.kind = "capability";
  return failure;
}

export type GuardConfig = { expectPlatform: string; connectedAccount: string; successUrl: string; cancelUrl: string; applicationFeeCents?: number; cardToken?: string };

export type GuardReport = {
  ok: boolean;
  steps: Array<{ name: string; ok: boolean; detail?: Record<string, unknown> }>;
  connected?: Record<string, unknown>;
  stop?: { step: string; failure: StripeFailure; message: string };
};

/**
 * The only way a report leaves the process. The WHOLE report is serialized and masked (step names, details, the connected-account state, every
 * Stripe error field), so nothing that reaches stdout, the job summary or the report file can carry a key, a webhook secret or a JWT.
 * Masking never touches JSON structure (tokens contain no quotes or backslashes), so the output still parses.
 */
export function serializeReport(report: GuardReport): string {
  return redactSecrets(JSON.stringify(report, null, 2));
}

export function redactReport(report: GuardReport): GuardReport {
  return JSON.parse(serializeReport(report)) as GuardReport;
}

export function summarizeReport(report: GuardReport): string {
  const safe = redactReport(report);
  const lines = [safe.ok ? "## Stripe guard: PASSED" : "## Stripe guard: STOPPED", ""];
  for (const step of safe.steps) lines.push(`- ${step.ok ? "ok" : "FAILED"}: ${step.name}${step.detail ? ` ${JSON.stringify(step.detail)}` : ""}`);
  if (safe.connected) lines.push("", `connected account: \`${JSON.stringify(safe.connected)}\``);
  if (safe.stop) lines.push("", `**${safe.stop.message}**`, "", `step: ${safe.stop.step}`, "", "```json", JSON.stringify(safe.stop.failure, null, 2), "```");
  return redactSecrets(lines.join("\n"));
}

type StripeLike = Pick<Stripe, "accounts" | "balance" | "checkout" | "paymentIntents"> & { rawRequest: Stripe["rawRequest"]; paymentMethods: Stripe["paymentMethods"] };

const sessionParams = (config: GuardConfig, label: string): Stripe.Checkout.SessionCreateParams => ({
  mode: "payment",
  line_items: [{ quantity: 1, price_data: { currency: "usd", unit_amount: 100, product_data: { name: `CF1 acceptance canary ${label}` } } }],
  payment_intent_data: { application_fee_amount: config.applicationFeeCents ?? 10 },
  success_url: config.successUrl, cancel_url: config.cancelUrl,
  metadata: { cf1_canary: label },
});

/** Pays an open Checkout Session in TEST mode through the payment page (the way `stripe trigger` does); returns nothing, throws Stripe's error. */
export async function payCheckoutSessionPlain(stripe: Pick<StripeLike, "rawRequest" | "checkout" | "paymentMethods">, account: string, sessionId: string, token = "tok_visa") {
  const onAccount = { stripeAccount: account };
  const page = (await stripe.rawRequest("GET", `/v1/payment_pages/${sessionId}`, {}, onAccount)) as unknown as { total_summary?: { due?: number }; livemode?: boolean };
  if (page.livemode !== false) throw new Error("payment page is not TEST mode");
  const session = await stripe.checkout.sessions.retrieve(sessionId, {}, onAccount);
  const method = await stripe.paymentMethods.create({ type: "card", card: { token }, billing_details: { name: "CF1 canary", email: session.customer_email ?? undefined } }, onAccount);
  await stripe.rawRequest("POST", `/v1/payment_pages/${sessionId}/confirm`, { payment_method: method.id, expected_amount: page.total_summary?.due }, onAccount);
}

export async function runStripeGuard(input: { stripe: StripeLike; key: string; config: GuardConfig }): Promise<GuardReport> {
  const { stripe, key, config } = input;
  const report: GuardReport = { ok: false, steps: [] };
  const onAccount = { stripeAccount: config.connectedAccount };
  const fee = config.applicationFeeCents ?? 10;
  let step = "key";
  try {
    assertTestKey(key);
    report.steps.push({ name: "key shape is a TEST key", ok: true });

    step = "identity";
    const restricted = key.startsWith("rk_test_");
    const balance = await stripe.balance.retrieve();
    if (balance.livemode) throw new Error("the key is a live key");
    if (!restricted) {
      // A standard key can read its own account: the platform id must equal the pinned sandbox platform.
      const platform = (await stripe.rawRequest("GET", "/v1/account", {})) as unknown as { id?: string };
      if (platform.id !== config.expectPlatform) throw new Error("the key belongs to a different Stripe account than the pinned sandbox platform");
      report.steps.push({ name: "identity: TEST key on the pinned sandbox platform (GET /v1/account equals the pin)", ok: true });
    }

    step = "connected account";
    // Only the owning platform's key can retrieve a connected account, so with a restricted key (no documented permission for GET /v1/account in the
    // least-privilege set) retrieving the PINNED connected account is the identity proof. It is deterministic by key type, not a fallback.
    const account = await stripe.accounts.retrieve(config.connectedAccount);
    if (account.id !== config.connectedAccount) throw new Error("connected account id mismatch");
    if (restricted) report.steps.push({ name: `identity: restricted TEST key owns the pinned connected account (platform ${config.expectPlatform} is proven through it, not read directly)`, ok: true });
    report.connected = {
      id: account.id, charges_enabled: account.charges_enabled, payouts_enabled: account.payouts_enabled,
      card_payments: account.capabilities?.card_payments ?? null, transfers: account.capabilities?.transfers ?? null,
      currently_due_count: account.requirements?.currently_due?.length ?? null, disabled_reason: account.requirements?.disabled_reason ?? null,
    };
    report.steps.push({ name: "connected account state recorded (evidence, not a gate)", ok: true, detail: report.connected });

    // Canary C uses ONLY documented endpoints (so a restricted key can run it): a direct $1 PaymentIntent on the connected account, confirmed with a TEST card,
    // WITH the same application fee. It answers the capability question ("can this account take a card payment and carry the fee?") independently of
    // whether the key may drive a hosted Checkout page. It does not replace canary B.
    step = "canary C: confirm a $1 direct PaymentIntent with a TEST card and an application fee (documented endpoints only)";
    const direct = await stripe.paymentIntents.create({
      amount: 100, currency: "usd", payment_method: "pm_card_visa", confirm: true, application_fee_amount: fee,
      automatic_payment_methods: { enabled: true, allow_redirects: "never" }, metadata: { cf1_canary: "C-direct" }, expand: ["latest_charge"],
    }, onAccount);
    const directCharge = direct.latest_charge as Stripe.Charge | null;
    if (direct.status !== "succeeded") throw new Error(`PaymentIntent is ${direct.status}, not succeeded`);
    if (direct.amount_received !== 100) throw new Error(`received ${direct.amount_received} cents, expected 100`);
    if (direct.application_fee_amount !== fee) throw new Error(`application fee on the PaymentIntent is ${direct.application_fee_amount}, expected ${fee}`);
    if (!directCharge || !directCharge.application_fee) throw new Error("the charge carries no application fee");
    report.steps.push({ name: "canary C: card payment confirmed on the connected account with an application fee (the ACCOUNT can take TEST card payments)", ok: true, detail: { amount_received: direct.amount_received, application_fee_amount: direct.application_fee_amount } });

    step = "canary A: create and expire a $1 Checkout Session with an application fee";
    const created = await stripe.checkout.sessions.create(sessionParams(config, "A-expire"), onAccount);
    try {
      if (created.livemode !== false || created.status !== "open") throw new Error("canary session is not an open TEST session");
    } finally {
      const expired = await stripe.checkout.sessions.expire(created.id, {}, onAccount);
      if (expired.status !== "expired") throw new Error("canary session did not expire");
    }
    report.steps.push({ name: "canary A: session created with an application fee and expired (session creation only; NOT payment)", ok: true });

    step = "canary B: pay a $1 Checkout Session with a TEST card (payment page confirm)";
    const paying = await stripe.checkout.sessions.create(sessionParams(config, "B-pay"), onAccount);
    await payCheckoutSessionPlain(stripe, config.connectedAccount, paying.id, config.cardToken);
    const paid = await stripe.checkout.sessions.retrieve(paying.id, {}, onAccount);
    if (paid.status !== "complete" || paid.payment_status !== "paid") throw new Error(`session is ${paid.status}/${paid.payment_status}, not complete/paid`);
    const intent = await stripe.paymentIntents.retrieve(String(paid.payment_intent), { expand: ["latest_charge"] }, onAccount);
    const charge = intent.latest_charge as Stripe.Charge | null;
    if (intent.amount_received !== 100) throw new Error(`received ${intent.amount_received} cents, expected 100`);
    if (intent.application_fee_amount !== fee) throw new Error(`application fee on the PaymentIntent is ${intent.application_fee_amount}, expected ${fee}`);
    if (!charge || !charge.application_fee) throw new Error("the charge carries no application fee");
    report.steps.push({ name: "canary B: card payment confirmed; application fee recorded on the PaymentIntent and the charge", ok: true, detail: { amount_received: intent.amount_received, application_fee_amount: intent.application_fee_amount } });

    report.ok = true;
    return report;
  } catch (error) {
    const failure = classifyStripeError(error);
    const accountProven = report.steps.some((s) => s.ok && s.name.startsWith("canary C"));
    const notAttempted = ["canary C", "canary A", "canary B"].filter((name) => !step.startsWith(name) && !report.steps.some((s) => s.name.startsWith(name)));
    const tail = notAttempted.length ? ` Not attempted: ${notAttempted.join(", ")}.` : "";
    const prefix = failure.kind === "capability"
      ? (accountProven
        ? `STOP: Checkout is blocked by a connected-account setup error. Canary C PASSED, so the connected ACCOUNT can take TEST card payments with an application fee; only Checkout is blocked, and canary B (which needs a Checkout Session) cannot run.${tail} Do not request sandbox onboarding; report the exact Stripe error below to the owner first.`
        : `STOP: a connected-account capability error.${tail} Do not request sandbox onboarding; report the exact Stripe error below to the owner first.`)
      : failure.kind === "permission"
        ? `STOP: the key lacks a Stripe permission (Stripe names it in the error below). ${accountProven ? "Canary C PASSED, so the connected ACCOUNT can take TEST card payments with an application fee; the limit is the KEY, not the account. " : ""}${tail} Do not request sandbox onboarding. Report the exact error to the owner: the permission is added to the SAME restricted key, or the step is declared unsupported for restricted keys; never switch to another key silently.`
        : failure.kind === "authentication" ? "STOP: Stripe rejected the key." : `STOP: the guard failed.${tail}`;
    report.steps.push({ name: step, ok: false });
    report.stop = { step, failure, message: prefix };
    return report;
  }
}
