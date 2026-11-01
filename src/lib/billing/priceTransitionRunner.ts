import { createHash } from "node:crypto";
import {
  executePriceTransition,
  planPriceTransition,
  type ScheduleStripe,
  type TransitionNotice,
  type TransitionPlan,
  type TransitionSubscription,
  type TransitionTargetPrice,
} from "@/lib/billing/priceTransition";

/**
 * D7 WP-3: orchestration for the owner-only July 2027 protected-price transition (run by scripts/billing/price-transition.ts).
 *
 * DRY-RUN BY DEFAULT. Execution needs, all at once:
 *   - execute: true and an approvedBy owner id;
 *   - approvedPlanHash: the hash printed by the dry run of the SAME plan. Any change in the Stripe subscription, the price, the
 *     notice or the boundary since that dry run changes the hash, so a stale approval is refused;
 *   - for a live Stripe key, allowLive plus a liveAuthorizationRef (the separate, written owner authorization).
 * Identity is checked three ways: the registry row, the Stripe subscription and the operator's flags must all name the same
 * subscription, customer and studio, and the subscription's current price must equal the operator's expected price.
 * An audit row (price_transitions) is written BEFORE any Stripe write and finalized after; a Stripe failure never leaves
 * a schedule behind (the executor releases it). No proration, no immediate charge.
 */

export type RegistryRow = {
  id: string;
  studioId: string;
  stripeSubscriptionId: string;
  stripeCustomerId: string | null;
  stripePriceId: string | null;
  releasedAt: string | null;
};

export type StripeSubscriptionRead = TransitionSubscription & { customerId: string };

export type TransitionAuditRow = {
  protectedSubscriptionId: string;
  noticeId: string;
  stripeSubscriptionId: string;
  targetStripePriceId: string;
  boundaryAt: string;
  approvedBy: string;
  dryRun: unknown;
};

export type RunnerDeps = {
  now: () => Date;
  stripe: ScheduleStripe;
  keyMode: "live" | "test";
  loadRegistry(protectedSubscriptionId: string): Promise<RegistryRow | null>;
  loadNotice(noticeId: string): Promise<TransitionNotice | null>;
  hasOpenTransition(protectedSubscriptionId: string): Promise<boolean>;
  readSubscription(stripeSubscriptionId: string): Promise<StripeSubscriptionRead | null>;
  readPrice(priceId: string): Promise<TransitionTargetPrice | null>;
  insertAudit(row: TransitionAuditRow): Promise<{ id: string }>;
  finalizeAudit(id: string, patch: { status: "scheduled" | "failed"; scheduleId: string | null; result: unknown }): Promise<void>;
};

export type RunnerArgs = {
  protectedSubscriptionId: string;
  noticeId: string;
  stripeSubscriptionId: string;
  expectedCurrentPriceId: string;
  targetPriceId: string;
  boundaryAt: Date;
  execute?: boolean;
  approvedBy?: string;
  approvedPlanHash?: string;
  allowLive?: boolean;
  liveAuthorizationRef?: string;
};

export type RunnerReport =
  | { mode: "dry_run"; ok: boolean; blockers: string[]; plan: TransitionPlan | null; planHash: string | null; keyMode: "live" | "test" }
  | { mode: "execute"; ok: boolean; blockers: string[]; status: "scheduled" | "failed" | "refused"; scheduleId: string | null; auditId: string | null; reason?: string };

/** Stable hash of everything the approval covers; a changed input yields a different hash. */
export function hashPlan(plan: Extract<TransitionPlan, { ok: true }>, extra: { noticeId: string; protectedSubscriptionId: string }): string {
  return createHash("sha256").update(JSON.stringify({ ...extra, change: plan.change })).digest("hex");
}

export async function runPriceTransition(args: RunnerArgs, deps: RunnerDeps): Promise<RunnerReport> {
  const refuse = (blockers: string[]): RunnerReport =>
    args.execute
      ? { mode: "execute", ok: false, blockers, status: "refused", scheduleId: null, auditId: null }
      : { mode: "dry_run", ok: false, blockers, plan: null, planHash: null, keyMode: deps.keyMode };

  const registry = await deps.loadRegistry(args.protectedSubscriptionId);
  if (!registry) return refuse(["registry_row_missing"]);
  const identity: string[] = [];
  if (registry.releasedAt) identity.push("registry_row_released");
  if (registry.stripeSubscriptionId !== args.stripeSubscriptionId) identity.push("registry_subscription_mismatch");

  const subscription = await deps.readSubscription(args.stripeSubscriptionId);
  if (!subscription) return refuse([...identity, "stripe_subscription_missing"]);
  if (subscription.id !== args.stripeSubscriptionId) identity.push("stripe_subscription_id_mismatch");
  if (registry.stripeCustomerId && registry.stripeCustomerId !== subscription.customerId) identity.push("customer_mismatch");
  const currentPrices = subscription.items.map((item) => item.priceId);
  if (currentPrices.length !== 1 || currentPrices[0] !== args.expectedCurrentPriceId) identity.push("current_price_unexpected");
  if (registry.stripePriceId && registry.stripePriceId !== args.expectedCurrentPriceId) identity.push("registry_price_mismatch");

  const notice = await deps.loadNotice(args.noticeId);
  if (notice && notice.protectedSubscriptionId !== registry.id) identity.push("notice_for_other_subscription");

  const target = await deps.readPrice(args.targetPriceId);
  if (!target) return refuse([...identity, "target_price_missing"]);

  if (await deps.hasOpenTransition(registry.id)) identity.push("open_transition_exists");

  const plan = planPriceTransition({
    now: deps.now(),
    subscription,
    notice,
    target,
    approval: args.approvedBy ? { approvedBy: args.approvedBy, boundaryAt: args.boundaryAt } : args.execute ? null : { approvedBy: "dry-run", boundaryAt: args.boundaryAt },
    protectedSubscriptionId: registry.id,
  });
  const blockers = [...identity, ...plan.blockers];

  if (!plan.ok || identity.length > 0) {
    return args.execute
      ? { mode: "execute", ok: false, blockers, status: "refused", scheduleId: null, auditId: null }
      : { mode: "dry_run", ok: false, blockers, plan, planHash: null, keyMode: deps.keyMode };
  }

  const planHash = hashPlan(plan, { noticeId: args.noticeId, protectedSubscriptionId: registry.id });
  if (!args.execute) return { mode: "dry_run", ok: true, blockers: [], plan, planHash, keyMode: deps.keyMode };

  // ---- execution gates ----
  const gates: string[] = [];
  if (!args.approvedBy) gates.push("approver_missing");
  if (!args.approvedPlanHash) gates.push("approved_plan_hash_missing");
  else if (args.approvedPlanHash !== planHash) gates.push("stale_or_mismatched_approval");
  if (deps.keyMode === "live" && (!args.allowLive || !args.liveAuthorizationRef?.trim())) gates.push("live_authorization_missing");
  if (gates.length > 0) return { mode: "execute", ok: false, blockers: gates, status: "refused", scheduleId: null, auditId: null };

  // The audit row is written first. A concurrent or repeated run hits the one-open-transition unique index here and stops
  // before any Stripe write.
  let audit: { id: string };
  try {
    audit = await deps.insertAudit({
      protectedSubscriptionId: registry.id,
      noticeId: args.noticeId,
      stripeSubscriptionId: args.stripeSubscriptionId,
      targetStripePriceId: args.targetPriceId,
      boundaryAt: args.boundaryAt.toISOString(),
      approvedBy: args.approvedBy!,
      dryRun: { planHash, keyMode: deps.keyMode, liveAuthorizationRef: args.liveAuthorizationRef ?? null, change: plan.change },
    });
  } catch {
    return { mode: "execute", ok: false, blockers: ["audit_insert_failed"], status: "refused", scheduleId: null, auditId: null };
  }

  const result = await executePriceTransition(deps.stripe, plan, { keyMode: deps.keyMode, allowLive: args.allowLive === true });
  await deps.finalizeAudit(audit.id, {
    status: result.status === "scheduled" ? "scheduled" : "failed",
    scheduleId: result.scheduleId,
    result,
  });
  return result.status === "scheduled"
    ? { mode: "execute", ok: true, blockers: [], status: "scheduled", scheduleId: result.scheduleId, auditId: audit.id }
    : { mode: "execute", ok: false, blockers: [], status: "failed", scheduleId: result.scheduleId, auditId: audit.id, reason: result.reason };
}
