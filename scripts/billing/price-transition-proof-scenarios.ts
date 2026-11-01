/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * D7 WP-3 TEST-mode proof scenarios. Real Stripe TEST sandbox calls through the allowlisted `op()` wrapper; the database is an
 * in-memory stand-in (the SQL side is proven separately on disposable Postgres). Every object is disposable and every test
 * clock is deleted at the end. Called only from price-transition-proof.ts after the preflight gates pass.
 */
import type Stripe from "stripe";
import { executePriceTransition, planPriceTransition, type ScheduleStripe } from "@/lib/billing/priceTransition";
import { runPriceTransition, type RunnerArgs, type RunnerDeps, type RegistryRow } from "@/lib/billing/priceTransitionRunner";
import { PROTECTED_PRICE_BOUNDARY, reconcilePriceTransition, type ReconcileDeps, type ReconcileTransition } from "@/lib/billing/priceTransitionReconcile";
import type { TransitionNotice } from "@/lib/billing/priceTransition";
import { op } from "./price-transition-proof-lib";

export type CaseResult = { id: string; title: string; pass: boolean; detail: string };

const FROZEN = Math.floor(new Date("2027-06-09T04:00:00Z").getTime() / 1000);
const DAY = 86_400_000;

type Ctx = {
  stripe: Stripe;
  results: CaseResult[];
  clocks: string[];
  writes: { create: number; update: number; release: number };
  legacy: string;
  regular: string;
  regularAmount: number;
  nowRef: { value: Date };
  hooks: { loseCreateResponse?: boolean; failUpdate?: boolean; failRelease?: boolean; corruptReadBack?: boolean };
};

const record = (ctx: Ctx, id: string, title: string, pass: boolean, detail: string) => {
  ctx.results.push({ id, title, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} ${id} ${title}: ${detail}`);
};

/** The schedule API exactly as the executor sees it: every call goes through op() and honours the failure hooks. */
function scheduleApi(ctx: Ctx): ScheduleStripe {
  const s = ctx.stripe;
  return {
    subscriptionSchedules: {
      async create(params, options) {
        ctx.writes.create += 1;
        const created = await op("subscriptionSchedules.create", { params, options }, () => s.subscriptionSchedules.create(params, options as any));
        if (ctx.hooks.loseCreateResponse) throw new Error("simulated lost response (connection reset after Stripe processed the create)");
        return { id: created.id };
      },
      async update(id, params, options) {
        ctx.writes.update += 1;
        if (ctx.hooks.failUpdate) throw new Error("simulated update failure before reaching Stripe");
        return op("subscriptionSchedules.update", { id, params, options }, () => s.subscriptionSchedules.update(id, params as any, options as any));
      },
      async retrieve(id) {
        const schedule: any = await op("subscriptionSchedules.retrieve", { id }, () => s.subscriptionSchedules.retrieve(id));
        if (ctx.hooks.corruptReadBack && schedule.phases.length === 2) schedule.phases[1].items[0].price = "price_corrupted_for_proof";
        return schedule;
      },
      async release(id) {
        ctx.writes.release += 1;
        if (ctx.hooks.failRelease) throw new Error("simulated release failure");
        return op("subscriptionSchedules.release", { id }, () => s.subscriptionSchedules.release(id));
      },
    },
    subscriptions: {
      retrieve: (id) => op("subscriptions.retrieve", { id }, () => s.subscriptions.retrieve(id)) as any,
    },
  };
}

async function readSubscription(ctx: Ctx, id: string): Promise<any | null> {
  const sub: any = await op("subscriptions.retrieve", { id }, () => ctx.stripe.subscriptions.retrieve(id));
  const item = sub.items.data[0];
  const periodStart = sub.current_period_start ?? item?.current_period_start;
  const periodEnd = sub.current_period_end ?? item?.current_period_end;
  const unsupportedSettings: string[] = [];
  if (sub.trial_end) unsupportedSettings.push("trial");
  if (sub.pause_collection) unsupportedSettings.push("pause_collection");
  if (sub.pending_update) unsupportedSettings.push("pending_update");
  if (sub.cancel_at) unsupportedSettings.push("cancel_at");
  if (sub.collection_method !== "charge_automatically") unsupportedSettings.push("collection_method");
  if (Array.isArray(sub.discounts) && sub.discounts.length > 0) unsupportedSettings.push("discounts");
  return {
    id: sub.id,
    customerId: typeof sub.customer === "string" ? sub.customer : sub.customer.id,
    status: sub.status,
    currentPeriodStart: new Date(periodStart * 1000),
    currentPeriodEnd: new Date(periodEnd * 1000),
    cancelAtPeriodEnd: sub.cancel_at_period_end,
    scheduleId: typeof sub.schedule === "string" ? sub.schedule : sub.schedule?.id ?? null,
    items: sub.items.data.map((i: any) => ({ priceId: i.price.id, quantity: i.quantity ?? 1, metadata: { ...(i.metadata ?? {}) } })),
    metadata: { ...(sub.metadata ?? {}) },
    unsupportedSettings,
  };
}

async function readPrice(ctx: Ctx, id: string) {
  const price: any = await op("prices.retrieve", { id }, () => ctx.stripe.prices.retrieve(id));
  return {
    id: price.id, active: price.active, unitAmountCents: price.unit_amount, currency: price.currency,
    interval: price.recurring?.interval ?? null, intervalCount: price.recurring?.interval_count ?? null, type: price.type,
    billingScheme: price.billing_scheme, usageType: price.recurring?.usage_type ?? null, hasTransformQuantity: price.transform_quantity != null,
  };
}

type Mem = {
  registry: RegistryRow;
  notice: TransitionNotice;
  audits: Array<{ id: string; status: string; scheduleId: string | null; row: any; milestones: { activatedAt?: Date; priceChangedAt?: Date }; reviewReasons?: string[]; reconciled?: boolean }>;
  finalizeFailures: number;
};

function memRunnerDeps(ctx: Ctx, mem: Mem, owners: string[] = ["owner-1"]): RunnerDeps {
  return {
    now: () => ctx.nowRef.value,
    stripe: scheduleApi(ctx),
    keyMode: "test",
    isAuthorizedApprover: (id) => owners.includes(id),
    resolvePlanForPrice: () => "pro",
    loadRegistry: async () => mem.registry,
    loadNotice: async () => mem.notice,
    hasOpenTransition: async () => mem.audits.some((a) => ["approved", "scheduled", "needs_review"].includes(a.status)),
    readSubscription: (id) => readSubscription(ctx, id),
    readPrice: (id) => readPrice(ctx, id),
    insertAudit: async (row) => {
      if (mem.audits.some((a) => ["approved", "scheduled", "needs_review"].includes(a.status))) throw new Error("duplicate key (one open transition)");
      const audit = { id: `audit-${mem.registry.id}-${mem.audits.length + 1}-${Math.random().toString(36).slice(2, 8)}`, status: "approved", scheduleId: null as string | null, row, milestones: {} };
      mem.audits.push(audit);
      return { id: audit.id };
    },
    recordSchedule: async (id, scheduleId) => {
      mem.audits.find((a) => a.id === id)!.scheduleId = scheduleId;
    },
    finalizeAudit: async (id, patch) => {
      if (mem.finalizeFailures > 0) {
        mem.finalizeFailures -= 1;
        throw new Error("simulated audit database outage");
      }
      const audit = mem.audits.find((a) => a.id === id)!;
      audit.status = patch.status;
      audit.scheduleId = patch.scheduleId;
    },
  };
}

function memReconcileDeps(ctx: Ctx, mem: Mem): ReconcileDeps {
  const transition = (): ReconcileTransition | null => {
    const a = mem.audits[mem.audits.length - 1];
    if (!a) return null;
    return {
      id: a.id, status: a.status, protectedSubscriptionId: mem.registry.id, stripeSubscriptionId: a.row.stripeSubscriptionId, stripeScheduleId: a.scheduleId,
      targetPriceId: a.row.targetStripePriceId, boundaryAt: new Date(a.row.boundaryAt), activatedAt: a.milestones.activatedAt ?? null, priceChangedAt: a.milestones.priceChangedAt ?? null,
      noticeAmountCents: mem.notice.newUnitAmountCents, noticeCurrency: mem.notice.currency, noticeInterval: mem.notice.billingInterval, plannedQuantity: 1,
    };
  };
  return {
    now: () => ctx.nowRef.value,
    loadTransition: async () => transition(),
    loadRegistry: async () => ({ id: mem.registry.id, studioId: mem.registry.studioId, stripeCustomerId: mem.registry.stripeCustomerId, stripeSubscriptionId: mem.registry.stripeSubscriptionId, releasedAt: mem.registry.releasedAt, protectionKind: mem.registry.protectionKind }),
    loadStudioCustomerId: async () => mem.registry.stripeCustomerId,
    readSubscription: async (id) => {
      const s = await readSubscription(ctx, id);
      return s && { id: s.id, customerId: s.customerId, status: s.status, currentPeriodStart: s.currentPeriodStart, currentPeriodEnd: s.currentPeriodEnd, scheduleId: s.scheduleId, items: s.items };
    },
    readSchedule: async (id) => {
      const sch: any = await op("subscriptionSchedules.retrieve", { id }, () => ctx.stripe.subscriptionSchedules.retrieve(id));
      return { id: sch.id, status: sch.status, subscriptionId: typeof sch.subscription === "string" ? sch.subscription : sch.subscription?.id ?? null, currentPhaseStart: sch.current_phase ? new Date(sch.current_phase.start_date * 1000) : null };
    },
    readPrice: async (id) => {
      const p = await readPrice(ctx, id);
      return { id: p.id, unitAmountCents: p.unitAmountCents, currency: p.currency, active: p.active, type: p.type, interval: p.interval, intervalCount: p.intervalCount };
    },
    recordMilestones: async (_id, patch) => {
      const a = mem.audits[mem.audits.length - 1];
      a.milestones = { ...a.milestones, ...patch };
    },
    flagReview: async (_id, reasons) => {
      const a = mem.audits[mem.audits.length - 1];
      a.status = "needs_review";
      a.reviewReasons = reasons;
    },
    complete: async () => {
      const a = mem.audits[mem.audits.length - 1];
      if (a.reconciled) return "already_reconciled";
      a.status = "reconciled";
      a.reconciled = true;
      mem.registry.releasedAt = ctx.nowRef.value.toISOString();
      return "reconciled";
    },
  };
}

type Fixture = { clockId: string; customerId: string; subscriptionId: string; mem: Mem; args: RunnerArgs };

/** A disposable customer on its own test clock, with a card, a subscription on the legacy price and matching in-memory records. */
async function fixture(ctx: Ctx, label: string, options: { metadata?: Record<string, string>; itemMetadata?: Record<string, string>; coupon?: string; extraItem?: string; kind?: RegistryRow["protectionKind"] } = {}): Promise<Fixture> {
  ctx.nowRef.value = new Date(FROZEN * 1000);
  const clock: any = await op("testHelpers.testClocks.create", { frozen_time: FROZEN, name: `d7wp3-${label}` }, () => ctx.stripe.testHelpers.testClocks.create({ frozen_time: FROZEN, name: `d7wp3-${label}` }));
  ctx.clocks.push(clock.id);
  const customer: any = await op("customers.create", { test_clock: clock.id, name: `d7wp3 ${label}`, metadata: { d7wp3: label } }, () => ctx.stripe.customers.create({ test_clock: clock.id, name: `d7wp3 ${label}`, metadata: { d7wp3: label } }));
  const pm: any = await op("paymentMethods.attach", { id: "pm_card_visa", customer: customer.id }, () => ctx.stripe.paymentMethods.attach("pm_card_visa", { customer: customer.id }));
  await op("customers.update", { id: customer.id, invoice_settings: { default_payment_method: pm.id } }, () => ctx.stripe.customers.update(customer.id, { invoice_settings: { default_payment_method: pm.id } }));
  const items: any[] = [{ price: ctx.legacy, quantity: 1, ...(options.itemMetadata ? { metadata: options.itemMetadata } : {}) }];
  if (options.extraItem) items.push({ price: options.extraItem, quantity: 1 });
  const request: any = { customer: customer.id, items, ...(options.metadata ? { metadata: options.metadata } : {}), ...(options.coupon ? { discounts: [{ coupon: options.coupon }] } : {}) };
  const sub: any = await op("subscriptions.create", request, () => ctx.stripe.subscriptions.create(request));
  const live = await readSubscription(ctx, sub.id);
  const boundary: Date = live.currentPeriodEnd;
  const registry: RegistryRow = { id: `prot-${label}`, studioId: `studio-${label}`, stripeSubscriptionId: sub.id, stripeCustomerId: customer.id, stripePriceId: null, releasedAt: null, protectionKind: options.kind ?? "contractual_exception" };
  const notice: TransitionNotice = {
    id: `notice-${label}`, protectedSubscriptionId: registry.id, studioId: registry.studioId, effectiveAt: boundary, newPriceId: ctx.regular, newUnitAmountCents: ctx.regularAmount,
    currency: "usd", billingInterval: "month", approved: true, deliveryStatus: "delivered", sentAt: new Date(boundary.getTime() - 70 * DAY),
  };
  const mem: Mem = { registry, notice, audits: [], finalizeFailures: 0 };
  const args: RunnerArgs = {
    protectedSubscriptionId: registry.id, noticeId: notice.id, stripeSubscriptionId: sub.id, expectedCurrentPriceId: ctx.legacy, targetPriceId: ctx.regular, boundaryAt: boundary,
  };
  return { clockId: clock.id, customerId: customer.id, subscriptionId: sub.id, mem, args };
}

const executeArgs = (a: RunnerArgs, hash: string): RunnerArgs => ({ ...a, execute: true, approvedBy: "owner-1", approvedPlanHash: hash });

async function dryHash(ctx: Ctx, f: Fixture): Promise<string> {
  const dry = await runPriceTransition(f.args, memRunnerDeps(ctx, f.mem));
  if (dry.mode !== "dry_run" || !dry.planHash) throw new Error(`dry run was not clean: ${JSON.stringify((dry as any).blockers)}`);
  return dry.planHash;
}

async function currentSchedule(ctx: Ctx, subscriptionId: string): Promise<string | null> {
  return (await readSubscription(ctx, subscriptionId)).scheduleId;
}

async function cleanup(ctx: Ctx, subscriptionId: string) {
  const id = await currentSchedule(ctx, subscriptionId);
  if (id) await op("subscriptionSchedules.release", { id, cleanup: true }, () => ctx.stripe.subscriptionSchedules.release(id));
}

export async function runScenarios(stripe: Stripe): Promise<{ results: CaseResult[]; summary: Record<string, unknown> }> {
  const ctx: Ctx = {
    stripe, results: [], clocks: [], writes: { create: 0, update: 0, release: 0 }, legacy: "", regular: "", regularAmount: 15900,
    nowRef: { value: new Date(FROZEN * 1000) }, hooks: {},
  };
  const summary: Record<string, unknown> = {};
  try {
    // ---- shared catalog objects (disposable) ----
    const product: any = await op("products.create", { name: "d7wp3 proof Pro" }, () => stripe.products.create({ name: "d7wp3 proof Pro" }));
    const legacy: any = await op("prices.create", { legacy: true }, () => stripe.prices.create({ product: product.id, unit_amount: 12900, currency: "usd", recurring: { interval: "month" }, nickname: "d7wp3 legacy 129" }));
    const regular: any = await op("prices.create", { regular: true }, () => stripe.prices.create({ product: product.id, unit_amount: ctx.regularAmount, currency: "usd", recurring: { interval: "month" }, nickname: "d7wp3 regular 159" }));
    const other: any = await op("prices.create", { other: true }, () => stripe.prices.create({ product: product.id, unit_amount: 500, currency: "usd", recurring: { interval: "month" }, nickname: "d7wp3 addon 5" }));
    ctx.legacy = legacy.id;
    ctx.regular = regular.id;
    summary.catalog = { product: product.id, legacy: legacy.id, regular: regular.id };

    // ---- T1: dry run writes nothing ----
    {
      const f = await fixture(ctx, "t1");
      const before = { ...ctx.writes };
      const report = await runPriceTransition(f.args, memRunnerDeps(ctx, f.mem));
      const sched = await currentSchedule(ctx, f.subscriptionId);
      record(ctx, "T1", "dry run is the default and writes nothing", report.mode === "dry_run" && report.ok && JSON.stringify(before) === JSON.stringify(ctx.writes) && sched === null && f.mem.audits.length === 0, `ok=${report.ok} schedule=${sched} audits=${f.mem.audits.length} writes unchanged=${JSON.stringify(before) === JSON.stringify(ctx.writes)}`);
    }

    // ---- T2/T3/T4/T10/T12: full flow on the policy boundary, with settings that must survive ----
    {
      const f = await fixture(ctx, "main", { metadata: { studio: "d7wp3-main" }, itemMetadata: { seat: "owner" }, kind: "grandfathered_founder_legacy" });
      summary.mainBoundary = f.args.boundaryAt.toISOString();
      const policyOk = f.args.boundaryAt.getTime() === PROTECTED_PRICE_BOUNDARY.getTime();
      record(ctx, "T0", "test clock lands the first period end on the exact policy boundary 2027-07-09T04:00:00Z", policyOk, f.args.boundaryAt.toISOString());
      const invoicesBefore: any = await op("invoices.list", { customer: f.customerId }, () => stripe.invoices.list({ customer: f.customerId, limit: 20 }));
      const hash = await dryHash(ctx, f);
      const beforeSub: any = await op("subscriptions.retrieve", { id: f.subscriptionId }, () => stripe.subscriptions.retrieve(f.subscriptionId));
      const report = await runPriceTransition(executeArgs(f.args, hash), memRunnerDeps(ctx, f.mem));
      const scheduleId = (report as any).scheduleId as string | null;
      const schedule: any = scheduleId ? await op("subscriptionSchedules.retrieve", { id: scheduleId }, () => stripe.subscriptionSchedules.retrieve(scheduleId)) : null;
      const ph = schedule?.phases ?? [];
      const audit = f.mem.audits[0];
      record(ctx, "T2", "execute with the correct hash creates a verified two-phase schedule and finalizes the audit row", report.ok && report.mode === "execute" && report.status === "scheduled" && ph.length === 2 && audit?.status === "scheduled" && Boolean(audit?.scheduleId), `status=${(report as any).status} reason=${(report as any).reason ?? ""} blockers=${report.blockers.join(",")} phases=${ph.length} audit=${audit?.status} schedule=${scheduleId}`);
      record(ctx, "T2b", "phase 1 ends at the boundary on the legacy price; phase 2 starts there on the regular price, no proration", ph.length === 2 && ph[0].end_date === f.args.boundaryAt.getTime() / 1000 && ph[0].items[0].price === ctx.legacy && ph[1].start_date === ph[0].end_date && ph[1].items[0].price === ctx.regular && ph.every((p: any) => p.proration_behavior === "none"), JSON.stringify(ph.map((p: any) => ({ start: p.start_date, end: p.end_date, price: p.items?.[0]?.price, proration: p.proration_behavior }))));
      record(ctx, "T10", "subscription and item metadata survive into both phases", ph.length === 2 && ph.every((p: any) => p.metadata?.studio === "d7wp3-main" && p.items[0].metadata?.seat === "owner"), JSON.stringify(ph.map((p: any) => ({ metadata: p.metadata, item: p.items?.[0]?.metadata }))));
      record(ctx, "T12", "Stripe accepted a final phase sent with no end date; it gives that phase one implicit billing cycle and end_behavior release", ph.length === 2 && schedule?.end_behavior === "release" && typeof ph[1].end_date === "number" && ph[1].end_date > ph[0].end_date, `sent no end_date; Stripe stored phase2 end_date=${ph[1]?.end_date} (boundary+${((ph[1]?.end_date - ph[0].end_date) / 86400).toFixed(0)}d) end_behavior=${schedule?.end_behavior}`);
      const invoicesMid: any = await op("invoices.list", { customer: f.customerId }, () => stripe.invoices.list({ customer: f.customerId, limit: 20 }));
      const midSub = await readSubscription(ctx, f.subscriptionId);
      record(ctx, "T3", "scheduling created no invoice or charge and left the subscription on the legacy price", invoicesMid.data.length === invoicesBefore.data.length && midSub.items[0].priceId === ctx.legacy && beforeSub.status === "active", `invoices ${invoicesBefore.data.length}->${invoicesMid.data.length} price=${midSub.items[0].priceId}`);

      // T6 replay while the transition is open
      const replay = await runPriceTransition(executeArgs(f.args, hash), memRunnerDeps(ctx, f.mem));
      record(ctx, "T6", "a replayed execute is refused and exactly one schedule exists", !replay.ok && replay.blockers.length > 0 && (await currentSchedule(ctx, f.subscriptionId)) === scheduleId, `blockers=${replay.blockers.join(",")}`);

      // reconcile before the boundary: not due
      const early = await reconcilePriceTransition(audit.id, memReconcileDeps(ctx, f.mem), { apply: true });
      record(ctx, "R1", "reconciliation before the boundary is not_due and changes nothing", early.state === "not_due" && !early.changed && !f.mem.registry.releasedAt, early.state);

      // advance past the boundary
      const target = Math.floor(f.args.boundaryAt.getTime() / 1000) + 2 * 3600;
      await op("testHelpers.testClocks.advance", { id: f.clockId, frozen_time: target }, () => stripe.testHelpers.testClocks.advance(f.clockId, { frozen_time: target }));
      ctx.nowRef.value = new Date(target * 1000);
      let rolled = false;
      for (let i = 0; i < 40 && !rolled; i += 1) {
        await new Promise((r) => setTimeout(r, 3000));
        const s = await readSubscription(ctx, f.subscriptionId);
        rolled = s.currentPeriodStart.getTime() === f.args.boundaryAt.getTime();
      }
      summary.mainRolled = rolled;
      const after: any = await op("subscriptions.retrieve", { id: f.subscriptionId }, () => stripe.subscriptions.retrieve(f.subscriptionId));
      const afterItem = after.items.data[0];
      const invoicesAfter: any = await op("invoices.list", { customer: f.customerId }, () => stripe.invoices.list({ customer: f.customerId, limit: 20 }));
      const renewal = invoicesAfter.data.find((inv: any) => inv.billing_reason === "subscription_cycle");
      const lines: any[] = renewal?.lines?.data ?? [];
      record(ctx, "T4a", "after the boundary the subscription is on the regular price, in a period starting exactly at the boundary", rolled && afterItem.price.id === ctx.regular && afterItem.quantity === 1, `rolled=${rolled} price=${afterItem?.price?.id}`);
      record(ctx, "T4b", "the renewal invoice charges only the regular price, once, with no proration lines", Boolean(renewal) && renewal.amount_due === ctx.regularAmount && lines.length === 1 && lines.every((l: any) => !l.proration && l.amount === ctx.regularAmount) && invoicesAfter.data.filter((i: any) => i.billing_reason === "subscription_cycle").length === 1, `renewal=${renewal?.id} amount_due=${renewal?.amount_due} lines=${lines.length} cycleInvoices=${invoicesAfter.data.filter((i: any) => i.billing_reason === "subscription_cycle").length}`);
      record(ctx, "T10b", "metadata survives on the live subscription after the price change", after.metadata?.studio === "d7wp3-main" && afterItem.metadata?.seat === "owner", JSON.stringify({ sub: after.metadata, item: afterItem.metadata }));

      // post-boundary reconciliation against real Stripe state
      const dryRec = await reconcilePriceTransition(audit.id, memReconcileDeps(ctx, f.mem));
      const rec = await reconcilePriceTransition(audit.id, memReconcileDeps(ctx, f.mem), { apply: true });
      const again = await reconcilePriceTransition(audit.id, memReconcileDeps(ctx, f.mem), { apply: true });
      summary.reconcileEvidence = rec.evidence;
      record(ctx, "R2", "reconciliation (dry run, apply, replay) distinguishes activation, price change and registry release, and is replay safe", dryRec.state === "ready" && rec.state === "completed" && again.state === "already_reconciled" && Boolean(f.mem.registry.releasedAt) && Boolean(audit.milestones.activatedAt) && Boolean(audit.milestones.priceChangedAt), `dry=${dryRec.state} apply=${rec.state} replay=${again.state} milestones=${JSON.stringify(rec.milestones)} reasons=${rec.reasons.join(",")}`);

      // inconsistent state: notice amount differs from the real price -> needs_review, evidence preserved
      const f2 = f.mem;
      f2.registry.releasedAt = null;
      audit.status = "scheduled";
      audit.reconciled = false;
      const wrongNotice = { ...f2.notice, newUnitAmountCents: 24900 };
      const memBad: Mem = { ...f2, notice: wrongNotice };
      const bad = await reconcilePriceTransition(audit.id, memReconcileDeps(ctx, memBad), { apply: true });
      record(ctx, "R3", "an approved-price mismatch fails closed to needs_review and the registry stays protected", bad.state === "needs_review" && bad.reasons.includes("target_price_amount_differs_from_notice") && !f2.registry.releasedAt && audit.status === "needs_review", `state=${bad.state} reasons=${bad.reasons.join(",")}`);
      // T12b: the schedule releases itself after the regular-price phase; the subscription continues on the regular price
      {
        const phase2End = ph[1].end_date as number;
        const target2 = phase2End + 2 * 3600;
        // the first advance may still be settling; Stripe refuses a second one until the clock is ready (no clock read is allowlisted, so retry)
        for (let attempt = 0; ; attempt += 1) {
          try {
            await op("testHelpers.testClocks.advance", { id: f.clockId, frozen_time: target2, attempt }, () => stripe.testHelpers.testClocks.advance(f.clockId, { frozen_time: target2 }));
            break;
          } catch (error) {
            if (attempt >= 30 || !/advancement underway/.test((error as Error).message)) throw error;
            await new Promise((r) => setTimeout(r, 4000));
          }
        }
        ctx.nowRef.value = new Date(target2 * 1000);
        let rolled2 = false;
        for (let i = 0; i < 40 && !rolled2; i += 1) {
          await new Promise((r) => setTimeout(r, 3000));
          rolled2 = (await readSubscription(ctx, f.subscriptionId)).currentPeriodStart.getTime() === phase2End * 1000;
        }
        const finalSub: any = await op("subscriptions.retrieve", { id: f.subscriptionId }, () => stripe.subscriptions.retrieve(f.subscriptionId));
        const finalSchedule: any = await op("subscriptionSchedules.retrieve", { id: scheduleId as string }, () => stripe.subscriptionSchedules.retrieve(scheduleId as string));
        const invoices2: any = await op("invoices.list", { customer: f.customerId }, () => stripe.invoices.list({ customer: f.customerId, limit: 20 }));
        const cycle = invoices2.data.filter((i: any) => i.billing_reason === "subscription_cycle");
        record(ctx, "T12b", "after the regular-price phase Stripe releases the schedule and the subscription keeps billing the regular price", rolled2 && ["released", "completed"].includes(finalSchedule.status) && finalSub.items.data[0].price.id === ctx.regular && finalSub.status === "active" && cycle.length === 2 && cycle.every((i: any) => i.amount_due === ctx.regularAmount), `rolled=${rolled2} scheduleStatus=${finalSchedule.status} price=${finalSub.items.data[0].price.id} status=${finalSub.status} cycleInvoices=${cycle.map((i: any) => i.amount_due).join(",")}`);
      }
    }

    // ---- T5: stale approval ----
    {
      const f = await fixture(ctx, "t5");
      const hash = await dryHash(ctx, f);
      await op("subscriptions.update", { id: f.subscriptionId, items: "quantity 2" }, async () => {
        const s: any = await stripe.subscriptions.retrieve(f.subscriptionId);
        return stripe.subscriptions.update(f.subscriptionId, { items: [{ id: s.items.data[0].id, quantity: 2 }], proration_behavior: "none" });
      });
      const writes = { ...ctx.writes };
      const report = await runPriceTransition(executeArgs(f.args, hash), memRunnerDeps(ctx, f.mem));
      record(ctx, "T5", "an approval is stale once the subscription changes after the dry run (nothing written)", !report.ok && report.blockers.includes("stale_or_mismatched_approval") && ctx.writes.create === writes.create && (await currentSchedule(ctx, f.subscriptionId)) === null && f.mem.audits.length === 0, `blockers=${report.blockers.join(",")}`);
    }

    // ---- T7: injected failures leave the subscription unchanged ----
    {
      const f = await fixture(ctx, "t7a");
      const hash = await dryHash(ctx, f);
      ctx.hooks = { failUpdate: true };
      const report = await runPriceTransition(executeArgs(f.args, hash), memRunnerDeps(ctx, f.mem));
      ctx.hooks = {};
      const sched = await currentSchedule(ctx, f.subscriptionId);
      record(ctx, "T7a", "failed schedule update: the created schedule is released, the subscription is unchanged, the audit row is failed", !report.ok && (report as any).status === "failed" && (report as any).released === true && sched === null && f.mem.audits[0].status === "failed", `report=${(report as any).status} released=${(report as any).released} schedule=${sched} audit=${f.mem.audits[0].status}`);
    }
    {
      const f = await fixture(ctx, "t7b");
      const hash = await dryHash(ctx, f);
      ctx.hooks = { corruptReadBack: true };
      const report = await runPriceTransition(executeArgs(f.args, hash), memRunnerDeps(ctx, f.mem));
      ctx.hooks = {};
      const sched = await currentSchedule(ctx, f.subscriptionId);
      record(ctx, "T7b", "read-back mismatch: the schedule is released and the subscription is unchanged", !report.ok && (report as any).released === true && sched === null && f.mem.audits[0].status === "failed", `reason=${(report as any).reason} schedule=${sched}`);
    }
    {
      const f = await fixture(ctx, "f1");
      const hash = await dryHash(ctx, f);
      const foreign: any = await op("subscriptionSchedules.create", { from_subscription: f.subscriptionId, foreign: true }, () => stripe.subscriptionSchedules.create({ from_subscription: f.subscriptionId }));
      const report = await runPriceTransition(executeArgs(f.args, hash), memRunnerDeps(ctx, f.mem));
      const still = await currentSchedule(ctx, f.subscriptionId);
      record(ctx, "F1", "failed schedule creation (a schedule appeared after the approval): the foreign schedule is left untouched and no write is attempted", !report.ok && still === foreign.id, `blockers=${report.blockers.join(",")} reason=${(report as any).reason ?? ""} schedule still ${still === foreign.id ? "the foreign one" : still}`);
      await cleanup(ctx, f.subscriptionId);
    }
    {
      const f = await fixture(ctx, "f2");
      const hash = await dryHash(ctx, f);
      ctx.hooks = { failUpdate: true, failRelease: true };
      const report = await runPriceTransition(executeArgs(f.args, hash), memRunnerDeps(ctx, f.mem));
      ctx.hooks = {};
      const sched = await currentSchedule(ctx, f.subscriptionId);
      const loud = (report as any).released === false && report.blockers.includes("schedule_may_still_be_attached") && Boolean((report as any).scheduleId) && sched === (report as any).scheduleId;
      record(ctx, "F2", "failed release: reported loudly with the live schedule id, audit row failed", !report.ok && loud, `released=${(report as any).released} blockers=${report.blockers.join(",")} liveSchedule=${sched}`);
      await cleanup(ctx, f.subscriptionId);
      record(ctx, "F2b", "operator cleanup releases it and leaves the subscription clean", (await currentSchedule(ctx, f.subscriptionId)) === null, "released by hand");
    }
    {
      const f = await fixture(ctx, "f3");
      const hash = await dryHash(ctx, f);
      ctx.hooks = { loseCreateResponse: true };
      const report = await runPriceTransition(executeArgs(f.args, hash), memRunnerDeps(ctx, f.mem));
      ctx.hooks = {};
      const sched = await currentSchedule(ctx, f.subscriptionId);
      record(ctx, "F3", "lost create response: the orphan schedule is found and released", !report.ok && (report as any).released === true && Boolean((report as any).scheduleId) && sched === null, `scheduleId=${(report as any).scheduleId} released=${(report as any).released} schedule=${sched}`);
    }
    {
      const f = await fixture(ctx, "f4");
      const hash = await dryHash(ctx, f);
      f.mem.finalizeFailures = 3;
      const report = await runPriceTransition(executeArgs(f.args, hash), memRunnerDeps(ctx, f.mem));
      const sched = await currentSchedule(ctx, f.subscriptionId);
      const retry = await runPriceTransition(executeArgs(f.args, hash), memRunnerDeps(ctx, f.mem));
      record(ctx, "F4", "audit-update outage after the Stripe write: the live schedule id is still reported, the schedule id was recorded first, and a retry is refused", !report.ok && (report as any).status === "scheduled" && report.blockers.includes("audit_finalize_failed_schedule_is_live") && sched === (report as any).scheduleId && f.mem.audits[0].scheduleId === sched && !retry.ok, `blockers=${report.blockers.join(",")} recorded=${f.mem.audits[0].scheduleId === sched} retry=${retry.blockers.join(",")}`);
      await cleanup(ctx, f.subscriptionId);
    }

    // ---- T8: unsupported subscription shapes are refused ----
    {
      const a = await fixture(ctx, "t8a");
      await op("subscriptions.update", { id: a.subscriptionId, cancel_at_period_end: true }, () => stripe.subscriptions.update(a.subscriptionId, { cancel_at_period_end: true }));
      const ra = await runPriceTransition(a.args, memRunnerDeps(ctx, a.mem));
      const b = await fixture(ctx, "t8b", { extraItem: other.id });
      const rb = await runPriceTransition(b.args, memRunnerDeps(ctx, b.mem));
      const c = await fixture(ctx, "t8c");
      await op("subscriptionSchedules.create", { from_subscription: c.subscriptionId, existing: true }, () => stripe.subscriptionSchedules.create({ from_subscription: c.subscriptionId }));
      const rc = await runPriceTransition(c.args, memRunnerDeps(ctx, c.mem));
      await cleanup(ctx, c.subscriptionId);
      record(ctx, "T8", "cancel-at-period-end, two items and an existing schedule are each refused with nothing written", [ra, rb, rc].every((r) => !r.ok) && ra.blockers.some((x) => /cancel/.test(x)) && rb.blockers.includes("current_price_unexpected") && rc.blockers.includes("subscription_has_schedule"), `cancel=${ra.blockers.join(",")} | items=${rb.blockers.join(",")} | schedule=${rc.blockers.join(",")}`);
    }

    // ---- T11: discount / trial / pause refused ----
    {
      const coupon: any = await op("coupons.create", { percent_off: 10, duration: "forever" }, () => stripe.coupons.create({ percent_off: 10, duration: "forever" }));
      const d = await fixture(ctx, "t11a", { coupon: coupon.id });
      const rd = await runPriceTransition(d.args, memRunnerDeps(ctx, d.mem));
      const p = await fixture(ctx, "t11b");
      await op("subscriptions.update", { id: p.subscriptionId, pause_collection: { behavior: "void" } }, () => stripe.subscriptions.update(p.subscriptionId, { pause_collection: { behavior: "void" } }));
      const rp = await runPriceTransition(p.args, memRunnerDeps(ctx, p.mem));
      record(ctx, "T11", "a discount and a paused collection are refused as unsupported settings, nothing written", !rd.ok && rd.blockers.includes("subscription_unsupported_settings") && !rp.ok && rp.blockers.includes("subscription_unsupported_settings"), `discount=${rd.blockers.join(",")} | pause=${rp.blockers.join(",")}`);
    }

    // ---- T13: idempotency ----
    {
      const f = await fixture(ctx, "t13");
      const key = `d7wp3-proof-${Date.now()}`;
      const first: any = await op("subscriptionSchedules.create", { from_subscription: f.subscriptionId, key }, () => stripe.subscriptionSchedules.create({ from_subscription: f.subscriptionId }, { idempotencyKey: key }));
      const second: any = await op("subscriptionSchedules.create", { from_subscription: f.subscriptionId, key }, () => stripe.subscriptionSchedules.create({ from_subscription: f.subscriptionId }, { idempotencyKey: key }));
      record(ctx, "T13", "the same Stripe idempotency key returns the same schedule (no second object)", first.id === second.id, `${first.id} == ${second.id}`);
      await cleanup(ctx, f.subscriptionId);
    }

    // ---- T14: approver not on the owner list; T9: live key refused (no provider call) ----
    {
      const f = await fixture(ctx, "t14");
      const hash = await dryHash(ctx, f);
      const writes = { ...ctx.writes };
      const report = await runPriceTransition(executeArgs(f.args, hash), memRunnerDeps(ctx, f.mem, []));
      record(ctx, "T14", "an approver not on the owner list is refused before any write", !report.ok && report.blockers.includes("approver_not_authorized") && ctx.writes.create === writes.create && f.mem.audits.length === 0, report.blockers.join(","));
      const plan = planPriceTransition({
        now: ctx.nowRef.value, subscription: (await readSubscription(ctx, f.subscriptionId)), notice: f.mem.notice, target: await readPrice(ctx, ctx.regular), approval: { approvedBy: "owner-1", boundaryAt: f.args.boundaryAt }, protectedSubscriptionId: f.mem.registry.id,
      });
      let liveCalls = 0;
      const stub: ScheduleStripe = { subscriptionSchedules: { create: async () => { liveCalls += 1; return { id: "x" }; }, update: async () => { liveCalls += 1; }, retrieve: async () => { liveCalls += 1; throw new Error("no"); }, release: async () => { liveCalls += 1; } }, subscriptions: { retrieve: async () => { liveCalls += 1; return { schedule: null }; } } };
      const live = await executePriceTransition(stub, plan, { keyMode: "live" });
      record(ctx, "T9", "a live key mode without explicit allowLive is refused before any provider call (stub client, no live key used)", live.status === "failed" && liveCalls === 0, `calls=${liveCalls} reason=${(live as any).reason}`);
    }
  } finally {
    for (const id of ctx.clocks) {
      try {
        await op("testHelpers.testClocks.del", { id }, () => stripe.testHelpers.testClocks.del(id));
      } catch (error) {
        console.error(`cleanup: could not delete test clock ${id}: ${(error as Error).message}`);
      }
    }
    summary.testClocksCreated = ctx.clocks.length;
    summary.stripeWrites = ctx.writes;
  }
  return { results: ctx.results, summary };
}
