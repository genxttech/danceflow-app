import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  executePriceTransition,
  planPriceTransition,
  type ScheduleStripe,
  type TransitionNotice,
  type TransitionSubscription,
  type TransitionTargetPrice,
} from "../priceTransition";

const PERIOD_START = new Date("2027-06-09T04:00:00Z");
const BOUNDARY = new Date("2027-07-09T04:00:00Z");
const NOW = new Date("2027-04-01T00:00:00Z");
const PROTECTED_ID = "prot-1";

const subscription = (over: Partial<TransitionSubscription> = {}): TransitionSubscription => ({
  id: "sub_ABC123",
  status: "active",
  currentPeriodStart: PERIOD_START,
  currentPeriodEnd: BOUNDARY,
  cancelAtPeriodEnd: false,
  scheduleId: null,
  items: [{ priceId: "price_legacy129", quantity: 1 }],
  ...over,
});

const notice = (over: Partial<TransitionNotice> = {}): TransitionNotice => ({
  id: "n1",
  protectedSubscriptionId: PROTECTED_ID,
  effectiveAt: BOUNDARY,
  newPriceId: "price_regular",
  newUnitAmountCents: 15900,
  currency: "usd",
  billingInterval: "month",
  approved: true,
  deliveryStatus: "delivered",
  sentAt: new Date("2027-03-01T00:00:00Z"),
  ...over,
});

const target = (over: Partial<TransitionTargetPrice> = {}): TransitionTargetPrice => ({
  id: "price_regular",
  active: true,
  unitAmountCents: 15900,
  currency: "usd",
  interval: "month",
  ...over,
});

const plan = (over: Partial<Parameters<typeof planPriceTransition>[0]> = {}) =>
  planPriceTransition({
    now: NOW,
    subscription: subscription(),
    notice: notice(),
    target: target(),
    approval: { approvedBy: "owner", boundaryAt: BOUNDARY },
    protectedSubscriptionId: PROTECTED_ID,
    ...over,
  });

describe("planPriceTransition", () => {
  it("plans a two-phase, no-proration change at the verified period end", () => {
    const result = plan();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.change.proration).toBe("none");
    expect(result.change.phases[0]).toMatchObject({ endDate: BOUNDARY.getTime() / 1000, items: [{ price: "price_legacy129", quantity: 1 }] });
    expect(result.change.phases[1]).toMatchObject({ startDate: BOUNDARY.getTime() / 1000, items: [{ price: "price_regular", quantity: 1 }] });
  });

  it.each([
    ["no notice", { notice: null }, "notice_missing"],
    ["unapproved notice", { notice: notice({ approved: false }) }, "notice_not_approved"],
    ["undelivered notice", { notice: notice({ deliveryStatus: "pending", sentAt: null }) }, "notice_not_delivered"],
    ["bounced notice", { notice: notice({ deliveryStatus: "bounced" }) }, "notice_not_delivered"],
    ["notice sent under 60 days ahead", { notice: notice({ sentAt: new Date("2027-06-01T00:00:00Z") }) }, "notice_too_late"],
    ["notice for another subscription", { notice: notice({ protectedSubscriptionId: "other" }) }, "notice_for_other_subscription"],
    ["different price than disclosed", { target: target({ id: "price_other" }) }, "target_price_mismatch"],
    ["different amount than disclosed", { target: target({ unitAmountCents: 16900 }) }, "target_price_terms_mismatch"],
    ["inactive target price", { target: target({ active: false }) }, "target_price_inactive"],
    ["no owner approval", { approval: null }, "approval_missing"],
    ["boundary differs from notice date", { approval: { approvedBy: "o", boundaryAt: new Date("2027-08-09T04:00:00Z") } }, "boundary_not_notice_date"],
    ["boundary in the past", { now: new Date("2027-07-10T00:00:00Z") }, "boundary_in_past"],
    ["boundary is not the period end", { subscription: subscription({ currentPeriodEnd: new Date("2027-07-10T04:00:00Z") }) }, "boundary_not_period_end"],
    ["past_due subscription", { subscription: subscription({ status: "past_due" }) }, "subscription_not_active"],
    ["cancelling subscription", { subscription: subscription({ cancelAtPeriodEnd: true }) }, "subscription_cancelling"],
    ["existing schedule", { subscription: subscription({ scheduleId: "sub_sched_1" }) }, "subscription_has_schedule"],
    ["multiple items", { subscription: subscription({ items: [{ priceId: "a", quantity: 1 }, { priceId: "b", quantity: 1 }] }) }, "subscription_unsupported_items"],
  ] as const)("refuses: %s", (_name, over, blocker) => {
    const result = plan(over as never);
    expect(result.ok).toBe(false);
    expect(result.blockers).toContain(blocker);
  });
});

function fakeStripe(
  overrides: {
    retrieve?: ScheduleStripe["subscriptionSchedules"]["retrieve"];
    update?: ScheduleStripe["subscriptionSchedules"]["update"];
  } = {},
) {
  const calls: string[] = [];
  const stripe: ScheduleStripe = {
    subscriptionSchedules: {
      create: vi.fn(async () => {
        calls.push("create");
        return { id: "sub_sched_1" };
      }),
      update: overrides.update ?? vi.fn(async () => void calls.push("update")),
      retrieve:
        overrides.retrieve ??
        vi.fn(async () => ({
          id: "sub_sched_1",
          status: "not_started",
          subscription: "sub_ABC123",
          phases: [
            { start_date: PERIOD_START.getTime() / 1000, end_date: BOUNDARY.getTime() / 1000, items: [{ price: "price_legacy129", quantity: 1 }] },
            { start_date: BOUNDARY.getTime() / 1000, end_date: null, items: [{ price: "price_regular", quantity: 1 }] },
          ],
        })),
      release: vi.fn(async () => void calls.push("release")),
    },
  };
  return { stripe, calls };
}

describe("executePriceTransition", () => {
  it("never touches Stripe for a blocked plan", async () => {
    const { stripe } = fakeStripe();
    const result = await executePriceTransition(stripe, plan({ notice: null }), { keyMode: "test" });
    expect(result.status).toBe("failed");
    expect(stripe.subscriptionSchedules.create).not.toHaveBeenCalled();
  });

  it("refuses a live key unless allowLive is explicit", async () => {
    const { stripe } = fakeStripe();
    const result = await executePriceTransition(stripe, plan(), { keyMode: "live" });
    expect(result).toMatchObject({ status: "failed" });
    expect(stripe.subscriptionSchedules.create).not.toHaveBeenCalled();
  });

  it("creates, updates and verifies the schedule in test mode", async () => {
    const { stripe, calls } = fakeStripe();
    const result = await executePriceTransition(stripe, plan(), { keyMode: "test" });
    expect(result).toEqual({ status: "scheduled", scheduleId: "sub_sched_1" });
    expect(calls).toEqual(["create", "update"]);
    const update = vi.mocked(stripe.subscriptionSchedules.update).mock.calls[0][1];
    expect(update.proration_behavior).toBe("none");
    expect(update.end_behavior).toBe("release");
  });

  it("releases the schedule so the subscription is unchanged when the read-back differs", async () => {
    const retrieve = vi.fn(async () => ({
      id: "sub_sched_1",
      status: "not_started",
      subscription: "sub_ABC123",
      phases: [
        { start_date: PERIOD_START.getTime() / 1000, end_date: BOUNDARY.getTime() / 1000, items: [{ price: "price_legacy129", quantity: 1 }] },
        { start_date: BOUNDARY.getTime() / 1000, end_date: null, items: [{ price: "price_wrong", quantity: 1 }] },
      ],
    }));
    const { stripe, calls } = fakeStripe({ retrieve });
    const result = await executePriceTransition(stripe, plan(), { keyMode: "test" });
    expect(result).toMatchObject({ status: "failed", released: true });
    expect(calls).toContain("release");
  });

  it("releases the schedule when the update call throws", async () => {
    const { stripe, calls } = fakeStripe({ update: vi.fn(async () => { throw new Error("stripe down"); }) });
    const result = await executePriceTransition(stripe, plan(), { keyMode: "test" });
    expect(result).toMatchObject({ status: "failed", reason: "stripe down", released: true });
    expect(calls).toEqual(["create", "release"]);
  });
});

describe("price transition migration", () => {
  const sql = readFileSync(path.join(process.cwd(), "src/lib/supabase/migrations/20270204090000_billing_price_transitions.sql"), "utf8");

  it("is service-role only with permanent rows and one open transition per subscription", () => {
    expect(sql).toMatch(/enable row level security/);
    expect(sql).toMatch(/revoke all on public\.price_transitions from public, anon, authenticated, service_role/);
    expect(sql).not.toMatch(/grant [^;]*\bto (anon|authenticated)\b/);
    expect(sql).not.toMatch(/grant [^;]*\bdelete\b/);
    expect(sql).toMatch(/price_transitions_one_open_per_subscription/);
    expect(sql).toMatch(/before truncate/);
  });
});
