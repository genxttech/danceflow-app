/**
 * CF1 Stripe-TEST acceptance: first Stripe compatibility check (the "guard"), before any registration is built.
 *
 * Accepted keys: sk_test_ (standard) or rk_test_ (restricted) ONLY; never a live key. Restricted keys are supported (permission list in
 * docs/qa/cf1-stripe-test/RESTRICTED_KEY_PERMISSIONS.md); a missing permission is reported as its own failure kind with Stripe's exact error.
 * Order. Identity and account-state failures are FATAL (nothing else is attempted). The three canaries then run INDEPENDENTLY, so one refusal never hides the
 * others' answers; any canary failure still fails the run, and every failure is reported with Stripe's exact error:
 *   1. identity: a TEST key; a standard key must read its own account and equal the pinned sandbox platform; a restricted key proves its platform by
 *      retrieving the PINNED connected account (only the owning platform's key can);
 *   2. connected account: read and RECORD its state (restricted, capabilities, outstanding requirement count). Not a gate: a sandbox may accept
 *      Checkout before `card_payments` is active (Stripe sandbox docs), so the state is evidence, not a verdict;
 *   3. canary C (first, owner decision 2026-11-20): a direct $1 PaymentIntent on the connected account, confirmed with a TEST card and the same application fee
 *      (documented endpoints only): proves the ACCOUNT can take a card payment and carry the fee, whatever key type is used and whether or not Checkout works;
 *   4. canary A: create one $1 Checkout Session on the connected account WITH an application fee, then expire it. This proves session creation only;
 *   5. canary D1 (no payment): a competition-shaped session (metadata source + order_id) is created open and never paid; the REAL retrieve feeds
 *      verifySettlementWithStripe with a forged "paid" event, which must REFUSE; the session is expired, retrieved again and must be refused again;
 *   6. canary D2 (no extra Stripe call): a synthetic complete+paid session built around canary C's REAL succeeded PaymentIntent must be accepted by the
 *      PaymentIntent half of verifySettlementWithStripe and refused when the amount is off by one cent. It proves PaymentIntent field semantics ONLY,
 *      NOT a paid Checkout Session.
 * Canary B (hosted-Checkout browser payment) is RETIRED (owner decision 2026-11-22, Path A): it never runs, opens no browser and cannot fail the run. Every
 * report states: "Checkout-hosted payment completion: NOT PROVEN (not attempted under Path A)" (run 44860275089: Stripe's anti-automation).
 * Effects are injected (a Stripe-shaped object), so the unit tests need no Stripe account. Nothing here logs a key; only Stripe's error fields
 * (type, code, message, param, request id) are reported, because the run must STOP and quote the exact error before any onboarding is requested.
 */
import type Stripe from "stripe";
import { assertTestKey, redactSecrets } from "./stripeRelay";
import { randomUUID } from "node:crypto";
import { COMPETITION_REGISTRATION_SOURCE, verifySettlementWithStripe, type SettlementStripeReader } from "../competition/registrationLifecycle";

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

export type GuardConfig = { expectPlatform: string; connectedAccount: string; successUrl: string; cancelUrl: string; applicationFeeCents?: number };

/** Stated in every report (also when a precondition stops the run): Path A never attempts a hosted-Checkout payment. */
export const CHECKOUT_PAYMENT_NOT_PROVEN = "Checkout-hosted payment completion: NOT PROVEN (not attempted under Path A)";

export type GuardReport = {
  ok: boolean;
  steps: Array<{ name: string; ok: boolean; status?: "PASS" | "FAIL" | "NOT PROVEN"; detail?: Record<string, unknown> }>;
  /** Things this run does not prove, stated plainly. */
  notProven: string[];
  connected?: Record<string, unknown>;
  /** Every failure, precondition or canary (a failing canary does not hide the others). `stop` is the most severe one and drives the exit code. */
  failures?: Array<{ step: string; failure: StripeFailure }>;
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
  for (const step of safe.steps) lines.push(`- ${step.status ?? (step.ok ? "PASS" : "FAIL")}: ${step.name}${step.detail ? ` ${JSON.stringify(step.detail)}` : ""}`);
  for (const item of safe.notProven ?? []) lines.push(`- NOT PROVEN: ${item}`);
  if (safe.connected) lines.push("", `connected account: \`${JSON.stringify(safe.connected)}\``);
  if (safe.stop) lines.push("", `**${safe.stop.message}**`, "", `step: ${safe.stop.step}`, "", "```json", JSON.stringify(safe.stop.failure, null, 2), "```");
  const others = (safe.failures ?? []).filter((f) => f.step !== safe.stop?.step);
  for (const f of others) lines.push("", `also failed: ${f.step}`, "", "```json", JSON.stringify(f.failure, null, 2), "```");
  return redactSecrets(lines.join("\n"));
}

type StripeLike = Pick<Stripe, "accounts" | "balance" | "checkout" | "paymentIntents"> & { rawRequest: Stripe["rawRequest"] };

/** A masked id for the report: the Stripe prefix and the last four characters only. */
export function maskId(id: unknown): string {
  const text = String(id ?? "");
  const prefix = /^[a-z]+_(test_)?/.exec(text)?.[0] ?? "";
  return text.length > prefix.length + 4 ? `${prefix}...${text.slice(-4)}` : `${prefix}...`;
}

/** A canary that could not be evaluated because its input was never produced: reported NOT PROVEN, and the run still fails. */
class NotProvenError extends Error {}

const REFUSED = /^Competition settlement refused: /;

const sessionParams = (config: GuardConfig, label: string, metadata: Record<string, string> = { cf1_canary: label }): Stripe.Checkout.SessionCreateParams => ({
  mode: "payment",
  line_items: [{ quantity: 1, price_data: { currency: "usd", unit_amount: 100, product_data: { name: `CF1 acceptance canary ${label}` } } }],
  payment_intent_data: { application_fee_amount: config.applicationFeeCents ?? 10 },
  success_url: config.successUrl, cancel_url: config.cancelUrl,
  metadata,
});

/**
 * The fee must be recorded on BOTH the PaymentIntent and the charge. On the charge the documented amount field (`application_fee_amount`) is the assertion;
 * the fee object (`application_fee`) is accepted as the alternative evidence. A wrong amount is a failure even when a fee object exists, and when neither is
 * present the error says exactly which fields were seen (types and numbers only, never ids), so the next step needs no guessing.
 */
export function assertFeeRecorded(intent: { application_fee_amount?: number | null }, charge: Stripe.Charge | null | undefined, fee: number): void {
  if (intent.application_fee_amount !== fee) throw new Error(`application fee on the PaymentIntent is ${intent.application_fee_amount}, expected ${fee}`);
  const onCharge = charge?.application_fee_amount;
  const feeObject = charge?.application_fee;
  const seen = `charge.application_fee_amount=${onCharge ?? "null"}, charge.application_fee=${feeObject ? typeof feeObject : "null"}`;
  if (!charge) throw new Error(`the PaymentIntent has no charge to inspect (${seen})`);
  if (onCharge != null && onCharge !== fee) throw new Error(`the charge records application fee ${onCharge}, expected ${fee} (${seen})`);
  if (onCharge !== fee && !feeObject) throw new Error(`the charge does not record the application fee (${seen})`);
}

const FAILURE_PRIORITY: StripeFailure["kind"][] = ["authentication", "capability", "permission", "other"];

export async function runStripeGuard(input: { stripe: StripeLike; key: string; config: GuardConfig }): Promise<GuardReport> {
  const { stripe, key, config } = input;
  const failures: Array<{ step: string; failure: StripeFailure }> = [];
  const report: GuardReport = { ok: false, steps: [], notProven: [CHECKOUT_PAYMENT_NOT_PROVEN], failures };
  const onAccount = { stripeAccount: config.connectedAccount };
  const fee = config.applicationFeeCents ?? 10;
  const ALL = ["canary C", "canary A", "canary D1", "canary D2"];

  // ---- Preconditions: any failure here is fatal and nothing else is attempted (no live key, wrong platform or unreadable account can reach a canary).
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
  } catch (error) {
    const failure = classifyStripeError(error);
    report.steps.push({ name: step, ok: false });
    failures.push({ step, failure });
    const lead = failure.kind === "permission"
      ? "STOP: the key lacks a Stripe permission (Stripe names it in the error below). Do not request sandbox onboarding. Report the exact error to the owner: the permission is added to the SAME restricted key, or the step is declared unsupported for restricted keys; never switch to another key silently."
      : failure.kind === "capability" ? "STOP: a connected-account capability error. Do not request sandbox onboarding; report the exact Stripe error below to the owner first."
        : failure.kind === "authentication" ? "STOP: Stripe rejected the key." : "STOP: the guard failed.";
    report.stop = { step, failure, message: `${lead} Not attempted: ${ALL.join(", ")}. ${CHECKOUT_PAYMENT_NOT_PROVEN}.` };
    return report;
  }

  // ---- Canaries. Each runs independently, so one failure never hides the others' answers; the run still FAILS (non-zero exit) if any canary fails.
  let canaryCIntent: Stripe.PaymentIntent | null = null;
  const canaries: Array<{ id: string; name: string; run: () => Promise<{ name: string; detail?: Record<string, unknown> }> }> = [
    {
      // Documented endpoints only (so a restricted key can run it): a direct $1 PaymentIntent on the connected account, confirmed with a TEST card, WITH the
      // same application fee. It answers the capability question independently of whether the key may drive a hosted Checkout page.
      id: "C", name: "canary C: confirm a $1 direct PaymentIntent with a TEST card and an application fee (documented endpoints only)",
      run: async () => {
        const direct = await stripe.paymentIntents.create({
          amount: 100, currency: "usd", payment_method: "pm_card_visa", confirm: true, application_fee_amount: fee,
          automatic_payment_methods: { enabled: true, allow_redirects: "never" }, metadata: { cf1_canary: "C-direct" }, expand: ["latest_charge"],
        }, onAccount);
        if (direct.status !== "succeeded") throw new Error(`PaymentIntent is ${direct.status}, not succeeded`);
        if (direct.amount_received !== 100) throw new Error(`received ${direct.amount_received} cents, expected 100`);
        assertFeeRecorded(direct, direct.latest_charge as Stripe.Charge | null, fee);
        canaryCIntent = direct;
        return { name: "canary C: card payment confirmed on the connected account with the application fee recorded on the PaymentIntent and the charge (the ACCOUNT can take TEST card payments)", detail: { amount_received: direct.amount_received, application_fee_amount: direct.application_fee_amount } };
      },
    },
    {
      id: "A", name: "canary A: create and expire a $1 Checkout Session with an application fee",
      run: async () => {
        const created = await stripe.checkout.sessions.create(sessionParams(config, "A-expire"), onAccount);
        try {
          if (created.livemode !== false || created.status !== "open") throw new Error("canary session is not an open TEST session");
        } finally {
          const expired = await stripe.checkout.sessions.expire(created.id, {}, onAccount);
          if (expired.status !== "expired") throw new Error("canary session did not expire");
        }
        return { name: "canary A: session created with an application fee and expired (session creation only; NOT payment)" };
      },
    },
    {
      // No payment: a competition-shaped session that stays unpaid. The REAL retrieve feeds the production verifier, which must refuse a forged paid event.
      id: "D1", name: "canary D1: the settlement verifier refuses a forged paid event for a real unpaid, then expired, competition-shaped session",
      run: async () => {
        const orderId = randomUUID();
        const created = await stripe.checkout.sessions.create(sessionParams(config, "D1-settlement", { source: COMPETITION_REGISTRATION_SOURCE, order_id: orderId }), onAccount);
        let last: Stripe.Checkout.Session | null = null;
        const reader: SettlementStripeReader = {
          checkout: { sessions: { retrieve: async (id, params, options) => { last = await stripe.checkout.sessions.retrieve(id, params, options); return last; } } },
        };
        // What a forged but validly signed event would claim: the same id, amount and currency, marked paid.
        const forged = (): Stripe.Checkout.Session => ({
          id: created.id, object: "checkout.session", mode: "payment", livemode: false, metadata: { source: COMPETITION_REGISTRATION_SOURCE, order_id: orderId },
          amount_total: created.amount_total, currency: created.currency, status: "complete", payment_status: "paid", payment_intent: null,
        } as unknown as Stripe.Checkout.Session);
        // A refusal for the RIGHT reason only: Stripe's own record must say the session is not complete and paid (a binding or mode mismatch would be a false pass).
        const expectRefusal = async (phase: string) => {
          let outcome: "accepted" | "refused" = "accepted";
          try {
            await verifySettlementWithStripe(reader, { eventSession: forged(), accountId: config.connectedAccount, orderId });
          } catch (error) {
            const message = error instanceof Error ? error.message : "";
            if (!REFUSED.test(message)) throw error;
            if (!/Stripe does not show the session as complete and paid/.test(message)) throw new Error(`the verifier refused the ${phase} session for a different reason than an unpaid session: ${message.slice(0, 200)}`);
            outcome = "refused";
          }
          if (outcome === "accepted") throw new Error(`the settlement verifier ACCEPTED a forged paid event for an ${phase} session`);
        };
        let primary: unknown;
        try {
          if (created.livemode !== false || created.status !== "open") throw new Error("canary D1 session is not an open TEST session");
          await expectRefusal("open");
          const seen = last as Stripe.Checkout.Session | null;
          if (!seen || seen.status !== "open" || seen.payment_status !== "unpaid" || seen.livemode !== false) throw new Error(`the retrieved session is ${seen?.status}/${seen?.payment_status}, expected open/unpaid in TEST mode`);
          if (seen.metadata?.source !== COMPETITION_REGISTRATION_SOURCE || seen.metadata?.order_id !== orderId) throw new Error("the retrieved session lost the competition metadata");
        } catch (error) { primary = error; }
        try {
          const expired = await stripe.checkout.sessions.expire(created.id, {}, onAccount);
          if (expired.status !== "expired") throw new Error("canary D1 session did not expire");
        } catch (error) { primary ??= error; }
        if (primary) throw primary;
        await expectRefusal("expired");
        const after = last as Stripe.Checkout.Session | null;
        if (!after || after.status !== "expired") throw new Error(`the retrieved session is ${after?.status}, expected expired`);
        return { name: "canary D1: the settlement verifier refused the forged paid event while the real session was open and again once it was expired (no payment made)", detail: { session: maskId(created.id), refused_open: true, refused_expired: true } };
      },
    },
    {
      // PaymentIntent field semantics against a REAL succeeded object (canary C's). The session around it is synthetic: this is NOT a paid Checkout Session.
      id: "D2", name: "canary D2: the settlement verifier's PaymentIntent checks against canary C's real succeeded PaymentIntent",
      run: async () => {
        const intent = canaryCIntent as Stripe.PaymentIntent | null;
        if (!intent) throw new NotProvenError("NOT PROVEN: canary C produced no succeeded PaymentIntent to examine");
        if (intent.application_fee_amount !== fee) throw new Error(`the real PaymentIntent carries application fee ${intent.application_fee_amount}, expected ${fee}`);
        const orderId = randomUUID();
        const currency = intent.currency;
        const verifyAt = (sessionAmount: number) => {
          const live = {
            id: "cs_test_synthetic_d2", object: "checkout.session", mode: "payment", livemode: false, metadata: { source: COMPETITION_REGISTRATION_SOURCE, order_id: orderId },
            amount_total: sessionAmount, currency, status: "complete", payment_status: "paid", payment_intent: intent,
          } as unknown as Stripe.Checkout.Session;
          const reader: SettlementStripeReader = { checkout: { sessions: { retrieve: async () => live } } };
          const event = { ...live, payment_intent: intent.id } as unknown as Stripe.Checkout.Session;
          return verifySettlementWithStripe(reader, { eventSession: event, accountId: config.connectedAccount, orderId });
        };
        const verified = await verifyAt(intent.amount_received);
        if (verified.paymentIntentId !== intent.id || verified.amountCents !== intent.amount_received || verified.currency !== currency.toUpperCase()) throw new Error("the verifier accepted the real PaymentIntent but returned different values");
        for (const delta of [1, -1]) {
          let refused = false;
          try { await verifyAt(intent.amount_received + delta); } catch (error) {
            const message = error instanceof Error ? error.message : "";
            if (!REFUSED.test(message) || !/PaymentIntent amount received does not match the session/.test(message)) throw error;
            refused = true;
          }
          if (!refused) throw new Error(`the verifier accepted a session amount ${delta > 0 ? "one cent above" : "one cent below"} the real PaymentIntent's amount received`);
        }
        return { name: "canary D2: the PaymentIntent half of the settlement verifier accepted the real succeeded PaymentIntent and refused an amount off by one cent (PaymentIntent field semantics ONLY; NOT a paid Checkout Session)", detail: { payment_intent: maskId(intent.id), amount_received: intent.amount_received, application_fee_amount: intent.application_fee_amount } };
      },
    },
  ];
  for (const canary of canaries) {
    try {
      const result = await canary.run();
      report.steps.push({ name: result.name, ok: true, status: "PASS", detail: result.detail });
    } catch (error) {
      report.steps.push({ name: canary.name, ok: false, status: error instanceof NotProvenError ? "NOT PROVEN" : "FAIL" });
      failures.push({ step: canary.name, failure: classifyStripeError(error) });
    }
  }

  if (failures.length === 0) {
    report.ok = true;
    return report;
  }
  const primary = [...failures].sort((a, b) => FAILURE_PRIORITY.indexOf(a.failure.kind) - FAILURE_PRIORITY.indexOf(b.failure.kind))[0];
  const failedIds = failures.map((f) => /^canary \w+/.exec(f.step)?.[0] ?? f.step.slice(0, 8));
  const passedIds = ALL.filter((id) => report.steps.some((s) => s.ok && s.name.startsWith(id)));
  const accountProven = passedIds.includes("canary C");
  const tally = `${failures.length} of ${canaries.length} canaries failed (${failedIds.join(", ")}); passed: ${passedIds.length ? passedIds.join(", ") : "none"}. ${CHECKOUT_PAYMENT_NOT_PROVEN}.`;
  const lead = primary.failure.kind === "capability"
    ? (accountProven && !primary.step.startsWith("canary C")
      ? "STOP: Checkout is blocked by a connected-account setup error. Canary C PASSED, so the connected ACCOUNT can take TEST card payments with an application fee; only Checkout is blocked. Do not request sandbox onboarding; report the exact Stripe error below to the owner first."
      : "STOP: a connected-account capability error. Do not request sandbox onboarding; report the exact Stripe error below to the owner first.")
    : primary.failure.kind === "permission"
      ? `STOP: the key lacks a Stripe permission (Stripe names it in the error below). ${accountProven ? "Canary C PASSED, so the connected ACCOUNT can take TEST card payments with an application fee; the limit is the KEY, not the account. " : ""}Do not request sandbox onboarding. Report the exact error to the owner: the permission is added to the SAME restricted key, or the step is declared unsupported for restricted keys; never switch to another key silently.`
      : primary.failure.kind === "authentication" ? "STOP: Stripe rejected the key." : "STOP: the guard failed.";
  report.stop = { step: primary.step, failure: primary.failure, message: `${lead} ${tally}` };
  return report;
}
