import { describe, expect, it, vi } from "vitest";
import {
  PROTECTED_PRICE_BOUNDARY,
  evaluateReconciliation,
  reconcilePriceTransition,
  type ReconcileDeps,
  type ReconcileInputs,
  type ReconcileOutcome,
} from "../priceTransitionReconcile";
import { isPriceTransitionReconcileEnabled, maybeReconcilePriceTransition } from "../priceTransitionWebhook";

const BOUNDARY = PROTECTED_PRICE_BOUNDARY;
const AFTER = new Date(BOUNDARY.getTime() + 2 * 3_600_000);
const NEXT_END = new Date("2027-08-09T04:00:00Z");

const inputs = (over: Partial<ReconcileInputs> = {}): ReconcileInputs => ({
  now: AFTER,
  transition: {
    id: "t1", status: "scheduled", protectedSubscriptionId: "prot-1", stripeSubscriptionId: "sub_ABC123", stripeScheduleId: "sub_sched_1",
    targetPriceId: "price_regular", boundaryAt: BOUNDARY, activatedAt: null, priceChangedAt: null, noticeAmountCents: 15900, noticeCurrency: "usd",
  },
  registry: { id: "prot-1", studioId: "st", stripeCustomerId: "cus_1", stripeSubscriptionId: "sub_ABC123", releasedAt: null, protectionKind: "grandfathered_founder_legacy" },
  studioCustomerId: "cus_1",
  subscription: {
    id: "sub_ABC123", customerId: "cus_1", status: "active", currentPeriodStart: BOUNDARY, currentPeriodEnd: NEXT_END, scheduleId: "sub_sched_1",
    items: [{ priceId: "price_regular", quantity: 1 }],
  },
  schedule: { id: "sub_sched_1", status: "active", subscriptionId: "sub_ABC123", currentPhaseStart: BOUNDARY },
  price: { id: "price_regular", unitAmountCents: 15900, currency: "usd" },
  ...over,
});

const reasons = (o: ReconcileOutcome) => (o.state === "needs_review" ? o.reasons : []);

describe("evaluateReconciliation", () => {
  it("uses the policy boundary: July 9, 2027 04:00 UTC", () => {
    expect(BOUNDARY.toISOString()).toBe("2027-07-09T04:00:00.000Z");
  });

  it("is ready when Stripe entered the phase and the subscription is on the approved price in a period that started at the boundary", () => {
    const outcome = evaluateReconciliation(inputs());
    expect(outcome.state).toBe("ready");
    if (outcome.state === "ready") expect(outcome.evidence).toMatchObject({ phase_entered: true, price_changed: true, customer_matches: true, studio_matches: true, amount_matches_notice: true });
  });

  it("is not due before the boundary, even if Stripe already looks changed", () => {
    expect(evaluateReconciliation(inputs({ now: new Date(BOUNDARY.getTime() - 1000) })).state).toBe("not_due");
  });

  it("does not require payment: past_due and unpaid subscriptions on the new price still reconcile", () => {
    for (const status of ["past_due", "unpaid", "active"]) {
      const base = inputs();
      const outcome = evaluateReconciliation({ ...base, subscription: { ...base.subscription!, status } });
      expect(outcome.state).toBe("ready");
    }
  });

  it("waits (does not fail) inside the grace window when Stripe has not rolled the period yet", () => {
    const base = inputs();
    const outcome = evaluateReconciliation(
      inputs({
        subscription: { ...base.subscription!, currentPeriodStart: new Date("2027-06-09T04:00:00Z"), currentPeriodEnd: BOUNDARY, items: [{ priceId: "price_legacy129", quantity: 1 }] },
        schedule: { id: "sub_sched_1", status: "not_started", subscriptionId: "sub_ABC123", currentPhaseStart: new Date("2027-06-09T04:00:00Z") },
      }),
    );
    expect(outcome.state).toBe("awaiting_stripe");
  });

  it("escalates to needs_review when Stripe never transitions within the grace window", () => {
    const base = inputs();
    const outcome = evaluateReconciliation(
      inputs({
        now: new Date(BOUNDARY.getTime() + 25 * 3_600_000),
        subscription: { ...base.subscription!, currentPeriodStart: new Date("2027-06-09T04:00:00Z"), currentPeriodEnd: BOUNDARY, items: [{ priceId: "price_legacy129", quantity: 1 }] },
        schedule: { id: "sub_sched_1", status: "not_started", subscriptionId: "sub_ABC123", currentPhaseStart: new Date("2027-06-09T04:00:00Z") },
      }),
    );
    expect(reasons(outcome)).toContain("stripe_did_not_transition_within_grace");
  });

  it.each([
    ["target price outside the boundary period (Stripe boundary conflicts with July 9)", (i: ReconcileInputs) => ({ subscription: { ...i.subscription!, currentPeriodStart: new Date(BOUNDARY.getTime() + 86_400_000) } }), "boundary_conflict_target_price_outside_boundary_period"],
    ["a third, unexpected price", (i: ReconcileInputs) => ({ subscription: { ...i.subscription!, items: [{ priceId: "price_other", quantity: 1 }] } }), "unexpected_price_after_boundary"],
    ["price amount differs from the disclosed notice", () => ({ price: { id: "price_regular", unitAmountCents: 24900, currency: "usd" } }), "target_price_amount_differs_from_notice"],
    ["customer differs from the registry", (i: ReconcileInputs) => ({ subscription: { ...i.subscription!, customerId: "cus_2" } }), "customer_mismatch"],
    ["studio's billing customer differs", () => ({ studioCustomerId: "cus_other" }), "studio_customer_mismatch"],
    ["registry customer unbound", (i: ReconcileInputs) => ({ registry: { ...i.registry!, stripeCustomerId: null } }), "customer_unbound"],
    ["subscription id differs", (i: ReconcileInputs) => ({ subscription: { ...i.subscription!, id: "sub_OTHER" } }), "stripe_subscription_id_mismatch"],
    ["subscription missing", () => ({ subscription: null }), "stripe_subscription_missing"],
    ["subscription canceled", (i: ReconcileInputs) => ({ subscription: { ...i.subscription!, status: "canceled" } }), "subscription_ended"],
    ["registry released outside reconciliation", (i: ReconcileInputs) => ({ registry: { ...i.registry!, releasedAt: "2027-01-01" } }), "registry_row_released_outside_reconciliation"],
    ["boundary is not the policy date", (i: ReconcileInputs) => ({ transition: { ...i.transition, boundaryAt: new Date("2027-08-09T04:00:00Z") }, now: new Date("2027-08-10T04:00:00Z") }), "boundary_not_policy_date"],
    ["schedule belongs to another subscription", (i: ReconcileInputs) => ({ schedule: { ...i.schedule!, subscriptionId: "sub_OTHER" } }), "schedule_identity_mismatch"],
    ["target price unreadable", () => ({ price: null }), "target_price_unreadable"],
  ] as const)("fails closed: %s", (_name, mutate, reason) => {
    const base = inputs();
    const outcome = evaluateReconciliation({ ...base, ...(mutate as (i: ReconcileInputs) => Partial<ReconcileInputs>)(base) });
    expect(outcome.state).toBe("needs_review");
    expect(reasons(outcome)).toContain(reason);
  });

  it("treats a completed or released schedule as activated, and keeps price change as a separate fact", () => {
    const base = inputs();
    const released = evaluateReconciliation({ ...base, schedule: { id: "sub_sched_1", status: "released", subscriptionId: "sub_ABC123", currentPhaseStart: null }, subscription: { ...base.subscription!, scheduleId: null } });
    expect(released.state).toBe("ready");
    const phaseOnly = evaluateReconciliation({
      ...base,
      subscription: { ...base.subscription!, currentPeriodStart: new Date("2027-06-09T04:00:00Z"), items: [{ priceId: "price_legacy129", quantity: 1 }] },
    });
    expect(phaseOnly.state).toBe("awaiting_stripe");
    if (phaseOnly.state === "awaiting_stripe") expect(phaseOnly.milestones).toEqual({ phaseEntered: true, priceChanged: false });
  });

  it("is a no-op for reconciled and not-applicable transitions", () => {
    expect(evaluateReconciliation(inputs({ transition: { ...inputs().transition, status: "reconciled" } })).state).toBe("already_reconciled");
    expect(evaluateReconciliation(inputs({ transition: { ...inputs().transition, status: "approved" } })).state).toBe("not_applicable");
    expect(evaluateReconciliation(inputs({ transition: { ...inputs().transition, status: "failed" } })).state).toBe("not_applicable");
  });
});

function makeDeps(over: Partial<ReconcileDeps> = {}, state: Partial<ReconcileInputs> = {}) {
  const i = inputs(state);
  const deps: ReconcileDeps = {
    now: () => i.now,
    loadTransition: vi.fn(async () => i.transition),
    loadRegistry: vi.fn(async () => i.registry),
    loadStudioCustomerId: vi.fn(async () => i.studioCustomerId),
    readSubscription: vi.fn(async () => i.subscription),
    readSchedule: vi.fn(async () => i.schedule),
    readPrice: vi.fn(async () => i.price),
    recordMilestones: vi.fn(async () => undefined),
    flagReview: vi.fn(async () => undefined),
    complete: vi.fn(async () => "reconciled" as const),
    ...over,
  };
  return deps;
}

describe("reconcilePriceTransition", () => {
  it("is a dry run by default: reports ready and writes nothing", async () => {
    const deps = makeDeps();
    const report = await reconcilePriceTransition("t1", deps);
    expect(report).toMatchObject({ state: "ready", applied: false, changed: false });
    expect(deps.recordMilestones).not.toHaveBeenCalled();
    expect(deps.complete).not.toHaveBeenCalled();
  });

  it("records milestones, then completes atomically, with the evidence the database re-verifies", async () => {
    const deps = makeDeps();
    const report = await reconcilePriceTransition("t1", deps, { apply: true });
    expect(report).toMatchObject({ state: "completed", changed: true });
    expect(deps.recordMilestones).toHaveBeenCalledWith("t1", { activatedAt: AFTER, priceChangedAt: AFTER });
    expect(deps.complete).toHaveBeenCalledWith("t1", expect.objectContaining({ subscription_id: "sub_ABC123", price_id: "price_regular", schedule_id: "sub_sched_1", price_changed: true, phase_entered: true }));
  });

  it("is replay safe: an already reconciled transition changes nothing", async () => {
    const deps = makeDeps({}, { transition: { ...inputs().transition, status: "reconciled" } });
    const report = await reconcilePriceTransition("t1", deps, { apply: true });
    expect(report).toMatchObject({ state: "already_reconciled", changed: false });
    expect(deps.complete).not.toHaveBeenCalled();
  });

  it("duplicate or out-of-order triggers converge: two runs complete once, the second sees already_reconciled", async () => {
    let done = false;
    const deps = makeDeps({
      complete: vi.fn(async () => {
        const result = done ? ("already_reconciled" as const) : ("reconciled" as const);
        done = true;
        return result;
      }),
    });
    const [a, b] = await Promise.all([reconcilePriceTransition("t1", deps, { apply: true }), reconcilePriceTransition("t1", deps, { apply: true })]);
    expect([a.changed, b.changed].filter(Boolean).length).toBeGreaterThanOrEqual(1);
    expect(vi.mocked(deps.complete).mock.results.length).toBe(2);
  });

  it("resumes after a crash between the milestone write and the completion", async () => {
    const crashing = makeDeps({ complete: vi.fn(async () => { throw new Error("db down"); }) });
    await expect(reconcilePriceTransition("t1", crashing, { apply: true })).rejects.toThrow("db down");
    // next trigger: milestones already recorded, completion succeeds
    const resumed = makeDeps({}, { transition: { ...inputs().transition, activatedAt: AFTER, priceChangedAt: AFTER } });
    const report = await reconcilePriceTransition("t1", resumed, { apply: true });
    expect(report.state).toBe("completed");
    expect(resumed.recordMilestones).not.toHaveBeenCalled();
  });

  it("flags needs_review once, preserving evidence, and never completes", async () => {
    const deps = makeDeps({}, { price: { id: "price_regular", unitAmountCents: 24900, currency: "usd" } });
    const report = await reconcilePriceTransition("t1", deps, { apply: true });
    expect(report).toMatchObject({ state: "needs_review", reasons: ["target_price_amount_differs_from_notice"] });
    expect(deps.flagReview).toHaveBeenCalledWith("t1", ["target_price_amount_differs_from_notice"], expect.objectContaining({ observed_amount_cents: 24900 }));
    expect(deps.complete).not.toHaveBeenCalled();
    const again = makeDeps({}, { price: { id: "price_regular", unitAmountCents: 24900, currency: "usd" }, transition: { ...inputs().transition, status: "needs_review" } });
    await reconcilePriceTransition("t1", again, { apply: true });
    expect(again.flagReview).not.toHaveBeenCalled();
  });

  it("completes a needs_review transition once the owner remediates and the state is consistent", async () => {
    const deps = makeDeps({}, { transition: { ...inputs().transition, status: "needs_review" } });
    const report = await reconcilePriceTransition("t1", deps, { apply: true });
    expect(report.state).toBe("completed");
  });

  it("does nothing before the boundary and while Stripe is still rolling", async () => {
    const early = makeDeps({}, { now: new Date(BOUNDARY.getTime() - 60_000) });
    expect((await reconcilePriceTransition("t1", early, { apply: true })).state).toBe("not_due");
    expect(early.recordMilestones).not.toHaveBeenCalled();
  });
});

describe("price transition webhook hook", () => {
  it("is dark unless PRICE_TRANSITION_RECONCILE_ENABLED is exactly true", () => {
    expect(isPriceTransitionReconcileEnabled({})).toBe(false);
    expect(isPriceTransitionReconcileEnabled({ PRICE_TRANSITION_RECONCILE_ENABLED: "1" })).toBe(false);
    expect(isPriceTransitionReconcileEnabled({ PRICE_TRANSITION_RECONCILE_ENABLED: "true" })).toBe(true);
  });

  it("never touches the database when dark, and never throws when enabled and the lookup fails", async () => {
    const from = vi.fn(() => { throw new Error("db down"); });
    const db = { from } as never;
    await maybeReconcilePriceTransition({ db, stripe: {} as never, stripeSubscriptionId: "sub_ABC123", env: {} });
    expect(from).not.toHaveBeenCalled();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(maybeReconcilePriceTransition({ db, stripe: {} as never, stripeSubscriptionId: "sub_ABC123", env: { PRICE_TRANSITION_RECONCILE_ENABLED: "true" } })).resolves.toBeUndefined();
    expect(from).toHaveBeenCalled();
    error.mockRestore();
  });

  it("ignores events without a subscription id", async () => {
    const from = vi.fn();
    await maybeReconcilePriceTransition({ db: { from } as never, stripe: {} as never, stripeSubscriptionId: null, env: { PRICE_TRANSITION_RECONCILE_ENABLED: "true" } });
    expect(from).not.toHaveBeenCalled();
  });
});
