/**
 * D7 WP-3: end of grandfathered pricing. Moves ONE protected subscription to a new Stripe Price at a billing-period
 * boundary through a Stripe subscription schedule (no proration, nothing immediate).
 *
 * Owner policy (docs/billing/D7-RELEASE-READINESS.md 8.5.A): no notice record, no schedule; the rate charged equals the rate
 * disclosed in the notice; the change is created only after explicit owner approval of the date, notice and rate; a dry run
 * shows the change first and a read-back compares the result; a failure leaves the subscription unchanged.
 *
 * This module is a library only. Nothing calls it from a route, job or webhook, and it never runs on its own. The pure
 * planner makes no network calls. The executor refuses live Stripe keys unless the caller passes allowLive explicitly.
 *
 * Phase construction: the schedule Stripe creates from the subscription is the source of truth for the CURRENT phase. The
 * executor copies every carry-over field of that phase (metadata, tax, discounts, payment settings, item metadata) into both
 * the first and the second phase and changes only the end date of the first and the Price of the second. Subscriptions with
 * settings this module does not understand (trial, pause, pending update) are refused by the planner instead.
 */

export const DEFAULT_MIN_NOTICE_DAYS = 60;
/** The change must be approved and run at least this long before the boundary so the period cannot roll over mid-operation. */
export const MIN_LEAD_HOURS = 24;

export type TransitionNotice = {
  id: string;
  protectedSubscriptionId: string;
  studioId?: string;
  effectiveAt: Date;
  newPriceId: string;
  newUnitAmountCents: number;
  currency: string;
  billingInterval: "month" | "year";
  approved: boolean;
  deliveryStatus: "pending" | "delivered" | "bounced" | "failed";
  sentAt: Date | null;
};

export type TransitionTargetPrice = {
  id: string;
  active: boolean;
  unitAmountCents: number | null;
  currency: string;
  interval: string | null;
  /** Shape fields; a missing value is treated as unsupported (fail closed). */
  intervalCount?: number | null;
  type?: string | null;
  billingScheme?: string | null;
  usageType?: string | null;
  hasTransformQuantity?: boolean;
};

export type TransitionSubscription = {
  id: string;
  status: string;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  cancelAtPeriodEnd: boolean;
  scheduleId: string | null;
  items: Array<{ priceId: string; quantity: number; /** Subscription-item metadata; Stripe schedules do not copy it, so it is set explicitly on both phases. */ metadata?: Record<string, string> }>;
  /** Subscription-level metadata, carried explicitly onto both phases. */
  metadata?: Record<string, string>;
  /** Settings this transition does not model; any entry blocks the plan (e.g. "trial", "pause_collection", "pending_update"). */
  unsupportedSettings?: string[];
};

export type TransitionApproval = {
  approvedBy: string;
  /** The exact boundary the owner approved (must equal the verified period end and the notice's effective instant). */
  boundaryAt: Date;
};

export type TransitionBlocker =
  | "notice_missing"
  | "notice_not_approved"
  | "notice_not_delivered"
  | "notice_for_other_subscription"
  | "notice_too_late"
  | "target_price_mismatch"
  | "target_price_inactive"
  | "target_price_terms_mismatch"
  | "target_price_shape_unsupported"
  | "subscription_not_active"
  | "subscription_cancelling"
  | "subscription_has_schedule"
  | "subscription_unsupported_items"
  | "subscription_unsupported_settings"
  | "boundary_in_past"
  | "boundary_too_soon"
  | "boundary_not_period_end"
  | "boundary_not_notice_date"
  | "approval_missing";

/** Carry-over fields copied from the schedule Stripe created; opaque to this module. */
export type PhaseCarry = Record<string, unknown>;

export type TransitionPhase = {
  startDate: number;
  endDate?: number;
  items: Array<{ price: string; quantity: number; metadata?: Record<string, string> }>;
};

export type TransitionPlan =
  | { ok: false; blockers: TransitionBlocker[] }
  | {
      ok: true;
      blockers: [];
      /** What would change in Stripe; this is the dry-run output stored with the approval. */
      change: {
        subscriptionId: string;
        boundaryAt: string;
        fromPriceIds: string[];
        toPriceId: string;
        toUnitAmountCents: number;
        currency: string;
        proration: "none";
        subscriptionMetadata?: Record<string, string>;
        phases: [TransitionPhase, TransitionPhase];
      };
    };

const unix = (d: Date) => Math.floor(d.getTime() / 1000);

export function planPriceTransition(input: {
  now: Date;
  subscription: TransitionSubscription;
  notice: TransitionNotice | null;
  target: TransitionTargetPrice;
  approval: TransitionApproval | null;
  protectedSubscriptionId: string;
  minNoticeDays?: number;
}): TransitionPlan {
  const { now, subscription, notice, target, approval } = input;
  const blockers: TransitionBlocker[] = [];
  const minNoticeDays = input.minNoticeDays ?? DEFAULT_MIN_NOTICE_DAYS;

  if (!approval) blockers.push("approval_missing");

  if (!notice) {
    blockers.push("notice_missing");
  } else {
    if (notice.protectedSubscriptionId !== input.protectedSubscriptionId) blockers.push("notice_for_other_subscription");
    if (!notice.approved) blockers.push("notice_not_approved");
    if (notice.deliveryStatus !== "delivered" || !notice.sentAt) blockers.push("notice_not_delivered");
    else if (notice.effectiveAt.getTime() - notice.sentAt.getTime() < minNoticeDays * 86_400_000) blockers.push("notice_too_late");
    if (notice.newPriceId !== target.id) blockers.push("target_price_mismatch");
    if (
      target.unitAmountCents !== notice.newUnitAmountCents ||
      target.currency.toLowerCase() !== notice.currency.toLowerCase() ||
      target.interval !== notice.billingInterval
    ) {
      blockers.push("target_price_terms_mismatch");
    }
    if (approval && approval.boundaryAt.getTime() !== notice.effectiveAt.getTime()) blockers.push("boundary_not_notice_date");
  }

  if (!target.active) blockers.push("target_price_inactive");
  // A target that is not a plain licensed per-unit recurring price billed every interval would not charge the disclosed rate.
  if (
    target.type !== "recurring" ||
    target.intervalCount !== 1 ||
    target.billingScheme !== "per_unit" ||
    target.usageType !== "licensed" ||
    target.hasTransformQuantity !== false
  ) {
    blockers.push("target_price_shape_unsupported");
  }
  if (subscription.status !== "active") blockers.push("subscription_not_active");
  if (subscription.cancelAtPeriodEnd) blockers.push("subscription_cancelling");
  if (subscription.scheduleId) blockers.push("subscription_has_schedule");
  if (subscription.items.length !== 1) blockers.push("subscription_unsupported_items");
  if ((subscription.unsupportedSettings ?? []).length > 0) blockers.push("subscription_unsupported_settings");
  if (approval) {
    if (approval.boundaryAt.getTime() <= now.getTime()) blockers.push("boundary_in_past");
    else if (approval.boundaryAt.getTime() - now.getTime() < MIN_LEAD_HOURS * 3_600_000) blockers.push("boundary_too_soon");
    if (approval.boundaryAt.getTime() !== subscription.currentPeriodEnd.getTime()) blockers.push("boundary_not_period_end");
  }

  if (blockers.length > 0 || !approval || !notice) return { ok: false, blockers: [...new Set(blockers)] };

  const [item] = subscription.items;
  const itemMeta = item.metadata && Object.keys(item.metadata).length > 0 ? { metadata: item.metadata } : {};
  const subMeta = subscription.metadata && Object.keys(subscription.metadata).length > 0 ? { subscriptionMetadata: subscription.metadata } : {};
  return {
    ok: true,
    blockers: [],
    change: {
      subscriptionId: subscription.id,
      boundaryAt: approval.boundaryAt.toISOString(),
      fromPriceIds: subscription.items.map((i) => i.priceId),
      toPriceId: target.id,
      toUnitAmountCents: notice.newUnitAmountCents,
      currency: notice.currency,
      proration: "none",
      ...subMeta,
      phases: [
        {
          startDate: unix(subscription.currentPeriodStart),
          endDate: unix(approval.boundaryAt),
          items: [{ price: item.priceId, quantity: item.quantity, ...itemMeta }],
        },
        { startDate: unix(approval.boundaryAt), items: [{ price: target.id, quantity: item.quantity, ...itemMeta }] },
      ],
    },
  };
}

type SchedulePhaseRead = {
  start_date: number;
  end_date: number | null;
  items: Array<{ price: string; quantity: number } & Record<string, unknown>>;
} & Record<string, unknown>;

type ScheduleRead = {
  id: string;
  status: string;
  subscription: string | null;
  phases: SchedulePhaseRead[];
};

type UpdatePhase = {
  start_date: number;
  end_date?: number;
  items: Array<Record<string, unknown>>;
  proration_behavior: "none";
} & Record<string, unknown>;

/** The slice of the Stripe client the executor needs; the real client satisfies it structurally. */
export type ScheduleStripe = {
  subscriptionSchedules: {
    create(params: { from_subscription: string }, options?: { idempotencyKey?: string }): Promise<{ id: string }>;
    update(
      id: string,
      params: { end_behavior: "release"; proration_behavior: "none"; phases: UpdatePhase[] },
      options?: { idempotencyKey?: string },
    ): Promise<unknown>;
    retrieve(id: string): Promise<ScheduleRead>;
    release(id: string): Promise<unknown>;
  };
  subscriptions: {
    retrieve(id: string): Promise<{ schedule: string | { id: string } | null }>;
  };
};

export type TransitionResult =
  | { status: "scheduled"; scheduleId: string }
  /** released=false with a scheduleId means a schedule may STILL be attached: the operator must reconcile it by hand. */
  | { status: "failed"; scheduleId: string | null; reason: string; released: boolean };

export type ExecuteOptions = {
  /** "live" or "test", from the configured secret key. Live is refused unless allowLive is true. */
  keyMode: "live" | "test";
  allowLive?: boolean;
  /** Called as soon as Stripe returns the schedule id, so it can be recorded before anything else can fail. */
  onScheduleCreated?: (scheduleId: string) => Promise<void>;
  /** Derives Stripe idempotency keys (e.g. the audit row id) so a replayed write cannot create a second object. */
  idempotencyPrefix?: string;
};

// Keys never sent back: positions are set explicitly, trial/iterations would change timing, `currency` is derived, `plan` is the legacy duplicate of `price`.
const CARRY_EXCLUDED_PHASE_KEYS = new Set(["start_date", "end_date", "items", "iterations", "trial_end", "trial", "plans", "proration_behavior", "currency"]);
const CARRY_EXCLUDED_ITEM_KEYS = new Set(["price", "plan", "quantity"]);

/** Removes null/undefined and empty arrays/objects recursively: Stripe returns many unset fields as null but rejects them as input. */
export function prune(value: unknown): unknown {
  if (Array.isArray(value)) {
    const items = value.map(prune).filter((v) => v !== undefined);
    return items.length > 0 ? items : undefined;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      const cleaned = prune(inner);
      if (cleaned !== undefined) out[key] = cleaned;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }
  return value === null ? undefined : value;
}

/** True when every defined value in `expected` is present and equal in `actual` (extra read-only fields in `actual` are fine). */
export function isSubset(expected: unknown, actual: unknown): boolean {
  if (expected && typeof expected === "object") {
    if (!actual || typeof actual !== "object") return false;
    if (Array.isArray(expected)) return Array.isArray(actual) && expected.length === actual.length && expected.every((v, i) => isSubset(v, actual[i]));
    return Object.entries(expected as Record<string, unknown>).every(([k, v]) => isSubset(v, (actual as Record<string, unknown>)[k]));
  }
  return expected === actual;
}

/** `automatic_tax` is returned with read-only members (e.g. disabled_reason); only `enabled` and `liability` are valid input. */
function pruneAutomaticTax(value: unknown): unknown {
  if (!value || typeof value !== "object") return undefined;
  const { enabled, liability } = value as { enabled?: boolean; liability?: unknown };
  return prune({ enabled, liability });
}

/** Everything on the current phase that must survive into both phases: metadata, tax, discounts, payment settings, anchors. */
export function carryFields(phase: SchedulePhaseRead): PhaseCarry {
  const carry: PhaseCarry = {};
  for (const [key, value] of Object.entries(phase)) {
    if (CARRY_EXCLUDED_PHASE_KEYS.has(key)) continue;
    const cleaned = key === "automatic_tax" ? pruneAutomaticTax(value) : prune(value);
    if (cleaned !== undefined) carry[key] = cleaned;
  }
  return carry;
}

function carryItem(item: SchedulePhaseRead["items"][number], price: string, metadata?: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = { price, quantity: item.quantity };
  for (const [key, value] of Object.entries(item)) {
    if (CARRY_EXCLUDED_ITEM_KEYS.has(key)) continue;
    const cleaned = prune(value);
    if (cleaned !== undefined) out[key] = cleaned;
  }
  if (metadata) out.metadata = { ...(out.metadata as Record<string, string> | undefined), ...metadata };
  return out;
}

export async function executePriceTransition(
  stripe: ScheduleStripe,
  plan: TransitionPlan,
  options: ExecuteOptions,
): Promise<TransitionResult> {
  if (!plan.ok) return { status: "failed", scheduleId: null, reason: `plan blocked: ${plan.blockers.join(",")}`, released: false };
  if (options.keyMode === "live" && options.allowLive !== true) {
    return { status: "failed", scheduleId: null, reason: "live Stripe key refused without explicit allowLive", released: false };
  }

  const { change } = plan;
  const idem = (suffix: string) => (options.idempotencyPrefix ? { idempotencyKey: `${options.idempotencyPrefix}-${suffix}` } : undefined);
  // Never touch a subscription that already carries a schedule: whatever is attached is not ours, and the lost-response
  // recovery below must only ever release a schedule that appeared as a result of OUR create call.
  try {
    const before = await stripe.subscriptions.retrieve(change.subscriptionId);
    const existing = typeof before.schedule === "string" ? before.schedule : before.schedule?.id ?? null;
    if (existing) return { status: "failed", scheduleId: null, reason: `subscription already has schedule ${existing}; left untouched`, released: true };
  } catch (error) {
    return { status: "failed", scheduleId: null, reason: `pre-create subscription read failed: ${error instanceof Error ? error.message : "unknown"}`, released: true };
  }

  let scheduleId: string | null = null;
  try {
    const created = await stripe.subscriptionSchedules.create({ from_subscription: change.subscriptionId }, idem("create"));
    scheduleId = created.id;
    if (options.onScheduleCreated) await options.onScheduleCreated(scheduleId);

    // The created schedule's current phase is authoritative: it must match what was approved before we touch it.
    const current = await stripe.subscriptionSchedules.retrieve(scheduleId);
    if (current.phases.length !== 1) throw new Error(`created schedule has ${current.phases.length} phases, expected 1`);
    const [phase0] = current.phases;
    const [wantCurrent, wantNext] = change.phases;
    if (phase0.start_date !== wantCurrent.startDate) throw new Error("current phase start differs from the approved period start");
    if (phase0.items.length !== 1 || phase0.items[0].price !== wantCurrent.items[0].price || phase0.items[0].quantity !== wantCurrent.items[0].quantity) {
      throw new Error("current phase items differ from the approved plan");
    }

    const carry = carryFields(phase0);
    if (change.subscriptionMetadata) carry.metadata = { ...(carry.metadata as Record<string, string> | undefined), ...change.subscriptionMetadata };
    await stripe.subscriptionSchedules.update(
      scheduleId,
      {
        end_behavior: "release",
        proration_behavior: "none",
        phases: [
          { ...carry, start_date: phase0.start_date, end_date: wantCurrent.endDate!, items: [carryItem(phase0.items[0], wantCurrent.items[0].price, wantCurrent.items[0].metadata)], proration_behavior: "none" },
          { ...carry, start_date: wantNext.startDate, items: [carryItem(phase0.items[0], wantNext.items[0].price, wantNext.items[0].metadata)], proration_behavior: "none" },
        ],
      },
      idem("update"),
    );

    const readBack = await stripe.subscriptionSchedules.retrieve(scheduleId);
    const mismatch = verifyReadBack(readBack, change, carry);
    if (mismatch) throw new Error(`read-back mismatch: ${mismatch}`);
    return { status: "scheduled", scheduleId };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown error";
    // A lost create response leaves scheduleId null while a schedule may exist: look for one we did not have at plan time.
    if (!scheduleId) {
      try {
        const sub = await stripe.subscriptions.retrieve(change.subscriptionId);
        scheduleId = typeof sub.schedule === "string" ? sub.schedule : sub.schedule?.id ?? null;
      } catch {
        scheduleId = null;
      }
    }
    let released = scheduleId === null;
    if (scheduleId) {
      try {
        await stripe.subscriptionSchedules.release(scheduleId);
        released = true;
      } catch {
        released = false;
      }
    }
    return { status: "failed", scheduleId, reason, released };
  }
}

function verifyReadBack(schedule: ScheduleRead, change: Extract<TransitionPlan, { ok: true }>["change"], carry: PhaseCarry): string | null {
  if (schedule.subscription !== change.subscriptionId) return "schedule is attached to another subscription";
  if (schedule.phases.length !== 2) return `expected 2 phases, got ${schedule.phases.length}`;
  const [current, next] = schedule.phases;
  const [wantCurrent, wantNext] = change.phases;
  const same = (a: { price: string; quantity: number }[], b: { price: string; quantity: number }[]) =>
    a.length === b.length && a.every((item, i) => item.price === b[i].price && item.quantity === b[i].quantity);
  if (current.start_date !== wantCurrent.startDate) return "first phase start moved";
  if (current.end_date !== wantCurrent.endDate) return "first phase does not end at the approved boundary";
  if (!same(current.items, wantCurrent.items)) return "first phase items changed";
  if (next.start_date !== wantNext.startDate) return "second phase does not start at the approved boundary";
  if (!same(next.items, wantNext.items)) return "second phase is not the disclosed price";
  for (const [phase, want] of [[current, wantCurrent], [next, wantNext]] as const) {
    if (want.items[0].metadata && !isSubset(want.items[0].metadata, phase.items[0].metadata)) return "item metadata was not carried onto the phase";
  }
  for (const [key, value] of Object.entries(carry)) {
    if (!isSubset(value, current[key])) return `first phase lost ${key}`;
    if (!isSubset(value, next[key])) return `second phase lost ${key}`;
  }
  return null;
}
