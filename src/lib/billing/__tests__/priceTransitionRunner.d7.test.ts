import { describe, expect, it, vi } from "vitest";
import { runPriceTransition, type RegistryRow, type RunnerArgs, type RunnerDeps } from "../priceTransitionRunner";
import { BOUNDARY, PERIOD_START, statefulStripe } from "./priceTransitionFakes";

const registryRow = (over: Partial<RegistryRow> = {}): RegistryRow => ({
  id: "prot-1", studioId: "st", stripeSubscriptionId: "sub_ABC123", stripeCustomerId: "cus_1", stripePriceId: null, releasedAt: null, ...over,
});

function makeDeps(over: Partial<RunnerDeps> = {}, keyMode: "live" | "test" = "test", stripeOptions: Parameters<typeof statefulStripe>[0] = {}) {
  const { stripe, calls, state } = statefulStripe(stripeOptions);
  const deps: RunnerDeps = {
    now: () => new Date("2027-04-01T00:00:00Z"),
    stripe,
    keyMode,
    isAuthorizedApprover: (id) => id === "owner-1",
    loadRegistry: async () => registryRow(),
    loadNotice: async () => ({
      id: "n1", protectedSubscriptionId: "prot-1", studioId: "st", effectiveAt: BOUNDARY, newPriceId: "price_regular", newUnitAmountCents: 15900,
      currency: "usd", billingInterval: "month", approved: true, deliveryStatus: "delivered", sentAt: new Date("2027-03-01T00:00:00Z"),
    }),
    hasOpenTransition: async () => false,
    readSubscription: async () => ({
      id: "sub_ABC123", customerId: "cus_1", status: "active", currentPeriodStart: PERIOD_START, currentPeriodEnd: BOUNDARY,
      cancelAtPeriodEnd: false, scheduleId: null, items: [{ priceId: "price_legacy129", quantity: 1 }], unsupportedSettings: [],
    }),
    readPrice: async () => ({
      id: "price_regular", active: true, unitAmountCents: 15900, currency: "usd", interval: "month",
      intervalCount: 1, type: "recurring", billingScheme: "per_unit", usageType: "licensed", hasTransformQuantity: false,
    }),
    insertAudit: vi.fn(async () => ({ id: "audit-1" })),
    recordSchedule: vi.fn(async () => undefined),
    finalizeAudit: vi.fn(async () => undefined),
    ...over,
  };
  return { deps, stripe, calls, state };
}

const base: RunnerArgs = {
  protectedSubscriptionId: "prot-1",
  noticeId: "n1",
  stripeSubscriptionId: "sub_ABC123",
  expectedCurrentPriceId: "price_legacy129",
  targetPriceId: "price_regular",
  boundaryAt: BOUNDARY,
};

async function approvedHash(keyMode: "live" | "test" = "test") {
  const { deps } = makeDeps({}, keyMode);
  const dry = await runPriceTransition(base, deps);
  if (dry.mode !== "dry_run" || !dry.planHash) throw new Error("dry run should pass");
  return dry.planHash;
}

const exec = (hash: string, over: Partial<RunnerArgs> = {}): RunnerArgs => ({ ...base, execute: true, approvedBy: "owner-1", approvedPlanHash: hash, ...over });

describe("runPriceTransition", () => {
  it("defaults to a dry run: prints a plan hash and writes nothing", async () => {
    const { deps, stripe } = makeDeps();
    const report = await runPriceTransition(base, deps);
    expect(report).toMatchObject({ mode: "dry_run", ok: true });
    expect(deps.insertAudit).not.toHaveBeenCalled();
    expect(stripe.subscriptionSchedules.create).not.toHaveBeenCalled();
  });

  it("executes only with an authorized approver and the hash of the same plan, auditing around the Stripe write", async () => {
    const hash = await approvedHash();
    const { deps, stripe } = makeDeps();
    const report = await runPriceTransition(exec(hash), deps);
    expect(report).toMatchObject({ mode: "execute", ok: true, status: "scheduled", scheduleId: "sub_sched_1", auditId: "audit-1" });
    expect(deps.recordSchedule).toHaveBeenCalledWith("audit-1", "sub_sched_1");
    const order = [
      vi.mocked(deps.insertAudit).mock.invocationCallOrder[0],
      vi.mocked(stripe.subscriptionSchedules.create).mock.invocationCallOrder[0],
      vi.mocked(deps.recordSchedule).mock.invocationCallOrder[0],
      vi.mocked(deps.finalizeAudit).mock.invocationCallOrder[0],
    ];
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it.each([
    ["no hash", { approvedPlanHash: undefined }, "approved_plan_hash_missing"],
    ["wrong hash", { approvedPlanHash: "deadbeef" }, "stale_or_mismatched_approval"],
    ["no approver", { approvedBy: undefined }, "approval_missing"],
    ["approver not on the owner list", { approvedBy: "someone-else" }, "approver_not_authorized"],
  ] as const)("refuses execution: %s", async (_n, over, blocker) => {
    const hash = await approvedHash();
    const { deps, stripe } = makeDeps();
    const report = await runPriceTransition(exec(hash, over), deps);
    expect(report.ok).toBe(false);
    expect(report.blockers).toContain(blocker);
    expect(deps.insertAudit).not.toHaveBeenCalled();
    expect(stripe.subscriptionSchedules.create).not.toHaveBeenCalled();
  });

  it("treats an approval as stale once Stripe state changes after the dry run", async () => {
    const hash = await approvedHash();
    const { deps, stripe } = makeDeps({
      readSubscription: async () => ({
        id: "sub_ABC123", customerId: "cus_1", status: "active", currentPeriodStart: PERIOD_START, currentPeriodEnd: BOUNDARY,
        cancelAtPeriodEnd: false, scheduleId: null, items: [{ priceId: "price_legacy129", quantity: 2 }], unsupportedSettings: [],
      }),
    });
    const report = await runPriceTransition(exec(hash), deps);
    expect(report.blockers).toContain("stale_or_mismatched_approval");
    expect(stripe.subscriptionSchedules.create).not.toHaveBeenCalled();
  });

  it("binds the approval to the key mode: a hash from a test dry run does not approve a live run", async () => {
    const testHash = await approvedHash("test");
    const live = makeDeps({}, "live");
    const report = await runPriceTransition(exec(testHash, { allowLive: true, liveAuthorizationRef: "AUTH-1" }), live.deps);
    expect(report.blockers).toContain("stale_or_mismatched_approval");
    expect(live.stripe.subscriptionSchedules.create).not.toHaveBeenCalled();
  });

  it("requires a separate live authorization for a live key", async () => {
    const hash = await approvedHash("live");
    const live = makeDeps({}, "live");
    const refused = await runPriceTransition(exec(hash), live.deps);
    expect(refused.blockers).toContain("live_authorization_missing");
    expect(live.stripe.subscriptionSchedules.create).not.toHaveBeenCalled();
    const blank = await runPriceTransition(exec(hash, { allowLive: true, liveAuthorizationRef: "  " }), live.deps);
    expect(blank.blockers).toContain("live_authorization_missing");
  });

  it("stops before any Stripe write when the subscription changes between the audit insert and the write", async () => {
    const hash = await approvedHash();
    let reads = 0;
    const { deps, stripe } = makeDeps({
      readSubscription: async () => {
        reads += 1;
        return {
          id: "sub_ABC123", customerId: "cus_1", status: "active", currentPeriodStart: PERIOD_START, currentPeriodEnd: BOUNDARY,
          cancelAtPeriodEnd: false, scheduleId: null, items: [{ priceId: "price_legacy129", quantity: reads > 1 ? 3 : 1 }], unsupportedSettings: [],
        };
      },
    });
    const report = await runPriceTransition(exec(hash), deps);
    expect(report).toMatchObject({ ok: false, status: "refused", auditId: "audit-1" });
    expect(report.blockers).toContain("state_changed_before_write");
    expect(stripe.subscriptionSchedules.create).not.toHaveBeenCalled();
    expect(deps.finalizeAudit).toHaveBeenCalledWith("audit-1", expect.objectContaining({ status: "failed" }));
  });

  it.each([
    ["registry points at another subscription", { loadRegistry: async () => registryRow({ stripeSubscriptionId: "sub_OTHER" }) }, "registry_subscription_mismatch"],
    ["released registry row", { loadRegistry: async () => registryRow({ releasedAt: "2027-01-01" }) }, "registry_row_released"],
    ["customer differs", { loadRegistry: async () => registryRow({ stripeCustomerId: "cus_2" }) }, "customer_mismatch"],
    ["registry has no customer bound", { loadRegistry: async () => registryRow({ stripeCustomerId: null }) }, "customer_unbound"],
    ["registry price differs from expected", { loadRegistry: async () => registryRow({ stripePriceId: "price_x" }) }, "registry_price_mismatch"],
    ["open transition already exists", { hasOpenTransition: async () => true }, "open_transition_exists"],
    ["notice missing", { loadNotice: async () => null }, "notice_missing"],
    ["notice belongs to another studio", { loadRegistry: async () => registryRow({ studioId: "other-studio" }) }, "notice_studio_mismatch"],
    ["amount differs from notice", { readPrice: async () => ({ id: "price_regular", active: true, unitAmountCents: 17900, currency: "usd", interval: "month", intervalCount: 1, type: "recurring", billingScheme: "per_unit", usageType: "licensed", hasTransformQuantity: false }) }, "target_price_terms_mismatch"],
  ] as const)("refuses: %s", async (_n, over, blocker) => {
    const { deps, stripe } = makeDeps(over as Partial<RunnerDeps>);
    const report = await runPriceTransition(exec("x"), deps);
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
    const report = await runPriceTransition(exec(hash), deps);
    expect(report.blockers).toContain("audit_insert_failed");
    expect(stripe.subscriptionSchedules.create).not.toHaveBeenCalled();
  });

  it("records a failed execution in the audit row and leaves no schedule", async () => {
    const hash = await approvedHash();
    const { deps, stripe, state } = makeDeps({}, "test", { failUpdate: true });
    const report = await runPriceTransition(exec(hash), deps);
    expect(report).toMatchObject({ ok: false, status: "failed", reason: "stripe down", released: true });
    expect(stripe.subscriptionSchedules.release).toHaveBeenCalled();
    expect(state().attached).toBeNull();
    expect(deps.finalizeAudit).toHaveBeenCalledWith("audit-1", expect.objectContaining({ status: "failed" }));
  });

  it("flags a schedule that may still be attached when release fails", async () => {
    const hash = await approvedHash();
    const { deps } = makeDeps({}, "test", { failUpdate: true, failRelease: true });
    const report = await runPriceTransition(exec(hash), deps);
    expect(report).toMatchObject({ ok: false, status: "failed", scheduleId: "sub_sched_1", released: false });
    expect(report.blockers).toContain("schedule_may_still_be_attached");
  });

  it("still reports the live schedule id when the audit finalize keeps failing", async () => {
    const hash = await approvedHash();
    const { deps } = makeDeps({ finalizeAudit: vi.fn(async () => { throw new Error("db down"); }) });
    const report = await runPriceTransition(exec(hash), deps);
    expect(report).toMatchObject({ ok: false, status: "scheduled", scheduleId: "sub_sched_1" });
    expect(report.blockers).toContain("audit_finalize_failed_schedule_is_live");
    expect(deps.finalizeAudit).toHaveBeenCalledTimes(3);
  });
});
