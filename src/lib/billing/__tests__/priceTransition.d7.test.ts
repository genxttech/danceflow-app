import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  executePriceTransition,
  planPriceTransition,

  type TransitionNotice,
  type TransitionSubscription,
  type TransitionTargetPrice,
} from "../priceTransition";
import { BOUNDARY, CARRY, PERIOD_START, statefulStripe, u } from "./priceTransitionFakes";

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
  intervalCount: 1,
  type: "recurring",
  billingScheme: "per_unit",
  usageType: "licensed",
  hasTransformQuantity: false,
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

describe("planPriceTransition: review hardening", () => {
  it.each([
    ["trial on the subscription", { subscription: subscription({ unsupportedSettings: ["trial"] }) }, "subscription_unsupported_settings"],
    ["pause_collection", { subscription: subscription({ unsupportedSettings: ["pause_collection"] }) }, "subscription_unsupported_settings"],
    ["discounts", { subscription: subscription({ unsupportedSettings: ["discounts"] }) }, "subscription_unsupported_settings"],
    ["two-month interval target", { target: target({ intervalCount: 2 }) }, "target_price_shape_unsupported"],
    ["metered target", { target: target({ usageType: "metered" }) }, "target_price_shape_unsupported"],
    ["tiered target", { target: target({ billingScheme: "tiered" }) }, "target_price_shape_unsupported"],
    ["transform_quantity target", { target: target({ hasTransformQuantity: true }) }, "target_price_shape_unsupported"],
    ["target shape unknown", { target: target({ intervalCount: undefined }) }, "target_price_shape_unsupported"],
    ["too close to the boundary", { now: new Date("2027-07-08T12:00:00Z") }, "boundary_too_soon"],
  ] as const)("refuses: %s", (_name, over, blocker) => {
    const result = plan(over as never);
    expect(result.ok).toBe(false);
    expect(result.blockers).toContain(blocker);
  });
});

describe("executePriceTransition", () => {
  it("never touches Stripe for a blocked plan", async () => {
    const { stripe } = statefulStripe();
    const result = await executePriceTransition(stripe, plan({ notice: null }), { keyMode: "test" });
    expect(result.status).toBe("failed");
    expect(stripe.subscriptionSchedules.create).not.toHaveBeenCalled();
  });

  it("refuses a live key unless allowLive is explicit", async () => {
    const { stripe } = statefulStripe();
    const result = await executePriceTransition(stripe, plan(), { keyMode: "live" });
    expect(result).toMatchObject({ status: "failed" });
    expect(stripe.subscriptionSchedules.create).not.toHaveBeenCalled();
  });

  it("builds both phases from the created schedule and carries metadata, tax and item settings into each", async () => {
    const { stripe, calls, state } = statefulStripe();
    const onScheduleCreated = vi.fn(async () => undefined);
    const result = await executePriceTransition(stripe, plan(), { keyMode: "test", onScheduleCreated, idempotencyPrefix: "d7wp3-audit1" });
    expect(result).toEqual({ status: "scheduled", scheduleId: "sub_sched_1" });
    expect(calls).toEqual(["create", "update"]);
    expect(onScheduleCreated).toHaveBeenCalledWith("sub_sched_1");
    const update = vi.mocked(stripe.subscriptionSchedules.update).mock;
    expect(update.calls[0][1].proration_behavior).toBe("none");
    expect(update.calls[0][1].end_behavior).toBe("release");
    expect(update.calls[0][2]).toEqual({ idempotencyKey: "d7wp3-audit1-update" });
    expect(vi.mocked(stripe.subscriptionSchedules.create).mock.calls[0][1]).toEqual({ idempotencyKey: "d7wp3-audit1-create" });
    for (const phase of state().phases) {
      expect(phase.metadata).toEqual(CARRY.metadata);
      expect(phase.default_tax_rates).toEqual(CARRY.default_tax_rates);
      expect(phase.collection_method).toBe("charge_automatically");
    }
    expect(state().phases[0].items[0]).toMatchObject({ price: "price_legacy129", quantity: 1, metadata: { k: "v" } });
    expect(state().phases[1].items[0]).toMatchObject({ price: "price_regular", quantity: 1, metadata: { k: "v" } });
  });

  it("releases and reports failure when a carried setting is lost on the read-back", async () => {
    const { stripe, calls } = statefulStripe({ dropCarryOnUpdate: true });
    const result = await executePriceTransition(stripe, plan(), { keyMode: "test" });
    expect(result).toMatchObject({ status: "failed", released: true });
    expect((result as { reason: string }).reason).toMatch(/lost metadata/);
    expect(calls).toContain("release");
  });

  it("releases the schedule when the update call throws", async () => {
    const { stripe, calls } = statefulStripe({ failUpdate: true });
    const result = await executePriceTransition(stripe, plan(), { keyMode: "test" });
    expect(result).toMatchObject({ status: "failed", reason: "stripe down", released: true });
    expect(calls).toEqual(["create", "update", "release"]);
  });

  it("finds and releases an orphan schedule when the create response is lost", async () => {
    const { stripe, calls, state } = statefulStripe({ loseCreateResponse: true });
    const result = await executePriceTransition(stripe, plan(), { keyMode: "test" });
    expect(result).toMatchObject({ status: "failed", scheduleId: "sub_sched_1", released: true });
    expect(calls).toEqual(["create", "release"]);
    expect(state().attached).toBeNull();
  });

  it("reports released:false loudly when the release itself fails", async () => {
    const { stripe } = statefulStripe({ failUpdate: true, failRelease: true });
    const result = await executePriceTransition(stripe, plan(), { keyMode: "test" });
    expect(result).toMatchObject({ status: "failed", scheduleId: "sub_sched_1", released: false });
  });

  it("refuses when the schedule Stripe created does not match the approved period start", async () => {
    const { stripe } = statefulStripe();
    const retrieve = stripe.subscriptionSchedules.retrieve;
    vi.mocked(retrieve).mockImplementationOnce(async () => ({
      id: "sub_sched_1", status: "not_started", subscription: "sub_ABC123",
      phases: [{ start_date: u(PERIOD_START) + 5, end_date: u(BOUNDARY), items: [{ price: "price_legacy129", quantity: 1 }] }],
    }));
    const result = await executePriceTransition(stripe, plan(), { keyMode: "test" });
    expect(result).toMatchObject({ status: "failed", released: true });
    expect(stripe.subscriptionSchedules.update).not.toHaveBeenCalled();
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
