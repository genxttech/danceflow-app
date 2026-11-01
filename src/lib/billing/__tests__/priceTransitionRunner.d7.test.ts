import { describe, expect, it, vi } from "vitest";
import { runPriceTransition, type RunnerArgs, type RunnerDeps } from "../priceTransitionRunner";
import type { ScheduleStripe } from "../priceTransition";

const PERIOD_START = new Date("2027-06-09T04:00:00Z");
const BOUNDARY = new Date("2027-07-09T04:00:00Z");
const u = (d: Date) => d.getTime() / 1000;

function makeDeps(over: Partial<RunnerDeps> = {}, keyMode: "live" | "test" = "test") {
  const audit: Array<{ id: string; status?: string; patch?: unknown }> = [];
  const stripe: ScheduleStripe = {
    subscriptionSchedules: {
      create: vi.fn(async () => ({ id: "sub_sched_1" })),
      update: vi.fn(async () => ({})),
      retrieve: vi.fn(async () => ({
        id: "sub_sched_1",
        status: "not_started",
        subscription: "sub_ABC123",
        phases: [
          { start_date: u(PERIOD_START), end_date: u(BOUNDARY), items: [{ price: "price_legacy129", quantity: 1 }] },
          { start_date: u(BOUNDARY), end_date: null, items: [{ price: "price_regular", quantity: 1 }] },
        ],
      })),
      release: vi.fn(async () => ({})),
    },
  };
  const deps: RunnerDeps = {
    now: () => new Date("2027-04-01T00:00:00Z"),
    stripe,
    keyMode,
    loadRegistry: async () => ({ id: "prot-1", studioId: "st", stripeSubscriptionId: "sub_ABC123", stripeCustomerId: "cus_1", stripePriceId: null, releasedAt: null }),
    loadNotice: async () => ({
      id: "n1", protectedSubscriptionId: "prot-1", effectiveAt: BOUNDARY, newPriceId: "price_regular", newUnitAmountCents: 15900,
      currency: "usd", billingInterval: "month", approved: true, deliveryStatus: "delivered", sentAt: new Date("2027-03-01T00:00:00Z"),
    }),
    hasOpenTransition: async () => false,
    readSubscription: async () => ({
      id: "sub_ABC123", customerId: "cus_1", status: "active", currentPeriodStart: PERIOD_START, currentPeriodEnd: BOUNDARY,
      cancelAtPeriodEnd: false, scheduleId: null, items: [{ priceId: "price_legacy129", quantity: 1 }],
    }),
    readPrice: async () => ({ id: "price_regular", active: true, unitAmountCents: 15900, currency: "usd", interval: "month" }),
    insertAudit: vi.fn(async () => {
      audit.push({ id: "audit-1" });
      return { id: "audit-1" };
    }),
    finalizeAudit: vi.fn(async (id, patch) => void audit.push({ id, status: patch.status, patch })),
    ...over,
  };
  return { deps, stripe, audit };
}

const base: RunnerArgs = {
  protectedSubscriptionId: "prot-1",
  noticeId: "n1",
  stripeSubscriptionId: "sub_ABC123",
  expectedCurrentPriceId: "price_legacy129",
  targetPriceId: "price_regular",
  boundaryAt: BOUNDARY,
};

async function approvedHash() {
  const { deps } = makeDeps();
  const dry = await runPriceTransition(base, deps);
  if (dry.mode !== "dry_run" || !dry.planHash) throw new Error("dry run should pass");
  return dry.planHash;
}

describe("runPriceTransition", () => {
  it("defaults to a dry run: prints a plan hash and writes nothing", async () => {
    const { deps, stripe } = makeDeps();
    const report = await runPriceTransition(base, deps);
    expect(report).toMatchObject({ mode: "dry_run", ok: true });
    expect(deps.insertAudit).not.toHaveBeenCalled();
    expect(stripe.subscriptionSchedules.create).not.toHaveBeenCalled();
  });

  it("executes only with the approver and the hash of the same plan, auditing before and after the Stripe write", async () => {
    const hash = await approvedHash();
    const { deps, stripe } = makeDeps();
    const report = await runPriceTransition({ ...base, execute: true, approvedBy: "owner-1", approvedPlanHash: hash }, deps);
    expect(report).toMatchObject({ mode: "execute", ok: true, status: "scheduled", scheduleId: "sub_sched_1", auditId: "audit-1" });
    const order = [vi.mocked(deps.insertAudit).mock.invocationCallOrder[0], vi.mocked(stripe.subscriptionSchedules.create).mock.invocationCallOrder[0], vi.mocked(deps.finalizeAudit).mock.invocationCallOrder[0]];
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it.each([
    ["no hash", { approvedPlanHash: undefined }, "approved_plan_hash_missing"],
    ["wrong hash", { approvedPlanHash: "deadbeef" }, "stale_or_mismatched_approval"],
    ["no approver", { approvedBy: undefined }, "approval_missing"],
  ] as const)("refuses execution: %s", async (_n, over, blocker) => {
    const hash = await approvedHash();
    const { deps, stripe } = makeDeps();
    const report = await runPriceTransition({ ...base, execute: true, approvedBy: "o", approvedPlanHash: hash, ...over }, deps);
    expect(report.ok).toBe(false);
    expect(JSON.stringify(report.blockers)).toContain(blocker);
    expect(deps.insertAudit).not.toHaveBeenCalled();
    expect(stripe.subscriptionSchedules.create).not.toHaveBeenCalled();
  });

  it("treats an approval as stale once Stripe state changes after the dry run", async () => {
    const hash = await approvedHash();
    const { deps, stripe } = makeDeps({
      readSubscription: async () => ({
        id: "sub_ABC123", customerId: "cus_1", status: "active", currentPeriodStart: PERIOD_START, currentPeriodEnd: BOUNDARY,
        cancelAtPeriodEnd: false, scheduleId: null, items: [{ priceId: "price_legacy129", quantity: 2 }],
      }),
    });
    const report = await runPriceTransition({ ...base, execute: true, approvedBy: "o", approvedPlanHash: hash }, deps);
    expect(report.blockers).toContain("stale_or_mismatched_approval");
    expect(stripe.subscriptionSchedules.create).not.toHaveBeenCalled();
  });

  it("requires a separate live authorization for a live key", async () => {
    const hash = await approvedHash();
    const live = makeDeps({}, "live");
    const refused = await runPriceTransition({ ...base, execute: true, approvedBy: "o", approvedPlanHash: hash }, live.deps);
    expect(refused.blockers).toContain("live_authorization_missing");
    expect(live.stripe.subscriptionSchedules.create).not.toHaveBeenCalled();
  });

  it.each([
    ["registry points at another subscription", { loadRegistry: async () => ({ id: "prot-1", studioId: "st", stripeSubscriptionId: "sub_OTHER", stripeCustomerId: "cus_1", stripePriceId: null, releasedAt: null }) }, "registry_subscription_mismatch"],
    ["released registry row", { loadRegistry: async () => ({ id: "prot-1", studioId: "st", stripeSubscriptionId: "sub_ABC123", stripeCustomerId: "cus_1", stripePriceId: null, releasedAt: "2027-01-01" }) }, "registry_row_released"],
    ["customer differs", { loadRegistry: async () => ({ id: "prot-1", studioId: "st", stripeSubscriptionId: "sub_ABC123", stripeCustomerId: "cus_2", stripePriceId: null, releasedAt: null }) }, "customer_mismatch"],
    ["registry price differs from expected", { loadRegistry: async () => ({ id: "prot-1", studioId: "st", stripeSubscriptionId: "sub_ABC123", stripeCustomerId: "cus_1", stripePriceId: "price_x", releasedAt: null }) }, "registry_price_mismatch"],
    ["open transition already exists", { hasOpenTransition: async () => true }, "open_transition_exists"],
    ["notice missing", { loadNotice: async () => null }, "notice_missing"],
    ["amount differs from notice", { readPrice: async () => ({ id: "price_regular", active: true, unitAmountCents: 17900, currency: "usd", interval: "month" }) }, "target_price_terms_mismatch"],
  ] as const)("refuses: %s", async (_n, over, blocker) => {
    const { deps, stripe } = makeDeps(over as Partial<RunnerDeps>);
    const report = await runPriceTransition({ ...base, execute: true, approvedBy: "o", approvedPlanHash: "x" }, deps);
    expect(report.ok).toBe(false);
    expect(report.blockers).toContain(blocker);
    expect(stripe.subscriptionSchedules.create).not.toHaveBeenCalled();
  });

  it("refuses when the subscription's current price is not the one the operator expected", async () => {
    const { deps } = makeDeps();
    const report = await runPriceTransition({ ...base, expectedCurrentPriceId: "price_other" }, deps);
    expect(report.blockers).toContain("current_price_unexpected");
  });

  it("stops before Stripe when the audit insert collides (replay or concurrent run)", async () => {
    const hash = await approvedHash();
    const { deps, stripe } = makeDeps({ insertAudit: vi.fn(async () => { throw new Error("duplicate key"); }) });
    const report = await runPriceTransition({ ...base, execute: true, approvedBy: "o", approvedPlanHash: hash }, deps);
    expect(report.blockers).toContain("audit_insert_failed");
    expect(stripe.subscriptionSchedules.create).not.toHaveBeenCalled();
  });

  it("records a failed execution in the audit row and leaves no schedule", async () => {
    const hash = await approvedHash();
    const { deps, stripe } = makeDeps();
    vi.mocked(stripe.subscriptionSchedules.update).mockRejectedValueOnce(new Error("boom"));
    const report = await runPriceTransition({ ...base, execute: true, approvedBy: "o", approvedPlanHash: hash }, deps);
    expect(report).toMatchObject({ ok: false, status: "failed", reason: "boom" });
    expect(stripe.subscriptionSchedules.release).toHaveBeenCalled();
    expect(deps.finalizeAudit).toHaveBeenCalledWith("audit-1", expect.objectContaining({ status: "failed" }));
  });
});
