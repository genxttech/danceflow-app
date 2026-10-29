import { getBillingPlan, type StudioPlanCode } from "@/lib/billing/plans";
import { PRICE_CONFIG_TOOL } from "./priceConfigReport";
import { PRICE_ID_SHAPE, STUDIO_PLANS, classifyStripeError, money } from "./priceVerifier";
import {
  blocked,
  buildReport,
  fail,
  pass,
  type BillingQaCheck,
  type BillingQaEvidenceValue,
  type BillingQaReport,
  type BillingQaStatus,
} from "./report";

/**
 * BILLING-QA-5. Read-back of an OWNER-RUN no-payment checkout smoke (docs/qa/billing-owner-smoke-kit.md).
 *
 * The owner creates one Checkout Session per plan in the deployed app, stops at Stripe's page without paying, and
 * passes the Session ids here with a restricted read-only key. This only ever READS (Checkout Sessions with their line
 * items, Subscriptions, and lists of both for one customer) and proves, per Session: it is a subscription Session on
 * exactly the expected Price and amount with DanceFlow's metadata, and it was NOT paid. Optional checks: the smoke
 * workspace got no subscription, an existing subscriber's checkout created no Session (it went to the Billing Portal),
 * and the grandfathered subscription is still on its legacy Price.
 *
 * Nothing is expired, cancelled or changed: open Sessions expire on their own after 24 hours.
 */

export const SESSION_READBACK_TOOL = "billing-qa smoke session read-back";

type LineItem = {
  quantity?: number | null;
  price?: { id?: string; unit_amount?: number | null; currency?: string | null; recurring?: { interval?: string | null; interval_count?: number | null } | null } | null;
};

export type ReadbackSession = {
  id: string;
  livemode?: unknown;
  mode?: string | null;
  status?: string | null;
  payment_status?: string | null;
  subscription?: string | { id: string } | null;
  customer?: string | { id: string } | null;
  created?: number;
  metadata?: Record<string, string> | null;
  line_items?: { data: LineItem[] } | null;
};

export type ReadbackSubscription = {
  id: string;
  livemode?: unknown;
  status?: string | null;
  items?: { data: Array<{ price?: { id?: string; unit_amount?: number | null } | null }> } | null;
};

/** The only Stripe calls this tool can make. */
export type BillingQaReadClient = {
  checkout: {
    sessions: {
      retrieve(id: string, params: { expand: ["line_items"] }): Promise<ReadbackSession>;
      list(params: { customer: string; created: { gte: number }; limit: number }): Promise<{ data: ReadbackSession[] }>;
    };
  };
  subscriptions: {
    retrieve(id: string): Promise<ReadbackSubscription>;
    list(params: { customer: string; created: { gte: number }; status: "all"; limit: number }): Promise<{ data: ReadbackSubscription[] }>;
  };
};

export type SmokeExpectations = {
  offer: "founder" | "standard";
  prices: Partial<Record<StudioPlanCode, string>>;
  /** Every configured grandfathered Price ID (any plan); the grandfathered subscription must still carry one of them. */
  legacyPriceIds: string[];
  /** Overall status of the BILLING-QA-4 report the expectations came from, when they came from one. */
  priceConfigOverall?: BillingQaStatus;
};

const SESSION_ID = /^cs_(live|test)_[A-Za-z0-9]+$/;
const MANAGED = new Set(["active", "trialing", "past_due"]);
const idOf = (value: string | { id: string } | null | undefined) => (typeof value === "string" ? value : value?.id ?? null);

/** Expectations from a BILLING-QA-4 price-config report (JSON) of the deployment being smoked. */
export function expectationsFromPriceConfig(report: unknown): SmokeExpectations {
  const r = report as { tool?: unknown; mode?: unknown; overall?: unknown; config?: Record<string, unknown> } | null;
  if (!r || r.tool !== PRICE_CONFIG_TOOL || r.mode !== "config" || !r.config) {
    throw new Error("not a BILLING-QA-4 price-config report");
  }
  const config = r.config;
  const offer = config.founderPricingActive === false && config.regularPricingActivated === true ? "standard" : "founder";
  const suffix = offer === "founder" ? "FOUNDER" : "STANDARD";
  const prices: SmokeExpectations["prices"] = {};
  for (const plan of STUDIO_PLANS) {
    const value = config[`STRIPE_PRICE_STUDIO_${plan.code.toUpperCase()}_${suffix}`];
    if (typeof value === "string" && PRICE_ID_SHAPE.test(value)) prices[plan.code as StudioPlanCode] = value;
  }
  const legacyPriceIds = STUDIO_PLANS.flatMap((plan) => {
    const value = config[`STRIPE_PRICE_STUDIO_${plan.code.toUpperCase()}_FOUNDER_LEGACY`];
    return typeof value === "string" ? value.split(",").map((id) => id.trim()).filter((id) => PRICE_ID_SHAPE.test(id)) : [];
  });
  const overall = ["PASS", "FAIL", "BLOCKED"].includes(String(r.overall)) ? (r.overall as BillingQaStatus) : "BLOCKED";
  return { offer, prices, legacyPriceIds, priceConfigOverall: overall };
}

// At most the 8-character prefix of a refused value is echoed (a mis-pasted key must not leak its body).
const prefix = (value: string) => `${value.slice(0, 8)}…`;

/** A command-line argument for an error message: a flag (`--name`) in full, anything else (e.g. a pasted key) as a prefix. */
export function describeArgument(arg: string): string {
  return /^--[a-z][a-z-]*$/.test(arg) ? arg : prefix(arg);
}

export function assertSessionIdsMatchKeyMode(sessionIds: string[], keyMode: "live" | "test") {
  for (const id of sessionIds) {
    const match = id.match(SESSION_ID);
    if (!match) throw new Error(`not a Checkout Session id: ${prefix(id)}`);
    if (match[1] !== keyMode) throw new Error(`Session ${prefix(id)} is ${match[1]} mode but the key is ${keyMode} mode`);
  }
}

function expectedAmount(plan: StudioPlanCode, offer: SmokeExpectations["offer"]) {
  const billingPlan = getBillingPlan(plan);
  return offer === "founder" ? billingPlan?.amountMonthlyCents : billingPlan?.provisionalRegularAmountMonthlyCents;
}

function sessionChecks(session: ReadbackSession, key: string, expect: SmokeExpectations, smokeCustomer: string | null, keyLive: boolean): BillingQaCheck[] {
  const checks: BillingQaCheck[] = [];
  const metadata = session.metadata ?? {};
  const plan = STUDIO_PLANS.find((p) => p.code === metadata.planCode)?.code as StudioPlanCode | undefined;
  const base = { session: session.id };

  // 1. Not paid: the whole point of a no-payment smoke.
  const subscription = idOf(session.subscription);
  checks.push(
    session.status !== "complete" && !subscription
      ? pass(`${key}.unpaid`, "Session was not completed and created no subscription", { ...base, status: session.status ?? null })
      : fail(`${key}.unpaid`, "Session was not completed and created no subscription", "session_completed",
          "this Session was paid or completed: a real subscription may exist; check the Stripe Dashboard and cancel it if unintended",
          { ...base, status: session.status ?? null, subscription }),
  );

  // 2. DanceFlow subscription Session for a known plan, in the expected mode and (optionally) for the smoke customer.
  const metadataProblems: string[] = [];
  if (session.livemode !== keyLive) metadataProblems.push(`livemode ${String(session.livemode)}`);
  if (session.mode !== "subscription") metadataProblems.push(`mode ${session.mode ?? "none"}`);
  if (metadata.source !== "studio_subscription") metadataProblems.push(`source ${metadata.source ?? "none"}`);
  if (!plan) metadataProblems.push(`planCode ${metadata.planCode ?? "none"}`);
  if (!metadata.studioId) metadataProblems.push("no studioId");
  if (metadata.offerType !== expect.offer) metadataProblems.push(`offerType ${metadata.offerType ?? "none"} (expected ${expect.offer})`);
  if (smokeCustomer && idOf(session.customer) !== smokeCustomer) metadataProblems.push("customer is not the smoke workspace's");
  const metadataEvidence = { ...base, planCode: metadata.planCode ?? null, offerType: metadata.offerType ?? null };
  checks.push(
    metadataProblems.length === 0
      ? pass(`${key}.session`, "DanceFlow studio subscription Session", metadataEvidence)
      : fail(`${key}.session`, "DanceFlow studio subscription Session", "session_not_danceflow_subscription", metadataProblems.join(", "), metadataEvidence),
  );

  // 3. Exactly the expected Price at the expected amount.
  const items = session.line_items?.data ?? [];
  const price = items[0]?.price ?? null;
  const priceEvidence: Record<string, BillingQaEvidenceValue> = { ...base, priceId: price?.id ?? null, unitAmount: price?.unit_amount ?? null };
  const priceTitle = plan ? `${plan} Session charges ${money(expectedAmount(plan, expect.offer))}/month on the configured Price` : "Session Price";
  if (!plan) {
    checks.push(blocked(`${key}.price`, priceTitle, "plan_unknown", "the Session names no studio plan", priceEvidence));
  } else {
    const amount = expectedAmount(plan, expect.offer);
    const problems: string[] = [];
    if (items.length !== 1 || (items[0]?.quantity ?? 1) !== 1) problems.push(`${items.length} line items`);
    if (price?.unit_amount !== amount) problems.push(`amount ${money(price?.unit_amount)} (expected ${money(amount)})`);
    if (price?.currency !== "usd") problems.push(`currency ${price?.currency ?? "none"}`);
    if (price?.recurring?.interval !== "month" || (price.recurring.interval_count ?? 1) !== 1) problems.push("not monthly");
    const expectedId = expect.prices[plan];
    if (expectedId && price?.id !== expectedId) problems.push("Price is not the configured one");
    if (problems.length) checks.push(fail(`${key}.price`, priceTitle, "session_price_mismatch", problems.join(", "), { ...priceEvidence, expectedPriceId: expectedId ?? null }));
    else if (!expectedId) checks.push(blocked(`${key}.price`, priceTitle, "expected_price_id_unknown", "amount matches; pass --price-config or --expect to confirm the Price ID", priceEvidence));
    else checks.push(pass(`${key}.price`, priceTitle, priceEvidence));
  }
  return checks;
}

export async function readBackSmoke(params: {
  stripe: BillingQaReadClient;
  keyMode: "live" | "test";
  sessionIds: string[];
  expectations: SmokeExpectations;
  /** Plans the smoke must cover (default: all three studio plans). */
  plans?: StudioPlanCode[];
  /** The no-payment workspace's Stripe customer: must have no subscription created since `since`. */
  smokeCustomer?: string | null;
  /** An existing subscriber's customer: their checkout must have created no Session since `since` (portal instead). */
  portalCustomer?: string | null;
  /** The grandfathered subscription that must still be on its legacy Price. */
  grandfatheredSubscription?: string | null;
  /** Unix seconds; defaults to 10 minutes before the earliest Session. */
  since?: number;
  now?: () => Date;
}): Promise<BillingQaReport> {
  const { stripe, expectations } = params;
  const now = params.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const keyLive = params.keyMode === "live";
  assertSessionIdsMatchKeyMode(params.sessionIds, params.keyMode);
  const checks: BillingQaCheck[] = [];
  const covered = new Map<string, number>();
  const createdTimes: number[] = [];

  for (const id of params.sessionIds) {
    let session: ReadbackSession;
    try {
      session = await stripe.checkout.sessions.retrieve(id, { expand: ["line_items"] });
    } catch (error) {
      const r = classifyStripeError(error, { name: "Checkout Session", reason: "session" });
      const key = `session.${id.slice(-8)}`;
      checks.push(r.status === "FAIL" ? fail(key, "Checkout Session readable", r.reason, r.detail, { session: id }) : blocked(key, "Checkout Session readable", r.reason, r.detail, { session: id }));
      continue;
    }
    if (typeof session.created === "number") createdTimes.push(session.created);
    const planCode = session.metadata?.planCode ?? "unknown";
    const count = (covered.get(planCode) ?? 0) + 1;
    covered.set(planCode, count);
    const key = `session.${planCode}${count > 1 ? `.${count}` : ""}`;
    checks.push(...sessionChecks(session, key, expectations, params.smokeCustomer ?? null, keyLive));
    // With a recorded start time (--since), each Session must have been created during this smoke: a leftover Session
    // from an earlier smoke on the same Prices proves nothing about the current deployment.
    if (params.since !== undefined) {
      const title = "Session was created during this smoke (at or after --since)";
      const evidence = { session: session.id, created: typeof session.created === "number" ? new Date(session.created * 1000).toISOString() : null, since: new Date(params.since * 1000).toISOString() };
      if (typeof session.created !== "number") checks.push(blocked(`${key}.fresh`, title, "session_created_unknown", undefined, evidence));
      else if (session.created < params.since) checks.push(fail(`${key}.fresh`, title, "session_before_smoke_start", "this Session predates the recorded start time", evidence));
      else checks.push(pass(`${key}.fresh`, title, evidence));
    }
  }

  const wanted = params.plans ?? (STUDIO_PLANS.map((p) => p.code) as StudioPlanCode[]);
  const missing = wanted.filter((plan) => !covered.has(plan));
  checks.push(
    missing.length === 0
      ? pass("smoke.coverage", "Every plan was smoked", { plans: wanted.join(",") })
      : blocked("smoke.coverage", "Every plan was smoked", "plan_not_smoked", `no Session for ${missing.join(", ")}`, { missing: missing.join(",") }),
  );

  const since = params.since ?? (createdTimes.length ? Math.min(...createdTimes) - 600 : Math.floor(now().getTime() / 1000) - 3600);
  const listFailure = (id: string, title: string, error: unknown) => {
    const r = classifyStripeError(error, { name: "object", reason: "object" });
    return r.status === "FAIL" ? fail(id, title, r.reason, r.detail) : blocked(id, title, r.reason, r.detail);
  };

  if (params.smokeCustomer) {
    const title = "The smoke workspace got no subscription";
    try {
      const subs = await stripe.subscriptions.list({ customer: params.smokeCustomer, created: { gte: since }, status: "all", limit: 20 });
      checks.push(subs.data.length === 0
        ? pass("smoke.no_subscription", title, { customer: params.smokeCustomer })
        : fail("smoke.no_subscription", title, "smoke_subscription_created", `${subs.data.length} subscription(s) created; check and cancel in the Stripe Dashboard`, { customer: params.smokeCustomer, subscriptions: subs.data.map((s) => s.id).join(",") }));
    } catch (error) {
      checks.push(listFailure("smoke.no_subscription", title, error));
    }
  }

  if (params.portalCustomer) {
    // Absence alone proves nothing (a wrong customer id, or a step that never ran, also has no Sessions): the customer
    // must first be shown to be a live subscriber. That the portal actually opened stays owner-attested.
    const title = "The existing subscriber's checkout created no Checkout Session (Billing Portal instead)";
    try {
      const subs = await stripe.subscriptions.list({ customer: params.portalCustomer, created: { gte: 0 }, status: "all", limit: 20 });
      const live = subs.data.filter((s) => MANAGED.has(s.status ?? ""));
      if (live.length === 0) {
        checks.push(blocked("portal.no_checkout_session", title, "portal_customer_not_subscriber", "this customer has no live subscription, so the check proves nothing", { customer: params.portalCustomer }));
      } else {
        const sessions = await stripe.checkout.sessions.list({ customer: params.portalCustomer, created: { gte: since }, limit: 20 });
        checks.push(sessions.data.length === 0
          ? pass("portal.no_checkout_session", title, { customer: params.portalCustomer, liveSubscriptions: live.length })
          : fail("portal.no_checkout_session", title, "existing_subscriber_got_checkout", `${sessions.data.length} Session(s) created for an existing subscriber`, { customer: params.portalCustomer, sessions: sessions.data.map((s) => s.id).join(",") }));
      }
    } catch (error) {
      checks.push(listFailure("portal.no_checkout_session", title, error));
    }
  }

  if (params.grandfatheredSubscription) {
    const title = "The grandfathered subscription is still on a legacy Price";
    if (expectations.legacyPriceIds.length === 0) {
      checks.push(blocked("grandfathered.price", title, "legacy_price_unknown", "pass --price-config or --legacy-price"));
    } else {
      try {
        const sub = await stripe.subscriptions.retrieve(params.grandfatheredSubscription);
        const item = sub.items?.data.find((i) => expectations.legacyPriceIds.includes(i.price?.id ?? ""));
        const evidence = { subscription: sub.id, status: sub.status ?? null, legacyPriceId: item?.price?.id ?? null, unitAmount: item?.price?.unit_amount ?? null };
        if (sub.livemode !== keyLive) checks.push(fail("grandfathered.price", title, "livemode_mismatch", undefined, evidence));
        else if (!item) checks.push(fail("grandfathered.price", title, "grandfathered_price_changed", "the subscription no longer carries the legacy Price", evidence));
        else if (!MANAGED.has(sub.status ?? "")) checks.push(fail("grandfathered.price", title, "grandfathered_not_active", `status ${sub.status ?? "none"}`, evidence));
        else checks.push(pass("grandfathered.price", title, evidence, `${money(item.price?.unit_amount)}/month, ${sub.status}`));
      } catch (error) {
        const r = classifyStripeError(error, { name: "Subscription", reason: "subscription" });
        checks.push(r.status === "FAIL" ? fail("grandfathered.price", title, r.reason, r.detail) : blocked("grandfathered.price", title, r.reason, r.detail));
      }
    }
  }

  // The deployment's configuration report must itself have passed: expectations from a failing one are not trusted.
  if (expectations.priceConfigOverall) {
    const title = "The BILLING-QA-4 price-config report the expectations came from passed";
    checks.push(expectations.priceConfigOverall === "PASS"
      ? pass("config.report", title, { overall: "PASS" })
      : fail("config.report", title, "price_config_report_not_pass", `that report was ${expectations.priceConfigOverall}`, { overall: expectations.priceConfigOverall }));
  }

  return buildReport({
    tool: SESSION_READBACK_TOOL,
    mode: "readback",
    startedAt,
    completedAt: now().toISOString(),
    config: {
      stripeMode: params.keyMode,
      offer: expectations.offer,
      sessions: params.sessionIds.length,
      since: new Date(since * 1000).toISOString(),
      ...Object.fromEntries(Object.entries(expectations.prices).map(([plan, id]) => [`expected.${plan}`, id ?? null])),
      legacyPriceIds: expectations.legacyPriceIds.join(",") || null,
    },
    checks,
  });
}
