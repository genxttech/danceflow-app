/**
 * D7 WP-3: post-boundary reconciliation of a scheduled protected-price transition.
 *
 * Truth comes from Stripe's CURRENT state, never from an event payload, so delayed, duplicated, missing or out-of-order
 * webhooks cannot change the outcome: every trigger (webhook, sweep, operator) just re-reads and re-evaluates. Four facts are
 * tracked separately and never conflated:
 *   1. schedule creation      price_transitions.status = 'scheduled' (written by the executor after its read-back)
 *   2. schedule activation    Stripe's schedule is in the phase that starts at the boundary (or has completed/released)
 *   3. actual price change    the subscription item is on the approved Price, in a period that started at the boundary
 *   4. registry reconciliation the audited release of the protected_subscriptions row, atomic with the 'reconciled' status
 * Payment collection is NOT a condition: a past_due or unpaid subscription on the new Price still proves the change happened.
 *
 * Fail closed: any identity, boundary or amount conflict becomes status 'needs_review' with the evidence preserved. Nothing
 * here ever writes to Stripe or changes a live price.
 */

/** Policy boundary for grandfathered_founder_legacy: midnight EDT, 2027-07-09. Protection runs through 2027-07-08. */
export const PROTECTED_PRICE_BOUNDARY = new Date("2027-07-09T04:00:00Z");
/** How long after the boundary Stripe may take to roll the period before the delay itself is escalated to the owner. */
export const STRIPE_ROLL_GRACE_HOURS = 24;

export type ReconcileTransition = {
  id: string;
  status: string;
  protectedSubscriptionId: string;
  stripeSubscriptionId: string;
  stripeScheduleId: string | null;
  targetPriceId: string;
  boundaryAt: Date;
  activatedAt: Date | null;
  priceChangedAt: Date | null;
  noticeAmountCents: number;
  noticeCurrency: string;
};

export type ReconcileRegistry = {
  id: string;
  studioId: string;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string;
  releasedAt: string | null;
  protectionKind: string;
};

export type ReconcileSubscription = {
  id: string;
  customerId: string;
  status: string;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  scheduleId: string | null;
  items: Array<{ priceId: string; quantity: number }>;
};

export type ReconcileSchedule = {
  id: string;
  status: string;
  subscriptionId: string | null;
  currentPhaseStart: Date | null;
};

export type ReconcilePrice = { id: string; unitAmountCents: number | null; currency: string };

export type ReconcileInputs = {
  now: Date;
  transition: ReconcileTransition;
  registry: ReconcileRegistry | null;
  /** The Stripe customer on the studio's own billing record (not on the registry row). */
  studioCustomerId: string | null;
  subscription: ReconcileSubscription | null;
  schedule: ReconcileSchedule | null;
  price: ReconcilePrice | null;
};

export type ReconcileEvidence = Record<string, string | number | boolean | null>;

export type ReconcileOutcome =
  | { state: "already_reconciled" }
  | { state: "not_applicable"; reason: string }
  | { state: "not_due" }
  | { state: "awaiting_stripe"; milestones: Milestones }
  | { state: "ready"; milestones: Milestones; evidence: ReconcileEvidence }
  | { state: "needs_review"; reasons: string[]; milestones: Milestones; evidence: ReconcileEvidence };

export type Milestones = { phaseEntered: boolean; priceChanged: boolean };

const ENDED_STATUSES = new Set(["canceled", "incomplete_expired"]);

export function evaluateReconciliation(input: ReconcileInputs): ReconcileOutcome {
  const { now, transition, registry, subscription, schedule, price } = input;

  if (transition.status === "reconciled") return { state: "already_reconciled" };
  if (!["scheduled", "needs_review"].includes(transition.status)) return { state: "not_applicable", reason: `transition is ${transition.status}` };
  if (now.getTime() < transition.boundaryAt.getTime()) return { state: "not_due" };

  const reasons: string[] = [];
  const evidence: ReconcileEvidence = {
    subscription_id: subscription?.id ?? null,
    price_id: transition.targetPriceId,
    schedule_id: transition.stripeScheduleId,
    boundary_at: transition.boundaryAt.toISOString(),
    observed_at: now.toISOString(),
    subscription_status: subscription?.status ?? null,
    observed_period_start: subscription?.currentPeriodStart.toISOString() ?? null,
    observed_period_end: subscription?.currentPeriodEnd.toISOString() ?? null,
    observed_price_ids: subscription ? subscription.items.map((i) => i.priceId).join(",") : null,
    observed_amount_cents: price?.unitAmountCents ?? null,
  };

  // ---- identity and policy: any conflict is final for this run ----
  if (!registry) reasons.push("registry_row_missing");
  else {
    if (registry.protectionKind === "grandfathered_founder_legacy" && transition.boundaryAt.getTime() !== PROTECTED_PRICE_BOUNDARY.getTime()) {
      reasons.push("boundary_not_policy_date");
    }
    if (registry.stripeSubscriptionId !== transition.stripeSubscriptionId) reasons.push("registry_subscription_mismatch");
    if (registry.releasedAt) reasons.push("registry_row_released_outside_reconciliation");
  }
  if (!subscription) reasons.push("stripe_subscription_missing");
  if (subscription && subscription.id !== transition.stripeSubscriptionId) reasons.push("stripe_subscription_id_mismatch");
  const customerMatches = Boolean(subscription && registry?.stripeCustomerId && subscription.customerId === registry.stripeCustomerId);
  const studioMatches = Boolean(subscription && input.studioCustomerId && subscription.customerId === input.studioCustomerId);
  if (subscription && !customerMatches) reasons.push(registry?.stripeCustomerId ? "customer_mismatch" : "customer_unbound");
  if (subscription && !studioMatches) reasons.push("studio_customer_mismatch");
  if (subscription && ENDED_STATUSES.has(subscription.status)) reasons.push("subscription_ended");
  if (schedule && (schedule.id !== transition.stripeScheduleId || (schedule.subscriptionId && schedule.subscriptionId !== transition.stripeSubscriptionId))) {
    reasons.push("schedule_identity_mismatch");
  }
  const amountMatches = Boolean(
    price && price.id === transition.targetPriceId && price.unitAmountCents === transition.noticeAmountCents && price.currency.toLowerCase() === transition.noticeCurrency.toLowerCase(),
  );
  if (!price) reasons.push("target_price_unreadable");
  else if (!amountMatches) reasons.push("target_price_amount_differs_from_notice");

  // ---- milestones from Stripe truth ----
  const boundaryMs = transition.boundaryAt.getTime();
  const onTarget = Boolean(subscription && subscription.items.length === 1 && subscription.items[0].priceId === transition.targetPriceId);
  const periodStartsAtBoundary = Boolean(subscription && subscription.currentPeriodStart.getTime() === boundaryMs);
  const priceChanged = onTarget && periodStartsAtBoundary;
  const scheduleDone = Boolean(schedule && ["completed", "released"].includes(schedule.status));
  const phaseEntered = Boolean(
    (schedule?.currentPhaseStart && schedule.currentPhaseStart.getTime() >= boundaryMs) || scheduleDone || (priceChanged && subscription?.scheduleId === null),
  );
  const milestones: Milestones = { phaseEntered, priceChanged };
  const graceOver = now.getTime() - boundaryMs > STRIPE_ROLL_GRACE_HOURS * 3_600_000;
  if (priceChanged && !phaseEntered && graceOver) reasons.push("schedule_activation_not_confirmed");

  if (onTarget && !periodStartsAtBoundary) reasons.push("boundary_conflict_target_price_outside_boundary_period");
  if (subscription && !onTarget) {
    const stillOld = subscription.currentPeriodEnd.getTime() <= boundaryMs + 1000 || subscription.currentPeriodStart.getTime() < boundaryMs;
    if (!stillOld) reasons.push("unexpected_price_after_boundary");
    else if (graceOver) reasons.push("stripe_did_not_transition_within_grace");
  }

  Object.assign(evidence, {
    customer_matches: customerMatches,
    studio_matches: studioMatches,
    phase_entered: phaseEntered,
    price_changed: priceChanged,
    amount_matches_notice: amountMatches,
    period_start: subscription?.currentPeriodStart.toISOString() ?? null,
    schedule_status: schedule?.status ?? null,
  });

  if (reasons.length > 0) return { state: "needs_review", reasons: [...new Set(reasons)], milestones, evidence };
  if (phaseEntered && priceChanged) return { state: "ready", milestones, evidence };
  // Not yet rolled by Stripe, inside the grace window: re-evaluate on the next trigger.
  return { state: "awaiting_stripe", milestones };
}

export type ReconcileDeps = {
  now: () => Date;
  loadTransition(id: string): Promise<ReconcileTransition | null>;
  loadRegistry(protectedSubscriptionId: string): Promise<ReconcileRegistry | null>;
  loadStudioCustomerId(studioId: string): Promise<string | null>;
  readSubscription(id: string): Promise<ReconcileSubscription | null>;
  readSchedule(id: string): Promise<ReconcileSchedule | null>;
  readPrice(id: string): Promise<ReconcilePrice | null>;
  /** Write-once milestone timestamps. */
  recordMilestones(id: string, patch: { activatedAt?: Date; priceChangedAt?: Date }): Promise<void>;
  flagReview(id: string, reasons: string[], evidence: ReconcileEvidence): Promise<void>;
  /** Atomic: marks the transition reconciled and releases the registry row in one transaction. Idempotent. */
  complete(id: string, evidence: ReconcileEvidence): Promise<"reconciled" | "already_reconciled">;
};

export type ReconcileReport = {
  transitionId: string;
  applied: boolean;
  state: ReconcileOutcome["state"] | "completed";
  reasons: string[];
  milestones: Milestones | null;
  evidence: ReconcileEvidence | null;
  /** True when this run changed durable state. A replay of a finished transition reports false. */
  changed: boolean;
};

/**
 * Evaluate and, when apply is true, record. Dry run by default. Safe to call repeatedly, concurrently and from any trigger.
 * Any exception leaves durable state exactly as the last successful step left it; the next run resumes.
 */
export async function reconcilePriceTransition(transitionId: string, deps: ReconcileDeps, options: { apply?: boolean } = {}): Promise<ReconcileReport> {
  const apply = options.apply === true;
  const report = (over: Partial<ReconcileReport>): ReconcileReport => ({
    transitionId, applied: apply, state: "not_applicable", reasons: [], milestones: null, evidence: null, changed: false, ...over,
  });

  const transition = await deps.loadTransition(transitionId);
  if (!transition) return report({ state: "not_applicable", reasons: ["transition_missing"] });
  const registry = await deps.loadRegistry(transition.protectedSubscriptionId);
  const studioCustomerId = registry ? await deps.loadStudioCustomerId(registry.studioId) : null;
  const subscription = await deps.readSubscription(transition.stripeSubscriptionId);
  const schedule = transition.stripeScheduleId ? await deps.readSchedule(transition.stripeScheduleId) : null;
  const price = await deps.readPrice(transition.targetPriceId);
  const now = deps.now();

  const outcome = evaluateReconciliation({ now, transition, registry, studioCustomerId, subscription, schedule, price });
  if (outcome.state === "already_reconciled") return report({ state: "already_reconciled" });
  if (outcome.state === "not_applicable") return report({ state: "not_applicable", reasons: [outcome.reason] });
  if (outcome.state === "not_due") return report({ state: "not_due" });

  const base = { milestones: outcome.milestones };
  let changed = false;
  if (apply) {
    const patch: { activatedAt?: Date; priceChangedAt?: Date } = {};
    if (outcome.milestones.phaseEntered && !transition.activatedAt) patch.activatedAt = now;
    if (outcome.milestones.priceChanged && !transition.priceChangedAt) patch.priceChangedAt = now;
    if (patch.activatedAt || patch.priceChangedAt) {
      await deps.recordMilestones(transition.id, patch);
      changed = true;
    }
  }

  if (outcome.state === "needs_review") {
    if (apply && transition.status !== "needs_review") {
      await deps.flagReview(transition.id, outcome.reasons, outcome.evidence);
      changed = true;
    }
    return report({ ...base, state: "needs_review", reasons: outcome.reasons, evidence: outcome.evidence, changed });
  }
  if (outcome.state === "awaiting_stripe") return report({ ...base, state: "awaiting_stripe", changed });

  if (!apply) return report({ ...base, state: "ready", evidence: outcome.evidence, changed });
  const result = await deps.complete(transition.id, outcome.evidence);
  return report({ ...base, state: "completed", evidence: outcome.evidence, changed: changed || result === "reconciled" });
}
