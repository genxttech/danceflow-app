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
 * Two scopes, kept apart. ENTITLEMENT = the whole logical campaign send: the database commits capacity for every pending
 * recipient at admission (all-or-nothing, atomic, serialized per workspace/feature/month), and later delivery batches
 * continue under that same commitment, so no concurrent campaign can take capacity already committed to it and a later
 * batch never fails merely because another campaign started after this one was admitted. DELIVERY = the existing safe
 * batch (500 recipients per action).
 *
 * Per batch: reserve (admit or continue) -> send -> settle with the recipients whose send succeeded
 * (`settle_usage_reservation` records exactly that as usage, shrinks the commitment to consumed + still-pending, and closes
 * the campaign when nothing is pending). Failed recipients never consume allowance. Capacity is NEVER released while a batch
 * is unsettled: if the settle call fails the commitment stays held, and any stale open batch is reconciled from the durable
 * per-recipient 'sent' records before anything else is admitted for the workspace, so a successful send cannot end up
 * permanently uncounted.
 *
 * The reservation functions are service_role only: this module runs them with the admin client after the calling action has
 * authorized the caller and derived the workspace from its own context. The database computes current usage and
 * commitments; no client-supplied usage total is ever trusted.
 */

export const EMAIL_CAMPAIGN_USAGE_FEATURE = "email_campaign_recipient" as const;

export type CampaignWorkspace =
  | { type: "studio"; studioId: string }
  | { type: "organizer"; organizerId: string };

export type CampaignAllowanceBlockReason =
  | "inactive_subscription"
  | "no_allowance"
  | "limit_reached"
  | "lookup_failed"
  | "in_progress";

/** An open batch older than this is treated as a crashed request and reconciled (must match the database default). */
export const STALE_BATCH_SECONDS = 900;

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
  /** Capacity committed to campaigns in progress (consumed excluded): admitted, not yet sent or settled. */
  reserved: number;
  /** total - used - reserved, never below zero. */
  remaining: number;
  /** The part of `reserved` committed to THIS campaign (0 when no campaign is given or it holds none). */
  campaignCommitted: number;
  /** remaining + campaignCommitted: what this campaign may use. */
  available: number;
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
    campaignCommitted: 0,
    available: 0,
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
  deps: { admin?: AdminClient; campaignId?: string } = {},
): Promise<CampaignAllowanceState> {
  const { periodStart, periodEnd } = getCurrentMonthlyPeriod();

  try {
    const admin = deps.admin ?? createAdminClient();

    // Before reading the position, repair any batch a crashed request left unsettled, so successful sends are counted
    // and the position is true. Best effort: if it fails the capacity simply stays held (conservative).
    await reconcileStaleCampaignBatches(workspace, { admin });

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
        .select("quantity_reserved, quantity_consumed, idempotency_key")
        .eq(column, workspaceId)
        .eq("feature_key", EMAIL_CAMPAIGN_USAGE_FEATURE)
        .eq("period_start", periodStart)
        .eq("status", "reserved"),
    ]);

    if (entitlements.error || summary.error || reservations.error) return failedState("lookup_failed");

    const addonAllowance = (entitlements.data ?? []).reduce(
      (total: number, row: { quantity_included: number | null }) => total + Math.max(0, row.quantity_included ?? 0),
      0,
    );
    const used = Math.max(0, summary.data?.quantity_used ?? 0);
    type ReservationRow = { quantity_reserved: number | null; quantity_consumed: number | null; idempotency_key: string | null };
    const committedOf = (row: ReservationRow) => Math.max(0, (row.quantity_reserved ?? 0) - (row.quantity_consumed ?? 0));
    const reserved = (reservations.data ?? []).reduce((total: number, row: ReservationRow) => total + committedOf(row), 0);
    const campaignCommitted = deps.campaignId
      ? (reservations.data ?? [])
          .filter((row: ReservationRow) => row.idempotency_key === campaignReservationKey(deps.campaignId as string))
          .reduce((total: number, row: ReservationRow) => total + committedOf(row), 0)
      : 0;
    const totalAllowance = includedAllowance + addonAllowance;
    const remaining = Math.max(0, totalAllowance - used - reserved);

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
      remaining,
      campaignCommitted,
      available: remaining + campaignCommitted,
      periodStart,
      periodEnd,
    };
  } catch (error) {
    console.error("Campaign allowance lookup failed", error);
    return failedState("lookup_failed");
  }
}

/**
 * Pure preflight: may a campaign with this many eligible (pending) recipients be sent right now? Capacity already committed
 * to THIS campaign counts as available to it. Exactly at the limit is allowed.
 */
export function evaluateCampaignAllowance(state: CampaignAllowanceState, recipients: number): CampaignAllowanceDecision {
  const allowed = state.entitled && state.totalAllowance > 0 && recipients > 0 && recipients <= state.available;
  return { allowed, recipients, state, remainingAfterSend: allowed ? state.available - recipients : null };
}

/** One logical send per campaign: every batch of a campaign continues under this key. */
export function campaignReservationKey(campaignId: string) {
  return `campaign:${campaignId}`;
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
  if (args.reason === "in_progress") {
    return "This campaign is already sending. Nothing further was started.";
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

export type CampaignAllowanceQuery = Record<string, string>;

/** Structured limit result carried on the redirect back to the campaign page (counts and plan name only). */
export function campaignAllowanceQuery(state: CampaignAllowanceState, recipients: number, reason?: CampaignAllowanceBlockReason): CampaignAllowanceQuery {
  // a second action on a campaign that is already sending is a lock, not an allowance problem
  if (reason === "in_progress") return { campaign_error: "campaign_locked" };
  const query: CampaignAllowanceQuery = {
    campaign_error: "allowance_exceeded",
    allowance_reason: reason ?? state.blockedReason ?? "limit_reached",
    allowance_recipients: String(recipients),
    allowance_total: String(state.totalAllowance),
    allowance_used: String(state.used + state.reserved - state.campaignCommitted),
    allowance_remaining: String(state.available),
  };
  if (state.planName) query.allowance_plan = state.planName;
  return query;
}

const REASONS: CampaignAllowanceBlockReason[] = ["inactive_subscription", "no_allowance", "limit_reached", "lookup_failed", "in_progress"];

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

/* ------------------------------------------------------------------------------------------ reserve / settle / reconcile */

export type CampaignSendReservation =
  | { ok: true; reservationId: string; continued: boolean; state: CampaignAllowanceState }
  | { ok: false; reason: CampaignAllowanceBlockReason; state: CampaignAllowanceState; query: CampaignAllowanceQuery };

type ReserveRpcResult = {
  ok?: boolean;
  reason?: string;
  reservation_id?: string;
  continued?: boolean;
  allowance?: number;
  used?: number;
  committed?: number;
  remaining?: number;
};

/**
 * Preflight + atomic admission or continuation of one logical campaign send. `eligibleTotal` is every pending recipient of
 * the campaign (not just this action's batch): if the campaign does not fit, NOTHING is sent (no partial campaign, recipient
 * order never decides who is mailed). The database commits capacity for ALL of them at admission; later batches of the same
 * campaign continue under that commitment even if other campaigns were admitted in between. `batchRecipientIds` is the
 * batch this action mails now: it is recorded on the open batch so a crashed request can be reconciled exactly.
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
  const state = await getCampaignAllowanceState(args.workspace, { admin: args.deps?.admin, campaignId: args.campaignId });
  const blocked = (reason: CampaignAllowanceBlockReason, s: CampaignAllowanceState): CampaignSendReservation => ({
    ok: false,
    reason,
    state: s,
    query: campaignAllowanceQuery(s, args.eligibleTotal, reason),
  });

  if (!state.entitled) return blocked(state.blockedReason ?? "lookup_failed", state);

  const pending = Math.max(args.eligibleTotal, args.batchRecipientIds.length);
  const decision = evaluateCampaignAllowance(state, pending);
  if (!decision.allowed) return blocked("limit_reached", state);

  try {
    const admin = args.deps?.admin ?? createAdminClient();
    const studio = args.workspace.type === "studio";
    const { data, error } = await admin.rpc("reserve_usage_allowance", {
      p_workspace_type: args.workspace.type,
      p_studio_id: studio ? (args.workspace as { studioId: string }).studioId : null,
      p_organizer_id: studio ? null : (args.workspace as { organizerId: string }).organizerId,
      p_feature_key: EMAIL_CAMPAIGN_USAGE_FEATURE,
      p_quantity: pending,
      p_allowance: state.totalAllowance,
      p_period_start: state.periodStart,
      p_period_end: state.periodEnd,
      p_idempotency_key: campaignReservationKey(args.campaignId),
      p_source: args.source,
      p_related_table: args.relatedTable,
      p_related_id: args.campaignId,
      p_created_by: args.userId,
      p_batch_recipient_ids: args.batchRecipientIds,
      p_stale_seconds: STALE_BATCH_SECONDS,
    });

    const result = (data ?? {}) as ReserveRpcResult;

    if (error || typeof result.ok !== "boolean") {
      console.error("Campaign allowance reservation failed", error);
      return blocked("lookup_failed", state);
    }

    if (!result.ok || !result.reservation_id) {
      if (result.reason === "in_progress") return blocked("in_progress", state);
      if (result.reason === "needs_reconcile") return blocked("lookup_failed", state); // could not be repaired just now: fail closed
      // The database is authoritative: another send took the allowance between our read and the reservation.
      const refreshed: CampaignAllowanceState = {
        ...state,
        used: result.used ?? state.used,
        reserved: result.committed ?? state.reserved,
        remaining: result.remaining ?? 0,
        available: result.remaining ?? 0,
        campaignCommitted: 0,
      };
      return blocked(result.reason === "no_allowance" ? "no_allowance" : "limit_reached", refreshed);
    }

    return { ok: true, reservationId: result.reservation_id, continued: Boolean(result.continued), state };
  } catch (error) {
    console.error("Campaign allowance reservation failed", error);
    return blocked("lookup_failed", state);
  }
}

/**
 * Closes the open batch: records the recipients whose send succeeded (0 allowed) as usage, shrinks the campaign's commitment to
 * what is still pending, and closes the campaign when nothing is pending. Retried; if it still fails the commitment stays
 * HELD (never released) and the unsettled batch is reconciled later, so a successful send cannot become permanently
 * uncounted. `pendingRemaining` null (unknown) records usage but keeps the whole commitment.
 */
export async function settleCampaignBatch(args: {
  reservationId: string;
  sentCount: number;
  pendingRemaining: number | null;
  metadata?: Record<string, unknown>;
  deps?: { admin?: AdminClient };
}) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const admin = args.deps?.admin ?? createAdminClient();
      const { data, error } = await admin.rpc("settle_usage_reservation", {
        p_reservation_id: args.reservationId,
        p_batch_sent: Math.max(0, args.sentCount),
        p_pending_remaining: args.pendingRemaining,
        p_metadata: args.metadata ?? {},
      });
      if (!error && (data as { ok?: boolean } | null)?.ok) return true;
      console.error("Campaign allowance settle failed", { attempt, error, data });
    } catch (error) {
      console.error("Campaign allowance settle failed", { attempt, error });
    }
  }
  return false;
}

const RECIPIENT_TABLES = {
  studio: { table: "marketing_campaign_recipients", column: "studio_id" },
  organizer: { table: "organizer_marketing_campaign_recipients", column: "organizer_id" },
} as const;

type StaleBatchRow = { id: string; related_id: string | null; batch_recipient_ids: string[] | null };

/**
 * Largest number of recipient ids sent in one `.in()` lookup. A PostgREST GET carries the ids in the URL: a 500-id batch
 * (about 18 KB) overflows the request/header limit (verified against DEV: 300 ids work, 400 fail), so the lookup is chunked.
 */
export const RECONCILE_ID_CHUNK = 200;

/**
 * Counts the 'sent' recipients among a batch's ids, reading in chunks of at most RECONCILE_ID_CHUNK. Returns null if ANY chunk
 * cannot be read: a partial count is never returned, missing recipients are never inferred as failures.
 */
async function countSentRecipients(
  admin: AdminClient,
  args: { table: string; column: string; workspaceId: string; campaignId: string; ids: string[] },
): Promise<number | null> {
  let total = 0;
  for (let i = 0; i < args.ids.length; i += RECONCILE_ID_CHUNK) {
    const chunk = args.ids.slice(i, i + RECONCILE_ID_CHUNK);
    const { count, error } = await admin
      .from(args.table)
      .select("id", { count: "exact", head: true })
      .eq(args.column, args.workspaceId)
      .eq("campaign_id", args.campaignId)
      .eq("status", "sent")
      .in("id", chunk);
    if (error) return null;
    total += Number(count ?? 0);
  }
  return total;
}

/**
 * Repairs batches a crashed request left open past the stale window. The durable truth is the per-recipient 'sent' record
 * the delivery pipeline writes: the open batch recorded exactly which recipients it was about to mail, so the successes are
 * counted from those rows and settled (idempotently) with the campaign's current pending count. Until it succeeds the
 * capacity stays committed. Returns how many batches were settled.
 */
export async function reconcileStaleCampaignBatches(workspace: CampaignWorkspace, deps: { admin?: AdminClient } = {}) {
  let settled = 0;
  try {
    const admin = deps.admin ?? createAdminClient();
    const studio = workspace.type === "studio";
    const workspaceId = studio ? workspace.studioId : workspace.organizerId;
    const { table, column } = RECIPIENT_TABLES[workspace.type];
    const staleBefore = new Date(Date.now() - STALE_BATCH_SECONDS * 1000).toISOString();

    const { data: stale, error } = await admin
      .from("usage_reservations")
      .select("id, related_id, batch_recipient_ids")
      .eq(studio ? "studio_id" : "organizer_id", workspaceId)
      .eq("feature_key", EMAIL_CAMPAIGN_USAGE_FEATURE)
      .eq("status", "reserved")
      .lt("batch_started_at", staleBefore);

    if (error || !stale?.length) return 0;

    for (const row of stale as StaleBatchRow[]) {
      if (!row.related_id) continue;
      try {
        const ids = row.batch_recipient_ids ?? [];
        const sentCount = await countSentRecipients(admin, { table, column, workspaceId, campaignId: row.related_id, ids });
        // cannot establish the truth (any chunk or the pending count failed): do not settle, do not count, stay conservative;
        // a later reconciliation retries the whole logical batch
        if (sentCount === null) continue;
        const pending = await admin.from(table).select("id", { count: "exact", head: true }).eq(column, workspaceId).eq("campaign_id", row.related_id).eq("status", "pending");
        if (pending.error) continue;

        // chunks are only for READING recipient state: the batch is settled once, with the aggregate
        const ok = await settleCampaignBatch({
          reservationId: row.id,
          sentCount,
          pendingRemaining: Number(pending.count ?? 0),
          metadata: { reconciled: true },
          deps: { admin },
        });
        if (ok) settled += 1;
      } catch (error) {
        console.error("Campaign allowance reconcile failed for one batch", error);
      }
    }
  } catch (error) {
    console.error("Campaign allowance reconcile failed", error);
  }
  return settled;
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
