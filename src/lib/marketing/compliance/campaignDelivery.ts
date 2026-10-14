import type { createAdminClient } from "@/lib/supabase/admin";
import { buildListUnsubscribeHeaders, buildUnsubscribeLinks } from "./unsubscribeLinks";
import { sendMarketingEmail, type MarketingEmailTransport, type MarketingProviderOutcome } from "./provider";

/**
 * Marketing M-0: the single send boundary for studio and organizer campaigns.
 *
 * For every recipient: claim (final eligibility check + claim, in the database, under the per-email lock shared with
 * unsubscribe) -> render with that recipient's token -> provider call with a deterministic idempotency key and the
 * RFC 8058 headers -> complete. Fails closed: a claim or completion that cannot be recorded stops the batch, and nothing
 * is sent to a recipient whose claim did not succeed. Rows left 'sending' (uncertain outcome, or a crash) are retried by
 * a later batch with the same idempotency key, or become 'delivery_unknown' once outside the provider's window.
 */

export type CampaignKind = "studio" | "organizer";
type AdminClient = ReturnType<typeof createAdminClient>;

export const CAMPAIGN_RECIPIENT_TABLE: Record<CampaignKind, { table: string; scopeColumn: string }> = {
  studio: { table: "marketing_campaign_recipients", scopeColumn: "studio_id" },
  organizer: { table: "organizer_marketing_campaign_recipients", scopeColumn: "organizer_id" },
};

/** Statuses still owed a send attempt: pending, and claimed-but-unfinished (retried after the lease expires). */
export const OPEN_RECIPIENT_STATUSES = ["pending", "sending"] as const;

export const CLAIM_LEASE_SECONDS = 600;

export class MarketingComplianceError extends Error {
  constructor(
    readonly code:
      | "claim_failed"
      | "completion_failed"
      | "sync_failed"
      | "batch_load_failed"
      | "provider_unavailable",
    message?: string,
  ) {
    super(message ?? code);
    this.name = "MarketingComplianceError";
  }
}

type ClaimResult = {
  outcome?: string;
  claim_id?: string;
  idempotency_key?: string;
  unsubscribe_token?: string;
  email?: string;
  retry?: boolean;
};

export type RenderedCampaignMessage = { subject: string; html: string; text: string };

export type CampaignDeliverySummary = {
  attempted: number;
  /** Provider accepted and the completion was recorded: counts toward allowance. */
  sent: number;
  /** Became delivery_unknown in this batch (an earlier uncertain attempt aged out): counted as consumed. */
  unknown: number;
  failed: number;
  uncertain: number;
  suppressed: number;
  skipped: number;
  /** Set when the batch stopped early (provider unavailable). */
  stoppedReason: string | null;
};

export async function syncCampaignRecipients(
  admin: AdminClient,
  args: {
    kind: CampaignKind;
    scopeId: string;
    campaignId: string;
    recipients: Array<{ email: string; name?: string | null; refId?: string | null }>;
  },
) {
  const { data, error } = await admin.rpc("marketing_sync_campaign_recipients", {
    p_scope_kind: args.kind,
    p_scope_id: args.scopeId,
    p_campaign_id: args.campaignId,
    p_recipients: args.recipients.map((r) => ({ email: r.email, name: r.name ?? null, ref_id: r.refId ?? null })),
  });
  if (error || !data || typeof (data as { outcome?: unknown }).outcome !== "string") {
    throw new MarketingComplianceError("sync_failed", error?.message ?? "Recipient list could not be saved.");
  }
  return data as {
    outcome: "synced" | "not_found" | "campaign_locked" | "delivery_in_progress" | "too_many_recipients";
    pending?: number;
    preserved?: number;
    unsubscribed?: number;
    suppressed?: number;
    skipped?: number;
  };
}

/**
 * The next batch: claimed-but-unfinished rows whose lease has expired first (they may already have been delivered and
 * are retried with the same idempotency key), then pending rows. Never more than `limit`.
 */
export async function loadCampaignSendBatch(
  admin: AdminClient,
  args: { kind: CampaignKind; scopeId: string; campaignId: string; limit: number; now?: Date },
) {
  const { table, scopeColumn } = CAMPAIGN_RECIPIENT_TABLE[args.kind];
  const nowIso = (args.now ?? new Date()).toISOString();
  const [retry, pending] = await Promise.all([
    admin
      .from(table)
      .select("id")
      .eq("campaign_id", args.campaignId)
      .eq(scopeColumn, args.scopeId)
      .eq("status", "sending")
      .lte("claim_expires_at", nowIso)
      .limit(args.limit),
    admin
      .from(table)
      .select("id")
      .eq("campaign_id", args.campaignId)
      .eq(scopeColumn, args.scopeId)
      .eq("status", "pending")
      .limit(args.limit),
  ]);
  if (retry.error || pending.error) {
    throw new MarketingComplianceError("batch_load_failed", (retry.error ?? pending.error)?.message);
  }
  const retryIds = ((retry.data ?? []) as Array<{ id: string }>).map((r) => r.id);
  const pendingIds = ((pending.data ?? []) as Array<{ id: string }>).map((r) => r.id).slice(0, Math.max(0, args.limit - retryIds.length));
  return { retryIds, pendingIds, ids: [...retryIds, ...pendingIds] };
}

/** Recipients still owed an attempt (pending + sending). Throws when it cannot be read: callers must not guess. */
export async function countOpenCampaignRecipients(
  admin: AdminClient,
  args: { kind: CampaignKind; scopeId: string; campaignId: string },
) {
  const { table, scopeColumn } = CAMPAIGN_RECIPIENT_TABLE[args.kind];
  const { count, error } = await admin
    .from(table)
    .select("id", { count: "exact", head: true })
    .eq("campaign_id", args.campaignId)
    .eq(scopeColumn, args.scopeId)
    .in("status", [...OPEN_RECIPIENT_STATUSES]);
  if (error || count === null || count === undefined) {
    throw new MarketingComplianceError("batch_load_failed", error?.message ?? "Recipient count unavailable.");
  }
  return Number(count);
}

/** A campaign left 'sending' by a send that never reached its cleanup (crash, function timeout) is resumable. */
export const STALE_SENDING_CAMPAIGN_MS = 15 * 60_000; // longer than the 600 s claim lease

/**
 * True only when a 'sending' campaign is abandoned: last touched over 15 minutes ago and no recipient holds a live
 * claim. Resuming is then safe: every recipient still goes through the claim (expired 'sending' rows are retried with
 * their idempotency key). Any lookup error keeps the campaign locked.
 */
export async function isAbandonedSendingCampaign(
  admin: AdminClient,
  args: { kind: CampaignKind; scopeId: string; campaignId: string; updatedAt: string | null | undefined; now?: Date },
) {
  const now = args.now ?? new Date();
  const updated = args.updatedAt ? Date.parse(args.updatedAt) : Number.NaN;
  if (!Number.isFinite(updated) || now.getTime() - updated < STALE_SENDING_CAMPAIGN_MS) return false;
  const { table, scopeColumn } = CAMPAIGN_RECIPIENT_TABLE[args.kind];
  const { count, error } = await admin
    .from(table)
    .select("id", { count: "exact", head: true })
    .eq("campaign_id", args.campaignId)
    .eq(scopeColumn, args.scopeId)
    .eq("status", "sending")
    .gt("claim_expires_at", now.toISOString());
  if (error || count === null || count === undefined) return false;
  return Number(count) === 0;
}

async function complete(
  admin: AdminClient,
  args: { kind: CampaignKind; scopeId: string; recipientId: string; claimId: string },
  outcome: "sent" | "failed" | "released" | "uncertain",
  detail: { messageId?: string | null; error?: string | null },
) {
  const { data, error } = await admin.rpc("marketing_complete_campaign_recipient", {
    p_scope_kind: args.kind,
    p_scope_id: args.scopeId,
    p_recipient_id: args.recipientId,
    p_claim_id: args.claimId,
    p_outcome: outcome,
    p_provider_message_id: detail.messageId ?? null,
    p_error: detail.error ?? null,
  });
  const recorded = (data as { outcome?: string } | null)?.outcome;
  if (error || recorded !== outcome) {
    throw new MarketingComplianceError("completion_failed", error?.message ?? `completion recorded as ${recorded ?? "nothing"}`);
  }
}

export function emptyDeliverySummary(): CampaignDeliverySummary {
  return { attempted: 0, sent: 0, unknown: 0, failed: 0, uncertain: 0, suppressed: 0, skipped: 0, stoppedReason: null };
}

/**
 * Sends one batch. `summary` is owned by the caller and updated as each recipient completes, so a caller that settles
 * usage in a `finally` block sees exactly what was accepted even when the batch stops with an error.
 */
export async function deliverCampaignBatch(args: {
  summary: CampaignDeliverySummary;
  admin: AdminClient;
  transport: MarketingEmailTransport;
  kind: CampaignKind;
  scopeId: string;
  campaignId: string;
  recipientIds: string[];
  from: string;
  replyTo?: string | null;
  /** Renders the message for one recipient, given its unsubscribe page URL. Must be deterministic per recipient. */
  render: (input: { unsubscribeUrl: string }) => RenderedCampaignMessage;
}): Promise<CampaignDeliverySummary> {
  const summary = args.summary;

  for (const recipientId of args.recipientIds) {
    const { data, error } = await args.admin.rpc("marketing_claim_campaign_recipient", {
      p_scope_kind: args.kind,
      p_scope_id: args.scopeId,
      p_campaign_id: args.campaignId,
      p_recipient_id: recipientId,
      p_lease_seconds: CLAIM_LEASE_SECONDS,
    });
    const claim = (data ?? {}) as ClaimResult;
    if (error || typeof claim.outcome !== "string") {
      // The final eligibility check could not run: nothing more is sent.
      throw new MarketingComplianceError("claim_failed", error?.message ?? "Recipient eligibility could not be confirmed.");
    }

    if (claim.outcome === "frozen") {
      // Marketing sends are frozen (release / rollback transition): nothing is claimed or sent; the batch stops.
      summary.stoppedReason = "marketing_paused";
      break;
    }
    if (claim.outcome === "delivery_unknown") {
      summary.unknown += 1;
      continue;
    }
    if (claim.outcome === "unsubscribed" || claim.outcome === "suppressed") {
      summary.suppressed += 1;
      continue;
    }
    if (claim.outcome !== "claimed") {
      summary.skipped += 1; // in_flight, not_claimable, not_found, invalid
      continue;
    }

    const claimId = String(claim.claim_id ?? "");
    const token = String(claim.unsubscribe_token ?? "");
    const to = String(claim.email ?? "");
    const idempotencyKey = String(claim.idempotency_key ?? "");
    const ids = { kind: args.kind, scopeId: args.scopeId, recipientId, claimId };

    let message: RenderedCampaignMessage;
    let headers: Record<string, string>;
    try {
      const links = buildUnsubscribeLinks(token, args.kind);
      message = args.render({ unsubscribeUrl: links.pageUrl });
      headers = buildListUnsubscribeHeaders(links.oneClickUrl);
      if (!claimId || !to || !idempotencyKey) throw new Error("incomplete claim");
    } catch (renderError) {
      // Nothing was handed to the provider: the recipient is released untouched and the batch stops.
      await complete(args.admin, ids, "released", { error: renderError instanceof Error ? renderError.message : "render_failed" });
      summary.stoppedReason = "render_failed";
      break;
    }

    summary.attempted += 1;
    const outcome: MarketingProviderOutcome = await sendMarketingEmail(args.transport, {
      from: args.from,
      to,
      subject: message.subject,
      html: message.html,
      text: message.text,
      replyTo: args.replyTo ?? null,
      headers,
      idempotencyKey,
    });

    if (outcome.kind === "sent") {
      await complete(args.admin, ids, "sent", { messageId: outcome.messageId });
      summary.sent += 1;
    } else if (outcome.kind === "rejected") {
      await complete(args.admin, ids, "failed", { error: outcome.code });
      summary.failed += 1;
    } else if (outcome.kind === "not_sent") {
      await complete(args.admin, ids, "released", { error: outcome.code });
      summary.stoppedReason = outcome.code;
      break;
    } else {
      await complete(args.admin, ids, "uncertain", { error: outcome.code });
      summary.uncertain += 1;
    }
  }

  return summary;
}
