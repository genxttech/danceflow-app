import { describe, expect, it, vi } from "vitest";
import {
  MAX_SUBSCRIPTION_ITEMS,
  executePriceTransition,
  planPriceTransition,
  type TransitionItem,
  type TransitionItemShape,
  type TransitionNotice,
  type TransitionSubscription,
  type TransitionTargetPrice,
} from "../priceTransition";
import { mapStripeSubscription } from "../priceTransitionStripeRead";
import { runPriceTransition, type RegistryRow, type RunnerArgs, type RunnerDeps } from "../priceTransitionRunner";
import {
  PROTECTED_PRICE_BOUNDARY,
  approvedFromDryRun,
  evaluateReconciliation,
  reconcilePriceTransition,
  type ReconcileDeps,
  type ReconcileInputs,
  type ReconcileOutcome,
} from "../priceTransitionReconcile";
import { BOUNDARY, PERIOD_START, statefulStripe, u, type FakeItem } from "./priceTransitionFakes";

const NOW = new Date("2027-04-01T00:00:00Z");
const PROTECTED_ID = "prot-1";
const LEGACY = "price_legacy129";
const ORGANIZER = "price_organizer";
const AI_PACK = "price_ai_pack";

const SHAPE: TransitionItemShape = { currency: "usd", interval: "month", intervalCount: 1, type: "recurring", billingScheme: "per_unit", usageType: "licensed", hasTransformQuantity: false };

const pro = (over: Partial<TransitionItem> = {}): TransitionItem => ({ priceId: LEGACY, quantity: 1, metadata: { k: "v" }, shape: SHAPE, ...over });
const organizer = (over: Partial<TransitionItem> = {}): TransitionItem => ({ priceId: ORGANIZER, quantity: 1, metadata: { addon: "organizer" }, shape: SHAPE, ...over });
const aiPack = (over: Partial<TransitionItem> = {}): TransitionItem => ({ priceId: AI_PACK, quantity: 3, shape: SHAPE, ...over });

const subscription = (items: TransitionItem[], over: Partial<TransitionSubscription> = {}): TransitionSubscription => ({
  id: "sub_ABC123",
  status: "active",
  currentPeriodStart: PERIOD_START,
  currentPeriodEnd: BOUNDARY,
  cancelAtPeriodEnd: false,
  scheduleId: null,
  items,
  ...over,
});

const notice: TransitionNotice = {
  id: "n1", protectedSubscriptionId: PROTECTED_ID, effectiveAt: BOUNDARY, newPriceId: "price_regular", newUnitAmountCents: 15900, currency: "usd",
  billingInterval: "month", approved: true, deliveryStatus: "delivered", sentAt: new Date("2027-03-01T00:00:00Z"),
};
const target: TransitionTargetPrice = {
  id: "price_regular", active: true, unitAmountCents: 15900, currency: "usd", interval: "month", intervalCount: 1, type: "recurring",
  billingScheme: "per_unit", usageType: "licensed", hasTransformQuantity: false,
};

const plan = (items: TransitionItem[], over: Partial<Parameters<typeof planPriceTransition>[0]> = {}) =>
  planPriceTransition({
    now: NOW, subscription: subscription(items), notice, target, approval: { approvedBy: "owner", boundaryAt: BOUNDARY },
    protectedSubscriptionId: PROTECTED_ID, protectedPriceId: LEGACY, ...over,
  });

const fakeItems = (...items: Array<[string, number, Record<string, string>?]>): FakeItem[] =>
  items.map(([price, quantity, metadata]) => ({ price, quantity, ...(metadata ? { metadata } : {}) }));
const THREE = fakeItems([LEGACY, 1, { k: "v" }], [ORGANIZER, 1, { addon: "organizer" }], [AI_PACK, 3]);

describe("planPriceTransition: multi-item", () => {
  it("plans phase 1 with every item unchanged and phase 2 with only the protected item moved", () => {
    const result = plan([pro(), organizer(), aiPack()]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.change.protectedPriceId).toBe(LEGACY);
    expect(result.change.proration).toBe("none");
    expect(result.change.phases[0]).toMatchObject({ startDate: u(PERIOD_START), endDate: u(BOUNDARY) });
    expect(result.change.phases[0].items).toEqual([
      { price: AI_PACK, quantity: 3 },
      { price: LEGACY, quantity: 1, metadata: { k: "v" } },
      { price: ORGANIZER, quantity: 1, metadata: { addon: "organizer" } },
    ]);
    expect(result.change.phases[1].items).toEqual([
      { price: AI_PACK, quantity: 3 },
      { price: "price_regular", quantity: 1, metadata: { k: "v" } },
      { price: ORGANIZER, quantity: 1, metadata: { addon: "organizer" } },
    ]);
  });

  it("keeps the protected item's quantity and does not depend on Stripe's item order", () => {
    const a = plan([pro({ quantity: 4 }), organizer(), aiPack()]);
    const b = plan([aiPack(), organizer(), pro({ quantity: 4 })]);
    expect(a).toEqual(b);
    if (a.ok) expect(a.change.phases[1].items.find((i) => i.price === "price_regular")?.quantity).toBe(4);
  });

  it("leaves the single-item plan exactly as before (no protectedPriceId field)", () => {
    const single = plan([pro()]);
    expect(single.ok && "protectedPriceId" in single.change).toBe(false);
  });

  it.each([
    ["no operator-supplied protected price", () => plan([pro(), organizer()], { protectedPriceId: undefined }), "subscription_unsupported_items"],
    ["zero items carry the protected price", () => plan([organizer(), aiPack()]), "protected_item_not_found"],
    ["two items carry the protected price", () => plan([pro(), pro({ quantity: 2 }), organizer()]), "protected_item_ambiguous"],
    ["an add-on that is itself a protected/legacy price", () => plan([pro(), organizer()], { otherProtectedPriceIds: [ORGANIZER] }), "item_is_protected_price"],
    ["an add-on billed yearly", () => plan([pro(), organizer({ shape: { ...SHAPE, interval: "year" } })]), "item_interval_or_currency_mismatch"],
    ["an add-on in another currency", () => plan([pro(), organizer({ shape: { ...SHAPE, currency: "eur" } })]), "item_interval_or_currency_mismatch"],
    ["a metered add-on", () => plan([pro(), organizer({ shape: { ...SHAPE, usageType: "metered" } })]), "item_shape_unsupported"],
    ["a tiered add-on", () => plan([pro(), organizer({ shape: { ...SHAPE, billingScheme: "tiered" } })]), "item_shape_unsupported"],
    ["a transform_quantity add-on", () => plan([pro(), organizer({ shape: { ...SHAPE, hasTransformQuantity: true } })]), "item_shape_unsupported"],
    ["an add-on billed every 3 months", () => plan([pro(), organizer({ shape: { ...SHAPE, intervalCount: 3 } })]), "item_shape_unsupported"],
    ["an add-on whose shape is unknown", () => plan([pro(), organizer({ shape: undefined })]), "item_shape_unsupported"],
    ["a one-time add-on price", () => plan([pro(), organizer({ shape: { ...SHAPE, type: "one_time" } })]), "item_shape_unsupported"],
    ["an add-on with a discount", () => plan([pro(), organizer({ unsupported: ["discounts"] })]), "item_unsupported_settings"],
    ["an add-on with tax rates", () => plan([pro(), organizer({ unsupported: ["tax_rates"] })]), "item_unsupported_settings"],
    ["an add-on with billing thresholds", () => plan([pro(), organizer({ unsupported: ["billing_thresholds"] })]), "item_unsupported_settings"],
    ["a protected item with a discount", () => plan([pro({ unsupported: ["discounts"] }), organizer()]), "item_unsupported_settings"],
    ["a zero-quantity add-on", () => plan([pro(), organizer({ quantity: 0 })]), "item_quantity_invalid"],
    ["a fractional quantity", () => plan([pro(), organizer({ quantity: 1.5 })]), "item_quantity_invalid"],
    ["the same add-on price twice", () => plan([pro(), organizer(), organizer({ quantity: 2 })]), "item_duplicate_price"],
    ["the target price already on the subscription", () => plan([pro(), organizer({ priceId: "price_regular" })]), "target_price_already_on_subscription"],
    ["more items than the cap", () => plan([pro(), ...Array.from({ length: MAX_SUBSCRIPTION_ITEMS }, (_, i) => organizer({ priceId: `price_addon_${i}` }))]), "subscription_items_over_cap"],
  ] as const)("refuses: %s", (_name, run, blocker) => {
    const result = run();
    expect(result.ok).toBe(false);
    expect(result.blockers).toContain(blocker);
  });

  it("accepts exactly the cap", () => {
    const items = [pro(), ...Array.from({ length: MAX_SUBSCRIPTION_ITEMS - 1 }, (_, i) => organizer({ priceId: `price_addon_${i}` }))];
    expect(plan(items).ok).toBe(true);
  });
});

describe("executePriceTransition: multi-item", () => {
  const scheduled = async (fakeOptions: Parameters<typeof statefulStripe>[0] = { items: THREE }) => {
    const fake = statefulStripe(fakeOptions);
    const result = await executePriceTransition(fake.stripe, plan([pro(), organizer(), aiPack()]), { keyMode: "test" });
    return { ...fake, result };
  };

  it("builds two phases that preserve every unrelated item and swap only the protected Price", async () => {
    const { result, calls, state, stripe } = await scheduled();
    expect(result).toEqual({ status: "scheduled", scheduleId: "sub_sched_1" });
    expect(calls).toEqual(["create", "update"]);
    const [first, second] = state().phases;
    expect(first.items.map((i) => [i.price, i.quantity]).sort()).toEqual([[AI_PACK, 3], [LEGACY, 1], [ORGANIZER, 1]]);
    expect(second.items.map((i) => [i.price, i.quantity]).sort()).toEqual([[AI_PACK, 3], [ORGANIZER, 1], ["price_regular", 1]]);
    const by = (items: FakeItem[], price: string) => items.find((i) => i.price === price)!;
    // unrelated items are identical (settings and metadata included) in both phases
    expect(by(second.items, ORGANIZER)).toEqual(by(first.items, ORGANIZER));
    expect(by(second.items, AI_PACK)).toEqual(by(first.items, AI_PACK));
    expect(by(second.items, ORGANIZER).metadata).toEqual({ addon: "organizer" });
    expect(by(second.items, "price_regular").metadata).toEqual({ k: "v" });
    // single-subscription proration: none everywhere
    const params = vi.mocked(stripe.subscriptionSchedules.update).mock.calls[0][1];
    expect(params.proration_behavior).toBe("none");
    expect(params.phases.every((p) => p.proration_behavior === "none")).toBe(true);
  });

  it("is insensitive to the order Stripe lists the items in", async () => {
    const { result } = await scheduled({ items: [...THREE].reverse() });
    expect(result.status).toBe("scheduled");
  });

  it("releases and fails when Stripe drops an add-on from the second phase", async () => {
    const { result, calls, state } = await scheduled({ items: THREE, dropFromSecondPhase: ORGANIZER });
    expect(result).toMatchObject({ status: "failed", released: true });
    expect((result as { reason: string }).reason).toMatch(/second phase/);
    expect(calls).toContain("release");
    expect(state().attached).toBeNull();
  });

  it("releases and fails when an add-on quantity is changed in the second phase", async () => {
    const { result, calls } = await scheduled({ items: THREE, changeQuantityInSecondPhase: { price: AI_PACK, quantity: 1 } });
    expect(result).toMatchObject({ status: "failed", released: true });
    expect(calls).toContain("release");
  });

  it("releases and fails when an add-on setting (tax rates, metadata) differs in the second phase although Price and quantity match", async () => {
    for (const patch of [{ tax_rates: ["txr_x"] }, { metadata: { addon: "changed" } }]) {
      const { result, calls } = await scheduled({ items: THREE, patchSecondPhaseItem: { price: ORGANIZER, patch } });
      expect(result).toMatchObject({ status: "failed", released: true });
      expect(calls).toContain("release");
    }
  });

  it("releases and fails when an item appears in the first phase after the update (add-on bought mid-operation)", async () => {
    const { result, calls } = await scheduled({ items: THREE, extraItemOnReadBack: { price: "price_late_addon", quantity: 1 } });
    expect(result).toMatchObject({ status: "failed", released: true });
    expect((result as { reason: string }).reason).toMatch(/first phase items changed/);
    expect(calls).toContain("release");
  });

  it("refuses before writing when the created schedule has an add-on the approved plan does not have", async () => {
    const { result, calls } = await scheduled({ items: [...THREE, ...fakeItems(["price_late_addon", 1])] });
    expect(result).toMatchObject({ status: "failed", released: true });
    expect((result as { reason: string }).reason).toMatch(/current phase items differ/);
    expect(calls).toEqual(["create", "release"]);
  });

  it("refuses before writing when an approved add-on is gone or its quantity changed", async () => {
    for (const items of [fakeItems([LEGACY, 1, { k: "v" }], [AI_PACK, 3]), fakeItems([LEGACY, 1, { k: "v" }], [ORGANIZER, 2, { addon: "organizer" }], [AI_PACK, 3])]) {
      const { result, calls } = await scheduled({ items });
      expect(result).toMatchObject({ status: "failed", released: true });
      expect(calls).toEqual(["create", "release"]);
    }
  });

  it("releases when Stripe rejects the construction (the new Price has a different interval than an add-on)", async () => {
    const { result, calls } = await scheduled({ items: THREE, priceTerms: { price_regular: { interval: "year", currency: "usd" } } });
    expect(result).toMatchObject({ status: "failed", released: true });
    expect((result as { reason: string }).reason).toMatch(/same interval and currency/);
    expect(calls).toEqual(["create", "update", "release"]);
  });

  it("the fake rejects what Stripe rejects: duplicate prices, a phase gap, empty items", async () => {
    const { stripe } = statefulStripe({ items: THREE });
    await stripe.subscriptionSchedules.create({ from_subscription: "sub_ABC123" });
    const phase = (over: Record<string, unknown>) => ({ start_date: u(PERIOD_START), end_date: u(BOUNDARY), items: [{ price: LEGACY, quantity: 1 }], proration_behavior: "none" as const, ...over });
    const run = (phases: ReturnType<typeof phase>[]) => stripe.subscriptionSchedules.update("sub_sched_1", { end_behavior: "release", proration_behavior: "none", phases });
    await expect(run([phase({ items: [{ price: LEGACY, quantity: 1 }, { price: LEGACY, quantity: 1 }] })])).rejects.toThrow(/duplicate price/);
    await expect(run([phase({}), phase({ start_date: u(BOUNDARY) + 5, end_date: undefined })])).rejects.toThrow(/start_date must equal/);
    await expect(run([phase({ items: [] })])).rejects.toThrow(/at least one item/);
    await expect(run([phase({ items: [{ price: LEGACY, quantity: 0 }] })])).rejects.toThrow(/invalid quantity/);
  });
});

describe("runPriceTransition: multi-item", () => {
  const registry: RegistryRow = { id: PROTECTED_ID, studioId: "st", stripeSubscriptionId: "sub_ABC123", stripeCustomerId: "cus_1", stripePriceId: null, releasedAt: null, protectionKind: "grandfathered_founder_legacy" };
  const base: RunnerArgs = { protectedSubscriptionId: PROTECTED_ID, noticeId: "n1", stripeSubscriptionId: "sub_ABC123", expectedCurrentPriceId: LEGACY, targetPriceId: "price_regular", boundaryAt: BOUNDARY };

  function makeDeps(items: TransitionItem[] | (() => TransitionItem[]), over: Partial<RunnerDeps> = {}, fakeOptions: Parameters<typeof statefulStripe>[0] = { items: THREE }) {
    const { stripe, calls, state } = statefulStripe(fakeOptions);
    const deps: RunnerDeps = {
      now: () => NOW, stripe, keyMode: "test", isAuthorizedApprover: (id) => id === "owner-1", resolvePlanForPrice: (p) => (p === "price_regular" ? "pro" : null),
      isProtectedPrice: async () => false,
      loadRegistry: async () => registry,
      loadNotice: async () => ({ ...notice, studioId: "st" }),
      hasOpenTransition: async () => false,
      readSubscription: async () => ({ ...subscription(typeof items === "function" ? items() : items), customerId: "cus_1", unsupportedSettings: [] }),
      readPrice: async () => target,
      insertAudit: vi.fn(async () => ({ id: "audit-1" })),
      recordSchedule: vi.fn(async () => undefined),
      finalizeAudit: vi.fn(async () => undefined),
      ...over,
    };
    return { deps, stripe, calls, state };
  }
  const dryHash = async (items: TransitionItem[]) => {
    const report = await runPriceTransition(base, makeDeps(items).deps);
    if (report.mode !== "dry_run" || !report.planHash) throw new Error(`dry run should pass: ${JSON.stringify(report.blockers)}`);
    return report;
  };
  const exec = (hash: string): RunnerArgs => ({ ...base, execute: true, approvedBy: "owner-1", approvedPlanHash: hash });

  it("dry-runs a Pro item plus add-ons and prints every item in the plan", async () => {
    const report = await dryHash([pro(), organizer(), aiPack()]);
    expect(report.plan?.ok && report.plan.change.phases.map((p) => p.items.length)).toEqual([3, 3]);
  });

  it("executes with the matching hash and preserves the add-ons", async () => {
    const { planHash } = await dryHash([pro(), organizer(), aiPack()]);
    const { deps, state } = makeDeps([pro(), organizer(), aiPack()]);
    const report = await runPriceTransition(exec(planHash!), deps);
    expect(report).toMatchObject({ mode: "execute", ok: true, status: "scheduled" });
    expect(state().phases[1].items.map((i) => i.price).sort()).toEqual([AI_PACK, ORGANIZER, "price_regular"]);
  });

  it("the plan hash covers every item: any add-on change makes the approval stale and nothing is written", async () => {
    const { planHash } = await dryHash([pro(), organizer(), aiPack()]);
    const variants: Array<[string, TransitionItem[]]> = [
      ["add-on quantity changed", [pro(), organizer(), aiPack({ quantity: 4 })]],
      ["add-on removed", [pro(), organizer()]],
      ["add-on swapped for another Price", [pro(), organizer(), aiPack({ priceId: "price_ai_pack_big" })]],
      ["add-on metadata changed", [pro(), organizer({ metadata: { addon: "other" } }), aiPack()]],
      ["add-on added", [pro(), organizer(), aiPack(), organizer({ priceId: "price_extra" })]],
    ];
    for (const [, items] of variants) {
      const { deps, stripe } = makeDeps(items);
      const report = await runPriceTransition(exec(planHash!), deps);
      expect(report.ok).toBe(false);
      expect(report.blockers).toContain("stale_or_mismatched_approval");
      expect(stripe.subscriptionSchedules.create).not.toHaveBeenCalled();
      expect(deps.insertAudit).not.toHaveBeenCalled();
    }
  });

  it("a different item set hashes differently from the single-item plan", async () => {
    const multi = await dryHash([pro(), organizer(), aiPack()]);
    const single = await runPriceTransition(base, makeDeps([pro()], {}, { items: fakeItems([LEGACY, 1, { k: "v" }]) }).deps);
    expect(single.mode === "dry_run" && single.planHash).not.toBe(multi.planHash);
  });

  it("stops before the Stripe write when an add-on appears between the approval re-read and the write", async () => {
    const { planHash } = await dryHash([pro(), organizer(), aiPack()]);
    let reads = 0;
    const { deps, stripe } = makeDeps(() => (++reads === 1 ? [pro(), organizer(), aiPack()] : [pro(), organizer(), aiPack(), organizer({ priceId: "price_late" })]));
    const report = await runPriceTransition(exec(planHash!), deps);
    expect(report.blockers).toContain("state_changed_before_write");
    expect(stripe.subscriptionSchedules.create).not.toHaveBeenCalled();
  });

  it.each([
    ["the expected price is on no item", [organizer(), aiPack()], {}, "current_price_unexpected"],
    ["the expected price is on two items", [pro(), pro({ quantity: 2 }), organizer()], {}, "current_price_unexpected"],
    ["an add-on is a protected/legacy price", [pro(), organizer(), aiPack()], { isProtectedPrice: async (p: string) => p === AI_PACK }, "item_is_protected_price"],
    ["protected-price knowledge is unavailable (fail closed)", [pro(), organizer()], { isProtectedPrice: undefined }, "protected_price_check_unavailable"],
  ] as const)("refuses: %s", async (_n, items, over, blocker) => {
    const { deps, stripe } = makeDeps([...items], over as Partial<RunnerDeps>);
    const report = await runPriceTransition({ ...base, execute: true, approvedBy: "owner-1", approvedPlanHash: "x" }, deps);
    expect(report.ok).toBe(false);
    expect(report.blockers).toContain(blocker);
    expect(stripe.subscriptionSchedules.create).not.toHaveBeenCalled();
  });
});

describe("mapStripeSubscription: multi-item", () => {
  const price = (id: string, over: Record<string, unknown> = {}) => ({
    id, currency: "usd", type: "recurring", billing_scheme: "per_unit", transform_quantity: null, recurring: { interval: "month", interval_count: 1, usage_type: "licensed" }, ...over,
  });
  const item = (id: string, quantity: number, over: Record<string, unknown> = {}, priceOver: Record<string, unknown> = {}) => ({
    price: price(id, priceOver), quantity, metadata: {}, billing_thresholds: null, discounts: [], tax_rates: [], current_period_start: u(PERIOD_START), current_period_end: u(BOUNDARY), ...over,
  });
  const sub = (items: unknown[]) => ({
    id: "sub_ABC123", customer: "cus_1", status: "active", cancel_at_period_end: false, schedule: null, collection_method: "charge_automatically",
    metadata: {}, discounts: [], automatic_tax: { enabled: false }, items: { data: items },
  });

  it("maps every item with its quantity, metadata and price shape, and reports no unsupported settings", () => {
    const mapped = mapStripeSubscription(sub([item(LEGACY, 1, { metadata: { k: "v" } }), item(ORGANIZER, 1), item(AI_PACK, 3)]));
    expect(mapped.unsupportedSettings).toEqual([]);
    expect(mapped.items.map((i) => [i.priceId, i.quantity])).toEqual([[LEGACY, 1], [ORGANIZER, 1], [AI_PACK, 3]]);
    expect(mapped.items[0].metadata).toEqual({ k: "v" });
    expect(mapped.items[1].shape).toEqual(SHAPE);
    expect(mapped.items.every((i) => (i.unsupported ?? []).length === 0)).toBe(true);
  });

  it("flags item-level settings that cannot be carried verbatim, and the planner then refuses", () => {
    const mapped = mapStripeSubscription(sub([item(LEGACY, 1), item(ORGANIZER, 1, { tax_rates: [{ id: "txr_1" }], discounts: ["di_1"], billing_thresholds: { usage_gte: 5 } })]));
    expect(mapped.items[1].unsupported).toEqual(["billing_thresholds", "discounts", "tax_rates"]);
    expect(plan(mapped.items).blockers).toContain("item_unsupported_settings");
  });

  it("maps metered, tiered, transform-quantity and yearly add-ons to shapes the planner refuses", () => {
    const metered = mapStripeSubscription(sub([item(LEGACY, 1), item(ORGANIZER, 1, {}, { recurring: { interval: "month", interval_count: 1, usage_type: "metered" } })]));
    expect(plan(metered.items).blockers).toContain("item_shape_unsupported");
    const tiered = mapStripeSubscription(sub([item(LEGACY, 1), item(ORGANIZER, 1, {}, { billing_scheme: "tiered" })]));
    expect(plan(tiered.items).blockers).toContain("item_shape_unsupported");
    const transform = mapStripeSubscription(sub([item(LEGACY, 1), item(ORGANIZER, 1, {}, { transform_quantity: { divide_by: 2, round: "up" } })]));
    expect(plan(transform.items).blockers).toContain("item_shape_unsupported");
    const yearly = mapStripeSubscription(sub([item(LEGACY, 1), item(ORGANIZER, 1, {}, { recurring: { interval: "year", interval_count: 1, usage_type: "licensed" } })]));
    expect(plan(yearly.items).blockers).toContain("item_interval_or_currency_mismatch");
  });

  it("blocks the subscription when its items report different periods", () => {
    const mapped = mapStripeSubscription(sub([item(LEGACY, 1), item(ORGANIZER, 1, { current_period_end: u(BOUNDARY) + 86_400 })]));
    expect(mapped.unsupportedSettings).toContain("item_periods_differ");
  });

  it("an end-to-end multi-item subscription from Stripe-shaped objects plans successfully", () => {
    const mapped = mapStripeSubscription(sub([item(ORGANIZER, 1, { metadata: { addon: "organizer" } }), item(LEGACY, 1, { metadata: { k: "v" } })]));
    expect(plan(mapped.items, { subscription: { ...mapped, items: mapped.items } }).ok).toBe(true);
  });
});

describe("evaluateReconciliation: multi-item", () => {
  const AFTER = new Date(BOUNDARY.getTime() + 2 * 3_600_000);
  const NEXT_END = new Date("2027-08-09T04:00:00Z");
  const approvedItems = {
    protectedPriceId: LEGACY,
    before: [{ priceId: AI_PACK, quantity: 3 }, { priceId: LEGACY, quantity: 1 }, { priceId: ORGANIZER, quantity: 1 }],
    after: [{ priceId: AI_PACK, quantity: 3 }, { priceId: "price_regular", quantity: 1 }, { priceId: ORGANIZER, quantity: 1 }],
  };
  const PRICE = { id: "price_regular", unitAmountCents: 15900, currency: "usd", active: true, type: "recurring", interval: "month", intervalCount: 1 };
  const inputs = (items: Array<{ priceId: string; quantity: number }>, over: Partial<ReconcileInputs> = {}): ReconcileInputs => ({
    now: AFTER,
    transition: {
      id: "t1", status: "scheduled", protectedSubscriptionId: PROTECTED_ID, stripeSubscriptionId: "sub_ABC123", stripeScheduleId: "sub_sched_1", targetPriceId: "price_regular",
      boundaryAt: PROTECTED_PRICE_BOUNDARY, activatedAt: null, priceChangedAt: null, noticeAmountCents: 15900, noticeCurrency: "usd", noticeInterval: "month", plannedQuantity: 1, approvedItems,
    },
    registry: { id: PROTECTED_ID, studioId: "st", stripeCustomerId: "cus_1", stripeSubscriptionId: "sub_ABC123", releasedAt: null, protectionKind: "grandfathered_founder_legacy" },
    studioCustomerId: "cus_1",
    subscription: { id: "sub_ABC123", customerId: "cus_1", status: "active", currentPeriodStart: PROTECTED_PRICE_BOUNDARY, currentPeriodEnd: NEXT_END, scheduleId: "sub_sched_1", items },
    schedule: { id: "sub_sched_1", status: "active", subscriptionId: "sub_ABC123", currentPhaseStart: PROTECTED_PRICE_BOUNDARY },
    price: PRICE,
    ...over,
  });
  const reasons = (o: ReconcileOutcome) => (o.state === "needs_review" ? o.reasons : []);
  const AFTER_SET = approvedItems.after;

  it("is ready when the target item has the planned quantity and every other item is exactly as approved", () => {
    const outcome = evaluateReconciliation(inputs([...AFTER_SET].reverse()));
    expect(outcome.state).toBe("ready");
    if (outcome.state === "ready") expect(outcome.evidence).toMatchObject({ price_changed: true, phase_entered: true, items_match_plan: true, observed_item_count: 3 });
  });

  it.each([
    ["an approved add-on is missing", AFTER_SET.filter((i) => i.priceId !== ORGANIZER), "approved_item_missing"],
    ["an unapproved add-on is present", [...AFTER_SET, { priceId: "price_late", quantity: 1 }], "unexpected_item_present"],
    ["an add-on quantity changed", AFTER_SET.map((i) => (i.priceId === AI_PACK ? { ...i, quantity: 5 } : i)), "approved_item_quantity_changed"],
    ["the target quantity changed", AFTER_SET.map((i) => (i.priceId === "price_regular" ? { ...i, quantity: 2 } : i)), "quantity_changed"],
    ["the old protected Price is still billed beside the target", [...AFTER_SET, { priceId: LEGACY, quantity: 1 }], "unexpected_item_present"],
    ["the target Price is on two items", [...AFTER_SET, { priceId: "price_regular", quantity: 1 }], "unexpected_item_present"],
    ["the target item is gone", AFTER_SET.filter((i) => i.priceId !== "price_regular"), "approved_item_missing"],
  ] as const)("fails closed when %s", (_n, items, reason) => {
    const outcome = evaluateReconciliation(inputs([...items]));
    expect(outcome.state).toBe("needs_review");
    expect(reasons(outcome)).toContain(reason);
  });

  it("waits inside the grace window while the live set is still the approved first phase, and escalates a changed one", () => {
    const old = { currentPeriodStart: new Date("2027-06-09T04:00:00Z"), currentPeriodEnd: PROTECTED_PRICE_BOUNDARY };
    const wait = inputs(approvedItems.before, { subscription: { ...inputs([]).subscription!, ...old, items: approvedItems.before }, schedule: { id: "sub_sched_1", status: "not_started", subscriptionId: "sub_ABC123", currentPhaseStart: old.currentPeriodStart } });
    expect(evaluateReconciliation(wait).state).toBe("awaiting_stripe");
    const changed = inputs([], { subscription: { ...wait.subscription!, items: [...approvedItems.before, { priceId: "price_late", quantity: 1 }] }, schedule: wait.schedule });
    expect(reasons(evaluateReconciliation(changed))).toContain("unexpected_item_present");
  });

  it("flags an item set changed after scheduling BEFORE the boundary, and stays quiet when nothing changed", () => {
    const early = new Date(PROTECTED_PRICE_BOUNDARY.getTime() - 5 * 86_400_000);
    const old = { currentPeriodStart: new Date("2027-06-09T04:00:00Z"), currentPeriodEnd: PROTECTED_PRICE_BOUNDARY };
    const quiet = inputs([], { now: early, subscription: { ...inputs([]).subscription!, ...old, items: approvedItems.before } });
    expect(evaluateReconciliation(quiet).state).toBe("not_due");
    const late = inputs([], { now: early, subscription: { ...quiet.subscription!, items: [...approvedItems.before, { priceId: "price_late", quantity: 1 }] } });
    const outcome = evaluateReconciliation(late);
    expect(outcome.state).toBe("needs_review");
    expect(reasons(outcome)).toEqual(expect.arrayContaining(["items_changed_after_scheduling", "unexpected_item_present"]));
    const removed = inputs([], { now: early, subscription: { ...quiet.subscription!, items: approvedItems.before.filter((i) => i.priceId !== AI_PACK) } });
    expect(reasons(evaluateReconciliation(removed))).toContain("approved_item_missing");
  });

  it("does not apply item rules to a single-item transition (unchanged behaviour)", () => {
    const base = inputs([]);
    const single = { ...base, transition: { ...base.transition, approvedItems: undefined }, now: new Date(PROTECTED_PRICE_BOUNDARY.getTime() - 1000) };
    expect(evaluateReconciliation({ ...single, subscription: { ...base.subscription!, items: [...approvedItems.before, { priceId: "price_late", quantity: 1 }] } }).state).toBe("not_due");
  });

  it("flags review (without completing) when applied before the boundary", async () => {
    const early = new Date(PROTECTED_PRICE_BOUNDARY.getTime() - 86_400_000);
    const i = inputs([], { now: early, subscription: { ...inputs([]).subscription!, currentPeriodStart: new Date("2027-06-09T04:00:00Z"), currentPeriodEnd: PROTECTED_PRICE_BOUNDARY, items: [...approvedItems.before, { priceId: "price_late", quantity: 1 }] } });
    const deps: ReconcileDeps = {
      now: () => early, loadTransition: async () => i.transition, loadRegistry: async () => i.registry, loadStudioCustomerId: async () => "cus_1", readSubscription: async () => i.subscription,
      readSchedule: async () => i.schedule, readPrice: async () => i.price, recordMilestones: vi.fn(async () => undefined), flagReview: vi.fn(async () => undefined), complete: vi.fn(async () => "reconciled" as const),
    };
    const report = await reconcilePriceTransition("t1", deps, { apply: true });
    expect(report.state).toBe("needs_review");
    expect(deps.flagReview).toHaveBeenCalledOnce();
    expect(deps.complete).not.toHaveBeenCalled();
  });
});

describe("approvedFromDryRun", () => {
  it("reads the target item's quantity and the approved sets from the stored multi-item plan", () => {
    const p = plan([pro({ quantity: 2 }), organizer(), aiPack()]);
    const parsed = approvedFromDryRun({ change: p.ok ? p.change : null }, "price_regular");
    expect(parsed.plannedQuantity).toBe(2);
    expect(parsed.approvedItems?.protectedPriceId).toBe(LEGACY);
    expect(parsed.approvedItems?.after).toContainEqual({ priceId: "price_regular", quantity: 2 });
    expect(parsed.approvedItems?.before).toContainEqual({ priceId: LEGACY, quantity: 2 });
  });

  it("returns no approved item sets for a single-item plan", () => {
    const p = plan([pro({ quantity: 2 })]);
    expect(approvedFromDryRun({ change: p.ok ? p.change : null }, "price_regular")).toEqual({ plannedQuantity: 2 });
    expect(approvedFromDryRun(null, "price_regular")).toEqual({ plannedQuantity: 1 });
  });
});
