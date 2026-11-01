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
 *   - execute: true and an approvedBy that the deployment recognises as an owner (isAuthorizedApprover);
 *   - approvedPlanHash: the hash printed by the dry run of the SAME plan. Any change in the Stripe subscription, the price, the
 *     customer, the key mode, the notice or the boundary since that dry run changes the hash, so a stale approval is refused;
 *   - for a live Stripe key, allowLive plus a liveAuthorizationRef (the separate, written owner authorization).
 * Identity is checked across the registry row, the Stripe subscription, the customer, the studio and the operator's flags, and
 * the subscription's current price must equal the operator's expected price.
 * The audit row (price_transitions) is written BEFORE any Stripe write; the subscription is then re-read and re-planned, and a
 * changed hash stops the run before Stripe is written. The schedule id is recorded as soon as Stripe returns it. A Stripe failure
 * releases the schedule; if that release fails the report says so loudly. No proration, no immediate charge.
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
  /** True when the approver id is on the deployment's owner list. */
  isAuthorizedApprover(approvedBy: string): boolean;
  insertAudit(row: TransitionAuditRow): Promise<{ id: string }>;
  recordSchedule(auditId: string, scheduleId: string): Promise<void>;
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
  | {
      mode: "execute";
      ok: boolean;
      blockers: string[];
      status: "scheduled" | "failed" | "refused";
      scheduleId: string | null;
      auditId: string | null;
      reason?: string;
      /** false with a scheduleId: a schedule may still be attached to the subscription. Reconcile by hand before anything else. */
      released?: boolean;
    };

/** Stable hash of everything the approval covers; a changed input yields a different hash. */
export function hashPlan(
  plan: Extract<TransitionPlan, { ok: true }>,
  extra: { noticeId: string; protectedSubscriptionId: string; customerId: string; keyMode: "live" | "test" },
): string {
  return createHash("sha256").update(JSON.stringify({ ...extra, change: plan.change })).digest("hex");
}

type Evaluation = { blockers: string[]; plan: TransitionPlan | null; planHash: string | null; registry: RegistryRow | null };

async function evaluate(args: RunnerArgs, deps: RunnerDeps, options: { ownAuditRowOpen?: boolean } = {}): Promise<Evaluation> {
  const fail = (blockers: string[], registry: RegistryRow | null = null): Evaluation => ({ blockers, plan: null, planHash: null, registry });

  const registry = await deps.loadRegistry(args.protectedSubscriptionId);
  if (!registry) return fail(["registry_row_missing"]);
  const identity: string[] = [];
  if (registry.releasedAt) identity.push("registry_row_released");
  if (registry.stripeSubscriptionId !== args.stripeSubscriptionId) identity.push("registry_subscription_mismatch");

  const subscription = await deps.readSubscription(args.stripeSubscriptionId);
  if (!subscription) return fail([...identity, "stripe_subscription_missing"], registry);
  if (subscription.id !== args.stripeSubscriptionId) identity.push("stripe_subscription_id_mismatch");
  if (!registry.stripeCustomerId) identity.push("customer_unbound");
  else if (registry.stripeCustomerId !== subscription.customerId) identity.push("customer_mismatch");
  const currentPrices = subscription.items.map((item) => item.priceId);
  if (currentPrices.length !== 1 || currentPrices[0] !== args.expectedCurrentPriceId) identity.push("current_price_unexpected");
  if (registry.stripePriceId && registry.stripePriceId !== args.expectedCurrentPriceId) identity.push("registry_price_mismatch");

  const notice = await deps.loadNotice(args.noticeId);
  if (notice && notice.protectedSubscriptionId !== registry.id) identity.push("notice_for_other_subscription");
  if (notice && notice.studioId !== registry.studioId) identity.push("notice_studio_mismatch");

  const target = await deps.readPrice(args.targetPriceId);
  if (!target) return fail([...identity, "target_price_missing"], registry);

  if (!options.ownAuditRowOpen && (await deps.hasOpenTransition(registry.id))) identity.push("open_transition_exists");

  const plan = planPriceTransition({
    now: deps.now(),
    subscription,
    notice,
    target,
    approval: args.approvedBy ? { approvedBy: args.approvedBy, boundaryAt: args.boundaryAt } : args.execute ? null : { approvedBy: "dry-run", boundaryAt: args.boundaryAt },
    protectedSubscriptionId: registry.id,
  });
  const blockers = [...identity, ...plan.blockers];
  const planHash =
    plan.ok && identity.length === 0
      ? hashPlan(plan, { noticeId: args.noticeId, protectedSubscriptionId: registry.id, customerId: subscription.customerId, keyMode: deps.keyMode })
      : null;
  return { blockers, plan, planHash, registry };
}

export async function runPriceTransition(args: RunnerArgs, deps: RunnerDeps): Promise<RunnerReport> {
  const refused = (blockers: string[]): RunnerReport => ({ mode: "execute", ok: false, blockers, status: "refused", scheduleId: null, auditId: null });

  const first = await evaluate(args, deps);
  if (!args.execute) {
    return { mode: "dry_run", ok: first.planHash !== null, blockers: first.blockers, plan: first.plan, planHash: first.planHash, keyMode: deps.keyMode };
  }
  if (first.planHash === null || !first.plan || !first.plan.ok || !first.registry) return refused(first.blockers);

  // ---- execution gates ----
  const gates: string[] = [];
  if (!args.approvedBy) gates.push("approver_missing");
  else if (!deps.isAuthorizedApprover(args.approvedBy)) gates.push("approver_not_authorized");
  if (!args.approvedPlanHash) gates.push("approved_plan_hash_missing");
  else if (args.approvedPlanHash !== first.planHash) gates.push("stale_or_mismatched_approval");
  if (deps.keyMode === "live" && (!args.allowLive || !args.liveAuthorizationRef?.trim())) gates.push("live_authorization_missing");
  if (gates.length > 0) return refused(gates);

  // The audit row is written first. A concurrent or repeated run hits the one-open-transition unique index here and stops
  // before any Stripe write.
  let audit: { id: string };
  try {
    audit = await deps.insertAudit({
      protectedSubscriptionId: first.registry.id,
      noticeId: args.noticeId,
      stripeSubscriptionId: args.stripeSubscriptionId,
      targetStripePriceId: args.targetPriceId,
      boundaryAt: args.boundaryAt.toISOString(),
      approvedBy: args.approvedBy!,
      dryRun: { planHash: first.planHash, keyMode: deps.keyMode, liveAuthorizationRef: args.liveAuthorizationRef ?? null, change: first.plan.change },
    });
  } catch {
    return refused(["audit_insert_failed"]);
  }

  const finalize = async (patch: Parameters<RunnerDeps["finalizeAudit"]>[1]) => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await deps.finalizeAudit(audit.id, patch);
        return true;
      } catch {
        // retry; the report below carries the outcome either way
      }
    }
    return false;
  };

  // Re-read and re-plan right before the Stripe write: anything that changed since the dry run stops the run here.
  const second = await evaluate({ ...args, execute: true }, deps, { ownAuditRowOpen: true }).catch(() => null);
  if (!second || second.planHash !== first.planHash) {
    await finalize({ status: "failed", scheduleId: null, result: { reason: "state_changed_before_write", blockers: second?.blockers ?? ["recheck_failed"] } });
    return { mode: "execute", ok: false, blockers: ["state_changed_before_write"], status: "refused", scheduleId: null, auditId: audit.id };
  }

  const result = await executePriceTransition(deps.stripe, first.plan, {
    keyMode: deps.keyMode,
    allowLive: args.allowLive === true,
    idempotencyPrefix: `d7wp3-${audit.id}`,
    onScheduleCreated: (scheduleId) => deps.recordSchedule(audit.id, scheduleId),
  });
  const saved = await finalize({
    status: result.status === "scheduled" ? "scheduled" : "failed",
    scheduleId: result.scheduleId,
    result,
  });
  if (result.status === "scheduled") {
    return { mode: "execute", ok: saved, blockers: saved ? [] : ["audit_finalize_failed_schedule_is_live"], status: "scheduled", scheduleId: result.scheduleId, auditId: audit.id };
  }
  return {
    mode: "execute",
    ok: false,
    blockers: result.released ? [] : ["schedule_may_still_be_attached"],
    status: "failed",
    scheduleId: result.scheduleId,
    auditId: audit.id,
    reason: result.reason,
    released: result.released,
  };
}
