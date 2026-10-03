import { createHash } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveStudioBillingPlan } from "@/lib/billing/access";
import { getBillingPlan } from "@/lib/billing/plans";
import { getCurrentMonthlyPeriod, getIncludedUsageAllowance } from "@/lib/usage/addons";

/**
 * ENT-1: monthly email-campaign recipient allowance, enforced atomically.
 *
 * Policy (unchanged): starter 0, growth 1,000, pro 5,000, organizer 1,000 recipients per month, plus any active
 * `email_campaign_recipient` add-on entitlement rows (none is sold today; nothing here offers one).
 *
 * Model: the server action resolves the workspace's allowance (this module, canonical plan resolution, fail closed),
 * then the database reserves it atomically (`reserve_usage_allowance`, serialized per workspace/feature/month),
 * the action sends, and finalizes with the number of recipients whose send actually succeeded
 * (`finalize_usage_reservation` records exactly that as usage; the rest of the reservation is released). Failed
 * recipients never consume allowance. The reservation functions are service_role only: this module runs them with the
 * admin client after the calling action has authorized the caller and derived the workspace from its own context.
 * The database computes current usage; no client-supplied usage total is ever trusted.
 */

export const EMAIL_CAMPAIGN_USAGE_FEATURE = "email_campaign_recipient" as const;

export type CampaignWorkspace =
  | { type: "studio"; studioId: string }
  | { type: "organizer"; organizerId: string };

export type CampaignAllowanceBlockReason =
  | "inactive_subscription"
  | "no_allowance"
  | "limit_reached"
  | "lookup_failed";

export type CampaignAllowanceState = {
  /** True only when an active/trialing subscription resolved and the plan includes a positive allowance. */
  entitled: boolean;
  blockedReason: CampaignAllowanceBlockReason | null;
  planCode: string | null;
  planName: string | null;
  includedAllowance: number;
  addonAllowance: number;
  totalAllowance: number;
  /** Recipients already recorded as used this month. */
  used: number;
  /** Recipients reserved by sends that are in progress right now. */
  reserved: number;
  /** total - used - reserved, never below zero. */
  remaining: number;
  periodStart: string;
  periodEnd: string;
};

export type CampaignAllowanceDecision = {
  allowed: boolean;
  recipients: number;
  state: CampaignAllowanceState;
  /** Remaining allowance if this campaign were sent; null when blocked. */
  remainingAfterSend: number | null;
};

type AdminClient = ReturnType<typeof createAdminClient>;

function isActiveStatus(value: string | null | undefined) {
  return value === "active" || value === "trialing";
}

function failedState(reason: CampaignAllowanceBlockReason, partial: Partial<CampaignAllowanceState> = {}): CampaignAllowanceState {
  const { periodStart, periodEnd } = getCurrentMonthlyPeriod();
  return {
    entitled: false,
    blockedReason: reason,
    planCode: null,
    planName: null,
    includedAllowance: 0,
    addonAllowance: 0,
    totalAllowance: 0,
    used: 0,
    reserved: 0,
    remaining: 0,
    periodStart,
    periodEnd,
    ...partial,
  };
}

/**
 * Resolves the allowance and current position of ONE workspace. Every query is scoped to the explicit workspace id the
 * caller derived from its authorized context. Anything that cannot be established fails closed (never "unlimited").
 */
export async function getCampaignAllowanceState(
  workspace: CampaignWorkspace,
  deps: { admin?: AdminClient } = {},
): Promise<CampaignAllowanceState> {
  const { periodStart, periodEnd } = getCurrentMonthlyPeriod();

  try {
    const admin = deps.admin ?? createAdminClient();
    const studio = workspace.type === "studio";
    const workspaceId = studio ? workspace.studioId : workspace.organizerId;
    const column = studio ? "studio_id" : "organizer_id";

    let status: string | null | undefined;
    let planCode: string | null = null;
    let planName: string | null = null;

    if (studio) {
      const resolution = await resolveStudioBillingPlan(admin as never, workspace.studioId);
      status = resolution.status;
      planCode = resolution.planCode;
      planName = resolution.planName ?? null;
    } else {
      const { data: organizer, error } = await admin
        .from("organizers")
        .select("billing_plan, subscription_status")
        .eq("id", workspace.organizerId)
        .maybeSingle<{ billing_plan: string | null; subscription_status: string | null }>();

      if (error || !organizer) return failedState("lookup_failed");
      status = organizer.subscription_status;
      planCode = organizer.billing_plan === "organizer" ? "organizer" : null;
    }

    if (!isActiveStatus(status)) {
      return failedState("inactive_subscription", { planCode, planName: getBillingPlan(planCode)?.label ?? planName });
    }

    const includedAllowance = getIncludedUsageAllowance({
      planCode: planCode as "starter" | "growth" | "pro" | "organizer" | null,
      featureKey: EMAIL_CAMPAIGN_USAGE_FEATURE,
    });

    const [entitlements, summary, reservations] = await Promise.all([
      admin
        .from("usage_addon_entitlements")
        .select("quantity_included")
        .eq(column, workspaceId)
        .eq("feature_key", EMAIL_CAMPAIGN_USAGE_FEATURE)
        .eq("status", "active"),
      admin
        .from("usage_monthly_summaries")
        .select("quantity_used")
        .eq(column, workspaceId)
        .eq("feature_key", EMAIL_CAMPAIGN_USAGE_FEATURE)
        .eq("period_start", periodStart)
        .maybeSingle<{ quantity_used: number | null }>(),
      admin
        .from("usage_reservations")
        .select("quantity_reserved")
        .eq(column, workspaceId)
        .eq("feature_key", EMAIL_CAMPAIGN_USAGE_FEATURE)
        .eq("period_start", periodStart)
        .eq("status", "reserved")
        .gt("expires_at", new Date().toISOString()),
    ]);

    if (entitlements.error || summary.error || reservations.error) return failedState("lookup_failed");

    const addonAllowance = (entitlements.data ?? []).reduce(
      (total: number, row: { quantity_included: number | null }) => total + Math.max(0, row.quantity_included ?? 0),
      0,
    );
    const used = Math.max(0, summary.data?.quantity_used ?? 0);
    const reserved = (reservations.data ?? []).reduce(
      (total: number, row: { quantity_reserved: number | null }) => total + Math.max(0, row.quantity_reserved ?? 0),
      0,
    );
    const totalAllowance = includedAllowance + addonAllowance;

    return {
      entitled: totalAllowance > 0,
      blockedReason: totalAllowance > 0 ? null : "no_allowance",
      planCode,
      planName: getBillingPlan(planCode)?.label ?? planName,
      includedAllowance,
      addonAllowance,
      totalAllowance,
      used,
      reserved,
      remaining: Math.max(0, totalAllowance - used - reserved),
      periodStart,
      periodEnd,
    };
  } catch (error) {
    console.error("Campaign allowance lookup failed", error);
    return failedState("lookup_failed");
  }
}

/** Pure preflight: may a campaign with this many eligible recipients be sent right now? Exactly at the limit is allowed. */
export function evaluateCampaignAllowance(state: CampaignAllowanceState, recipients: number): CampaignAllowanceDecision {
  const allowed = state.entitled && state.totalAllowance > 0 && recipients > 0 && recipients <= state.remaining;
  return { allowed, recipients, state, remainingAfterSend: allowed ? state.remaining - recipients : null };
}

/* ------------------------------------------------------------------------------------------ messages and redirects */

const num = (value: number) => value.toLocaleString("en-US");

/** The user-facing explanation of a blocked send. Contextual upgrade language only: no add-on, no pricing. */
export function describeCampaignAllowanceBlock(args: {
  reason: CampaignAllowanceBlockReason;
  recipients: number;
  planName: string | null;
  allowance: number;
  used: number;
  remaining: number;
}) {
  const plan = args.planName ? `${args.planName} plan` : "plan";

  if (args.reason === "inactive_subscription") {
    return "Your subscription must be active before campaigns can be sent. Nothing was sent.";
  }
  if (args.reason === "lookup_failed") {
    return "We could not confirm your monthly campaign allowance, so nothing was sent. Please try again.";
  }
  if (args.reason === "no_allowance" || args.allowance <= 0) {
    return `Your ${plan} does not include campaign recipients. Nothing was sent. Upgrade your plan to send campaigns.`;
  }
  return (
    `This campaign exceeds your remaining monthly email allowance. Nothing was sent. ` +
    `${num(args.recipients)} recipient${args.recipients === 1 ? "" : "s"} in this campaign, ` +
    `${num(args.allowance)} monthly allowance, ${num(args.used)} already used, ${num(args.remaining)} remaining this month. ` +
    `Your ${plan} includes ${num(args.allowance)} campaign recipients per month. Upgrade your plan to increase your monthly allowance.`
  );
}

export type CampaignAllowanceQuery = {
  campaign_error: "allowance_exceeded";
  allowance_reason: CampaignAllowanceBlockReason;
  allowance_recipients: string;
  allowance_total: string;
  allowance_used: string;
  allowance_remaining: string;
  allowance_plan?: string;
};

/** Structured limit result carried on the redirect back to the campaign page (counts and plan name only). */
export function campaignAllowanceQuery(state: CampaignAllowanceState, recipients: number, reason?: CampaignAllowanceBlockReason): CampaignAllowanceQuery {
  const query: CampaignAllowanceQuery = {
    campaign_error: "allowance_exceeded",
    allowance_reason: reason ?? state.blockedReason ?? "limit_reached",
    allowance_recipients: String(recipients),
    allowance_total: String(state.totalAllowance),
    allowance_used: String(state.used + state.reserved),
    allowance_remaining: String(state.remaining),
  };
  if (state.planName) query.allowance_plan = state.planName;
  return query;
}

const REASONS: CampaignAllowanceBlockReason[] = ["inactive_subscription", "no_allowance", "limit_reached", "lookup_failed"];

/** Rebuilds the message from the redirect's query string (numbers are validated; nothing is rendered unparsed). */
export function campaignAllowanceMessageFromQuery(query: Record<string, string | undefined>) {
  const read = (key: string) => {
    const value = Number(query[key]);
    return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
  };
  const reason = REASONS.find((r) => r === query.allowance_reason) ?? "limit_reached";
  const planName = query.allowance_plan ? query.allowance_plan.replace(/[^A-Za-z0-9 ]/g, "").slice(0, 40) : null;
  return describeCampaignAllowanceBlock({
    reason,
    recipients: read("allowance_recipients"),
    planName: planName || null,
    allowance: read("allowance_total"),
    used: read("allowance_used"),
    remaining: read("allowance_remaining"),
  });
}

/* ------------------------------------------------------------------------------------------ reserve / finalize / release */

export type CampaignSendReservation =
  | { ok: true; reservationId: string; state: CampaignAllowanceState }
  | { ok: false; reason: CampaignAllowanceBlockReason; state: CampaignAllowanceState; query: CampaignAllowanceQuery };

/** Stable per recipient set: a retried identical batch maps to the same reservation. */
export function campaignBatchKey(campaignId: string, recipientIds: string[]) {
  const digest = createHash("sha256").update([...recipientIds].sort().join(",")).digest("hex").slice(0, 32);
  return `campaign:${campaignId}:${digest}`;
}

type ReserveRpcResult = {
  ok?: boolean;
  reason?: string;
  reservation_id?: string;
  allowance?: number;
  used?: number;
  reserved?: number;
  remaining?: number;
};

/**
 * Preflight + atomic reservation for one send batch. `eligibleTotal` is every pending recipient of the campaign: if it
 * exceeds the remaining allowance NOTHING is sent (no partial campaign, recipient order never decides who is mailed).
 * `batchRecipientIds` is the batch this action will mail now (the existing per-action cap); it only identifies the
 * request (idempotency). The eligible total is what is reserved atomically in the database, and finalize records only the
 * recipients actually mailed and releases the rest. A campaign larger than one batch is therefore guaranteed to fit when its
 * first batch starts; each later batch is judged again on the recipients still pending.
 */
export async function reserveCampaignSendAllowance(args: {
  workspace: CampaignWorkspace;
  campaignId: string;
  eligibleTotal: number;
  batchRecipientIds: string[];
  userId: string | null;
  source: string;
  relatedTable: string;
  deps?: { admin?: AdminClient };
}): Promise<CampaignSendReservation> {
  const state = await getCampaignAllowanceState(args.workspace, args.deps);
  const blocked = (reason: CampaignAllowanceBlockReason, s: CampaignAllowanceState): CampaignSendReservation => ({
    ok: false,
    reason,
    state: s,
    query: campaignAllowanceQuery(s, args.eligibleTotal, reason),
  });

  if (!state.entitled) return blocked(state.blockedReason ?? "lookup_failed", state);

  const decision = evaluateCampaignAllowance(state, args.eligibleTotal);
  if (!decision.allowed) return blocked("limit_reached", state);

  try {
    const admin = args.deps?.admin ?? createAdminClient();
    const studio = args.workspace.type === "studio";
    const { data, error } = await admin.rpc("reserve_usage_allowance", {
      p_workspace_type: args.workspace.type,
      p_studio_id: studio ? (args.workspace as { studioId: string }).studioId : null,
      p_organizer_id: studio ? null : (args.workspace as { organizerId: string }).organizerId,
      p_feature_key: EMAIL_CAMPAIGN_USAGE_FEATURE,
      // The WHOLE campaign's eligible recipients are reserved atomically (not just this action's batch), so a concurrent
      // sender cannot slip a smaller batch in and leave this campaign half-mailed. What is not mailed is released on finalize.
      p_quantity: Math.max(args.eligibleTotal, args.batchRecipientIds.length),
      p_allowance: state.totalAllowance,
      p_period_start: state.periodStart,
      p_period_end: state.periodEnd,
      p_idempotency_key: campaignBatchKey(args.campaignId, args.batchRecipientIds),
      p_source: args.source,
      p_related_table: args.relatedTable,
      p_related_id: args.campaignId,
      p_created_by: args.userId,
    });

    const result = (data ?? {}) as ReserveRpcResult;

    if (error || typeof result.ok !== "boolean") {
      console.error("Campaign allowance reservation failed", error);
      return blocked("lookup_failed", state);
    }

    if (!result.ok || !result.reservation_id) {
      // The database is authoritative: another send took the allowance between our read and the reservation.
      const refreshed: CampaignAllowanceState = {
        ...state,
        used: result.used ?? state.used,
        reserved: result.reserved ?? state.reserved,
        remaining: result.remaining ?? 0,
      };
      return blocked(result.reason === "no_allowance" ? "no_allowance" : "limit_reached", refreshed);
    }

    return { ok: true, reservationId: result.reservation_id, state };
  } catch (error) {
    console.error("Campaign allowance reservation failed", error);
    return blocked("lookup_failed", state);
  }
}

/** Records the recipients whose send succeeded (0 allowed) and releases the rest. Retries once; logs on failure. */
export async function finalizeCampaignAllowance(args: {
  reservationId: string;
  sentCount: number;
  metadata?: Record<string, unknown>;
  deps?: { admin?: AdminClient };
}) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const admin = args.deps?.admin ?? createAdminClient();
      const { data, error } = await admin.rpc("finalize_usage_reservation", {
        p_reservation_id: args.reservationId,
        p_quantity_consumed: Math.max(0, args.sentCount),
        p_metadata: args.metadata ?? {},
      });
      if (!error && (data as { ok?: boolean } | null)?.ok) return true;
      console.error("Campaign allowance finalize failed", { attempt, error, data });
    } catch (error) {
      console.error("Campaign allowance finalize failed", { attempt, error });
    }
  }
  return false;
}

export async function releaseCampaignAllowance(args: { reservationId: string; deps?: { admin?: AdminClient } }) {
  try {
    const admin = args.deps?.admin ?? createAdminClient();
    const { error } = await admin.rpc("release_usage_reservation", { p_reservation_id: args.reservationId });
    if (error) console.error("Campaign allowance release failed", error);
    return !error;
  } catch (error) {
    console.error("Campaign allowance release failed", error);
    return false;
  }
}

/**
 * Thrown by a send action when the allowance blocks the send, so it can redirect from OUTSIDE the action's own try body
 * (the studio send action's catch turns any other thrown error into a generic send_failed redirect).
 */
export class CampaignAllowanceBlockedError extends Error {
  readonly query: CampaignAllowanceQuery;

  constructor(query: CampaignAllowanceQuery) {
    super("Campaign blocked by the monthly email allowance");
    this.name = "CampaignAllowanceBlockedError";
    this.query = query;
  }
}
