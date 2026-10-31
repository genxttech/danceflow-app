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
 */

export const DEFAULT_MIN_NOTICE_DAYS = 60;

export type TransitionNotice = {
  id: string;
  protectedSubscriptionId: string;
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
};

export type TransitionSubscription = {
  id: string;
  status: string;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  cancelAtPeriodEnd: boolean;
  scheduleId: string | null;
  items: Array<{ priceId: string; quantity: number }>;
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
  | "subscription_not_active"
  | "subscription_cancelling"
  | "subscription_has_schedule"
  | "subscription_unsupported_items"
  | "boundary_in_past"
  | "boundary_not_period_end"
  | "boundary_not_notice_date"
  | "approval_missing";

export type TransitionPhase = {
  startDate: number;
  endDate?: number;
  items: Array<{ price: string; quantity: number }>;
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
  if (subscription.status !== "active") blockers.push("subscription_not_active");
  if (subscription.cancelAtPeriodEnd) blockers.push("subscription_cancelling");
  if (subscription.scheduleId) blockers.push("subscription_has_schedule");
  if (subscription.items.length !== 1) blockers.push("subscription_unsupported_items");
  if (approval) {
    if (approval.boundaryAt.getTime() <= now.getTime()) blockers.push("boundary_in_past");
    if (approval.boundaryAt.getTime() !== subscription.currentPeriodEnd.getTime()) blockers.push("boundary_not_period_end");
  }

  if (blockers.length > 0 || !approval || !notice) return { ok: false, blockers: [...new Set(blockers)] };

  const [item] = subscription.items;
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
      phases: [
        {
          startDate: unix(subscription.currentPeriodStart),
          endDate: unix(approval.boundaryAt),
          items: [{ price: item.priceId, quantity: item.quantity }],
        },
        { startDate: unix(approval.boundaryAt), items: [{ price: target.id, quantity: item.quantity }] },
      ],
    },
  };
}

/** The slice of the Stripe client the executor needs; the real client satisfies it structurally. */
export type ScheduleStripe = {
  subscriptionSchedules: {
    create(params: { from_subscription: string }): Promise<{ id: string }>;
    update(
      id: string,
      params: {
        end_behavior: "release";
        proration_behavior: "none";
        phases: Array<{
          start_date: number;
          end_date?: number;
          items: Array<{ price: string; quantity: number }>;
          proration_behavior: "none";
        }>;
      },
    ): Promise<unknown>;
    retrieve(id: string): Promise<{
      id: string;
      status: string;
      subscription: string | null;
      phases: Array<{ start_date: number; end_date: number | null; items: Array<{ price: string; quantity: number }> }>;
    }>;
    release(id: string): Promise<unknown>;
  };
};

export type TransitionResult =
  | { status: "scheduled"; scheduleId: string }
  | { status: "failed"; scheduleId: string | null; reason: string; released: boolean };

export type ExecuteOptions = {
  /** "live" or "test", from the configured secret key. Live is refused unless allowLive is true. */
  keyMode: "live" | "test";
  allowLive?: boolean;
};

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
  let scheduleId: string | null = null;
  try {
    const created = await stripe.subscriptionSchedules.create({ from_subscription: change.subscriptionId });
    scheduleId = created.id;
    await stripe.subscriptionSchedules.update(scheduleId, {
      end_behavior: "release",
      proration_behavior: "none",
      phases: change.phases.map((phase) => ({
        start_date: phase.startDate,
        ...(phase.endDate === undefined ? {} : { end_date: phase.endDate }),
        items: phase.items,
        proration_behavior: "none" as const,
      })),
    });

    const readBack = await stripe.subscriptionSchedules.retrieve(scheduleId);
    const mismatch = verifyReadBack(readBack, change);
    if (mismatch) throw new Error(`read-back mismatch: ${mismatch}`);
    return { status: "scheduled", scheduleId };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown error";
    let released = false;
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

function verifyReadBack(
  schedule: Awaited<ReturnType<ScheduleStripe["subscriptionSchedules"]["retrieve"]>>,
  change: Extract<TransitionPlan, { ok: true }>["change"],
): string | null {
  if (schedule.subscription !== change.subscriptionId) return "schedule is attached to another subscription";
  if (schedule.phases.length !== 2) return `expected 2 phases, got ${schedule.phases.length}`;
  const [current, next] = schedule.phases;
  const [wantCurrent, wantNext] = change.phases;
  const same = (a: { price: string; quantity: number }[], b: { price: string; quantity: number }[]) =>
    a.length === b.length && a.every((item, i) => item.price === b[i].price && item.quantity === b[i].quantity);
  if (current.end_date !== wantCurrent.endDate) return "first phase does not end at the approved boundary";
  if (!same(current.items, wantCurrent.items)) return "first phase items changed";
  if (next.start_date !== wantNext.startDate) return "second phase does not start at the approved boundary";
  if (!same(next.items, wantNext.items)) return "second phase is not the disclosed price";
  return null;
}
