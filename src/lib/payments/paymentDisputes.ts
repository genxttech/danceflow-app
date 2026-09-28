import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { queueOutboundDelivery } from "@/lib/notifications/outbound";
import { getStudioStaffNotificationEmails } from "@/lib/notifications/studioStaffRecipients";
import { buildPaymentDisputeOpenedStudioEmail } from "@/lib/notifications/disputeEmails";

/**
 * PAY-DC-2C: Stripe dispute lifecycle tracking.
 *
 * Connect disputes (event.account present) belong to the studio proven by a persisted
 * PAY-DC-2A owner row matching event.account, else to the studio mapped to that
 * account. Platform-scoped disputes (no event.account, e.g. historical pre-direct-
 * charge payments) are attributed only when exact persisted charge/PaymentIntent ids
 * prove exactly one studio; they never consult current account configuration,
 * metadata or customer identity. Anything unprovable fails closed before any write.
 * Only scalar dispute facts are stored: no evidence, metadata or card/customer data.
 */

export const CHARGE_DISPUTE_EVENT_TYPES = new Set<string>([
  "charge.dispute.created",
  "charge.dispute.updated",
  "charge.dispute.closed",
  "charge.dispute.funds_withdrawn",
  "charge.dispute.funds_reinstated",
]);

const CLOSED_DISPUTE_STATUSES = new Set(["won", "lost", "warning_closed", "prevented"]);

export const DISPUTE_NOTIFICATION_TEMPLATE_KEY = "payment_dispute_opened_studio";

type DisputeScope = "platform" | "connect";

type PaymentRefRow = {
  table: "payments" | "event_payments";
  id: string;
  studioId: string | null;
  stripeAccountId: string | null;
};

function stripeObjectId(value: unknown): string | null {
  if (typeof value === "string") return value || null;
  if (value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string") {
    return (value as { id: string }).id || null;
  }
  return null;
}

function unixToIso(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? new Date(value * 1000).toISOString() : null;
}

/** Studio currently mapped to a connected account (Connect disputes and payouts only). */
export async function resolveStudioIdForStripeAccount(
  supabase: SupabaseClient,
  stripeAccountId: string | null,
) {
  if (!stripeAccountId) return null;

  const { data: studio, error } = await supabase
    .from("studios")
    .select("id")
    .eq("stripe_connected_account_id", stripeAccountId)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return studio?.id ?? null;
}

async function selectByReference(
  supabase: SupabaseClient,
  table: "payments" | "event_payments",
  columns: string,
  chargeId: string | null,
  paymentIntentId: string | null,
) {
  const rows = new Map<string, Record<string, unknown>>();

  for (const [column, value] of [
    ["stripe_charge_id", chargeId],
    ["stripe_payment_intent_id", paymentIntentId],
  ] as const) {
    if (!value) continue;
    const { data, error } = await supabase.from(table).select(columns).eq(column, value);
    if (error) throw new Error(error.message);
    for (const row of (data ?? []) as unknown as Array<Record<string, unknown>>) {
      rows.set(String(row.id), row);
    }
  }

  return [...rows.values()];
}

/** Exact persisted payment rows for a dispute's charge/PaymentIntent, with their studio. */
async function findPaymentReferences(
  supabase: SupabaseClient,
  chargeId: string | null,
  paymentIntentId: string | null,
): Promise<PaymentRefRow[]> {
  const payments = await selectByReference(
    supabase,
    "payments",
    "id, studio_id, stripe_account_id",
    chargeId,
    paymentIntentId,
  );
  const eventPayments = await selectByReference(
    supabase,
    "event_payments",
    "id, event_id, stripe_account_id",
    chargeId,
    paymentIntentId,
  );

  const eventIds = [
    ...new Set(eventPayments.map((row) => row.event_id).filter((id): id is string => typeof id === "string")),
  ];
  const eventStudio = new Map<string, string | null>();
  if (eventIds.length > 0) {
    const { data, error } = await supabase.from("events").select("id, studio_id").in("id", eventIds);
    if (error) throw new Error(error.message);
    for (const row of (data ?? []) as Array<{ id: string; studio_id: string | null }>) {
      eventStudio.set(row.id, row.studio_id ?? null);
    }
  }

  return [
    ...payments.map((row) => ({
      table: "payments" as const,
      id: String(row.id),
      studioId: (row.studio_id as string | null) ?? null,
      stripeAccountId: (row.stripe_account_id as string | null) ?? null,
    })),
    ...eventPayments.map((row) => ({
      table: "event_payments" as const,
      id: String(row.id),
      studioId: typeof row.event_id === "string" ? (eventStudio.get(row.event_id) ?? null) : null,
      stripeAccountId: (row.stripe_account_id as string | null) ?? null,
    })),
  ];
}

/** Link a payment only when exactly one row unambiguously represents the disputed charge. */
function chooseLink(rows: PaymentRefRow[]) {
  const payments = rows.filter((row) => row.table === "payments");
  const eventPayments = rows.filter((row) => row.table === "event_payments");

  if (payments.length === 1) return { payment_id: payments[0].id, event_payment_id: null };
  if (payments.length === 0 && eventPayments.length === 1) {
    return { payment_id: null, event_payment_id: eventPayments[0].id };
  }
  return { payment_id: null, event_payment_id: null };
}

type Attribution = {
  scope: DisputeScope;
  stripeAccountId: string | null;
  studioId: string;
  link: { payment_id: string | null; event_payment_id: string | null };
};

async function attributeConnectDispute(
  supabase: SupabaseClient,
  stripeAccountId: string,
  rows: PaymentRefRow[],
): Promise<Attribution> {
  // A persisted owner matching the Stripe-signed account is authoritative.
  const ownerRows = rows.filter((row) => row.stripeAccountId === stripeAccountId);
  const ownerStudios = new Set(ownerRows.map((row) => row.studioId));

  if (ownerStudios.size > 1 || ownerStudios.has(null)) {
    throw new Error("dispute_account_mismatch");
  }

  const studioId =
    ownerStudios.size === 1
      ? ([...ownerStudios][0] as string)
      : await resolveStudioIdForStripeAccount(supabase, stripeAccountId);

  if (!studioId) {
    throw new Error("dispute_unmapped");
  }

  // Legacy NULL-owner rows may only be linked inside the already-determined studio;
  // rows owned by any other account are never linked.
  const linkable = rows.filter(
    (row) =>
      row.stripeAccountId === stripeAccountId ||
      (row.stripeAccountId === null && row.studioId === studioId),
  );

  return { scope: "connect", stripeAccountId, studioId, link: chooseLink(linkable) };
}

function attributePlatformDispute(rows: PaymentRefRow[]): Attribution {
  if (rows.length === 0) {
    throw new Error("platform_dispute_unmapped");
  }

  // A platform charge can never be owned by a connected account; any stored owner
  // or unresolvable studio makes the attribution ambiguous.
  if (rows.some((row) => row.stripeAccountId !== null || !row.studioId)) {
    throw new Error("platform_dispute_ambiguous");
  }

  const studios = new Set(rows.map((row) => row.studioId as string));
  if (studios.size !== 1) {
    throw new Error("platform_dispute_ambiguous");
  }

  return {
    scope: "platform",
    stripeAccountId: null,
    studioId: [...studios][0],
    link: chooseLink(rows),
  };
}

async function upsertDispute(params: {
  supabase: SupabaseClient;
  event: Stripe.Event;
  dispute: Stripe.Dispute;
  attribution: Attribution;
  chargeId: string | null;
  paymentIntentId: string | null;
}) {
  const { supabase, event, dispute, attribution } = params;
  const eventCreatedAt = unixToIso(event.created) ?? new Date().toISOString();
  const status = String(dispute.status ?? "");

  const facts = {
    stripe_charge_id: params.chargeId,
    stripe_payment_intent_id: params.paymentIntentId,
    amount_cents: Math.max(0, Math.round(Number(dispute.amount ?? 0))),
    currency: String(dispute.currency ?? "usd").toLowerCase(),
    reason: dispute.reason ? String(dispute.reason) : null,
    status,
    evidence_due_by: unixToIso(dispute.evidence_details?.due_by ?? null),
    last_stripe_event_id: event.id,
    last_stripe_event_type: event.type,
    last_stripe_event_created_at: eventCreatedAt,
  };

  const { data: existing, error: existingError } = await supabase
    .from("payment_disputes")
    .select(
      "id, studio_id, stripe_scope, stripe_account_id, payment_id, event_payment_id, closed_at, funds_withdrawn_at, funds_reinstated_at, last_stripe_event_created_at",
    )
    .eq("stripe_dispute_id", dispute.id)
    .maybeSingle();

  if (existingError) {
    throw new Error(existingError.message);
  }

  if (!existing) {
    const { data: inserted, error: insertError } = await supabase
      .from("payment_disputes")
      .insert({
        studio_id: attribution.studioId,
        stripe_scope: attribution.scope,
        stripe_account_id: attribution.stripeAccountId,
        stripe_dispute_id: dispute.id,
        payment_id: attribution.link.payment_id,
        event_payment_id: attribution.link.event_payment_id,
        ...facts,
        closed_at: CLOSED_DISPUTE_STATUSES.has(status) ? eventCreatedAt : null,
        funds_withdrawn_at: event.type === "charge.dispute.funds_withdrawn" ? eventCreatedAt : null,
        funds_reinstated_at: event.type === "charge.dispute.funds_reinstated" ? eventCreatedAt : null,
      })
      .select("id")
      .single();

    if (insertError || !inserted) {
      throw new Error(insertError?.message ?? "payment_dispute_insert_failed");
    }

    return String((inserted as { id: string }).id);
  }

  const row = existing as {
    id: string;
    studio_id: string;
    stripe_scope: string;
    stripe_account_id: string | null;
    payment_id: string | null;
    event_payment_id: string | null;
    closed_at: string | null;
    funds_withdrawn_at: string | null;
    funds_reinstated_at: string | null;
    last_stripe_event_created_at: string | null;
  };

  // A dispute can never be re-pointed to another studio, scope or account.
  if (
    row.studio_id !== attribution.studioId ||
    row.stripe_scope !== attribution.scope ||
    (row.stripe_account_id ?? null) !== attribution.stripeAccountId
  ) {
    throw new Error("dispute_account_mismatch");
  }

  // Out-of-order delivery: an older event never overwrites newer dispute facts.
  const lastSeen = row.last_stripe_event_created_at ? Date.parse(row.last_stripe_event_created_at) : 0;
  if (Date.parse(eventCreatedAt) < lastSeen) {
    return row.id;
  }

  const hasLink = Boolean(row.payment_id || row.event_payment_id);
  const update: Record<string, unknown> = {
    ...facts,
    ...(hasLink ? {} : attribution.link),
  };
  if (!row.closed_at && CLOSED_DISPUTE_STATUSES.has(status)) update.closed_at = eventCreatedAt;
  if (!row.funds_withdrawn_at && event.type === "charge.dispute.funds_withdrawn") {
    update.funds_withdrawn_at = eventCreatedAt;
  }
  if (!row.funds_reinstated_at && event.type === "charge.dispute.funds_reinstated") {
    update.funds_reinstated_at = eventCreatedAt;
  }

  const { error: updateError } = await supabase
    .from("payment_disputes")
    .update(update)
    .eq("id", row.id);

  if (updateError) {
    throw new Error(updateError.message);
  }

  return row.id;
}

async function notifyDisputeOpened(params: {
  supabase: SupabaseClient;
  disputeRowId: string;
  studioId: string;
  dispute: Stripe.Dispute;
}) {
  const { supabase, dispute, studioId } = params;

  const { data: studio, error: studioError } = await supabase
    .from("studios")
    .select("name, public_name, public_logo_url")
    .eq("id", studioId)
    .maybeSingle();

  if (studioError) {
    throw new Error(studioError.message);
  }

  const studioRow = (studio ?? {}) as {
    name?: string | null;
    public_name?: string | null;
    public_logo_url?: string | null;
  };
  const studioName = studioRow.public_name?.trim() || studioRow.name?.trim() || "Your studio";

  const recipients = await getStudioStaffNotificationEmails(supabase, studioId);
  if (recipients.length === 0) {
    console.error("dispute_notification_no_recipient");
    return;
  }

  const dueBy = dispute.evidence_details?.due_by;
  const email = buildPaymentDisputeOpenedStudioEmail({
    studioName,
    studioLogoUrl: studioRow.public_logo_url ?? null,
    amountCents: Math.max(0, Math.round(Number(dispute.amount ?? 0))),
    currency: String(dispute.currency ?? "usd"),
    reason: dispute.reason ? String(dispute.reason) : null,
    evidenceDueBy: typeof dueBy === "number" ? new Date(dueBy * 1000) : null,
  });

  for (const recipientEmail of recipients) {
    await queueOutboundDelivery({
      studioId,
      channel: "email",
      templateKey: DISPUTE_NOTIFICATION_TEMPLATE_KEY,
      recipientEmail,
      subject: email.subject,
      bodyText: email.bodyText,
      bodyHtml: email.bodyHtml,
      relatedTable: "payment_disputes",
      relatedId: params.disputeRowId,
      // One notice per dispute per recipient: webhook retries and duplicate
      // created events are skipped by the outbound dedupe index.
      dedupeKey: `${DISPUTE_NOTIFICATION_TEMPLATE_KEY}:${dispute.id}:${recipientEmail}`,
    });
  }
}

export async function handleChargeDisputeEvent(params: {
  supabase: SupabaseClient;
  event: Stripe.Event;
}) {
  const { supabase, event } = params;
  if (!CHARGE_DISPUTE_EVENT_TYPES.has(event.type)) return false;

  const dispute = event.data.object as Stripe.Dispute;
  const chargeId = stripeObjectId(dispute.charge);
  const paymentIntentId = stripeObjectId(dispute.payment_intent);
  const stripeAccountId = event.account ?? null;

  if (!stripeAccountId && !chargeId && !paymentIntentId) {
    throw new Error("platform_dispute_unmapped");
  }

  const rows = await findPaymentReferences(supabase, chargeId, paymentIntentId);
  const attribution = stripeAccountId
    ? await attributeConnectDispute(supabase, stripeAccountId, rows)
    : attributePlatformDispute(rows);

  const disputeRowId = await upsertDispute({
    supabase,
    event,
    dispute,
    attribution,
    chargeId,
    paymentIntentId,
  });

  if (event.type === "charge.dispute.created") {
    await notifyDisputeOpened({ supabase, disputeRowId, studioId: attribution.studioId, dispute });
  }

  return true;
}
