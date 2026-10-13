import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveEventEmailBranding } from "@/lib/notifications/event-email-branding";
import { queueOutboundDelivery } from "@/lib/notifications/outbound";
import { buildPaymentExceptionAlertEmailTemplate, paymentExceptionLabel } from "@/lib/notifications/templates";

/**
 * PAY-WH-1A -- staff alerts for payment exceptions (captured money without fulfilment, reversed payments, dead
 * settlement effects, unreconcilable orders). The database queues the alert in the same transaction that records the
 * exception; this worker claims it with a lease, notifies the studio (in-app) and its managers (branded email), verifies
 * the in-app notification exists, and completes it. Every write is deduplicated per exception (and recipient), so an
 * interrupted worker or a replay never double-alerts; failures back off and stay visible ('failed').
 */

export type SettlementAlertRow = {
  id: string;
  order_id: string | null;
  studio_id: string | null;
  event_id: string | null;
  registration_id: string | null;
  kind: string;
  money_state: string;
  amount_cents: number | null;
  currency: string | null;
  stripe_payment_intent_id: string | null;
};

export type AlertDrainResult = { claimed: number; sent: number; failed: number };

function getAppUrl() {
  return (process.env.NEXT_PUBLIC_APP_URL || process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000").replace(/\/$/, "");
}

export function paymentExceptionReviewUrl(row: Pick<SettlementAlertRow, "event_id" | "id">) {
  return row.event_id
    ? `${getAppUrl()}/app/events/${row.event_id}/registrations?exception=${row.id}#payment-exceptions`
    : `${getAppUrl()}/app/notifications`;
}

/** Studio owners/admins of the event's studio and organizer owners/admins of its organizer (active members only). */
async function alertRecipients(admin: SupabaseClient, row: SettlementAlertRow) {
  const recipients = new Map<string, string>();
  const userIds = new Set<string>();
  if (row.studio_id) {
    const { data, error } = await admin
      .from("user_studio_roles")
      .select("user_id")
      .eq("studio_id", row.studio_id)
      .eq("active", true)
      .in("role", ["studio_owner", "studio_admin"]);
    if (error) throw new Error(`alert recipients (studio): ${error.message}`);
    for (const item of data ?? []) userIds.add(String(item.user_id));
  }
  if (row.event_id) {
    const { data: event, error: eventError } = await admin.from("events").select("organizer_id").eq("id", row.event_id).maybeSingle();
    if (eventError) throw new Error(`alert recipients (event): ${eventError.message}`);
    if (event?.organizer_id) {
      const { data, error } = await admin
        .from("organizer_users")
        .select("user_id")
        .eq("organizer_id", event.organizer_id)
        .eq("active", true)
        .in("role", ["organizer_owner", "organizer_admin"]);
      if (error) throw new Error(`alert recipients (organizer): ${error.message}`);
      for (const item of data ?? []) userIds.add(String(item.user_id));
    }
  }
  if (userIds.size) {
    const { data, error } = await admin.from("profiles").select("id, email").in("id", [...userIds]);
    if (error) throw new Error(`alert recipients (profiles): ${error.message}`);
    for (const profile of data ?? []) {
      const email = String(profile.email ?? "").trim();
      if (email) recipients.set(String(profile.id), email);
    }
  }
  return recipients;
}

async function deliverAlert(admin: SupabaseClient, row: SettlementAlertRow) {
  if (!row.studio_id) {
    // No studio could be attributed (e.g. an unknown account): platform visibility only.
    return;
  }
  const [{ data: event }, { data: order }] = await Promise.all([
    row.event_id ? admin.from("events").select("name").eq("id", row.event_id).maybeSingle() : Promise.resolve({ data: null }),
    row.order_id ? admin.from("event_orders").select("buyer_email").eq("id", row.order_id).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  const eventName = (event as { name?: string } | null)?.name ?? null;
  const buyerEmail = (order as { buyer_email?: string } | null)?.buyer_email ?? null;
  const reviewUrl = paymentExceptionReviewUrl(row);
  const headline = paymentExceptionLabel(row.kind);

  // In-app notification for the studio (deduplicated per exception).
  const notificationKey = `payment_exception:${row.id}`;
  const { error: notificationError } = await admin.from("notifications").insert({
    studio_id: row.studio_id,
    type: "payment_exception",
    category: "payment",
    priority: row.money_state === "captured" || row.money_state === "reversed" ? "urgent" : "high",
    title: "Payment needs review",
    body: `${headline}${eventName ? ` (${eventName})` : ""}. Review it in Event registrations; nothing was refunded automatically.`,
    dedupe_key: notificationKey,
  });
  if (notificationError && notificationError.code !== "23505") {
    throw new Error(`payment exception notification: ${notificationError.message}`);
  }

  const branding = await resolveEventEmailBranding({ eventId: row.event_id, studioId: row.studio_id });
  const template = buildPaymentExceptionAlertEmailTemplate({
    kind: row.kind,
    moneyState: row.money_state,
    amountCents: row.amount_cents,
    currency: row.currency,
    eventName,
    buyerEmail,
    stripePaymentIntentId: row.stripe_payment_intent_id,
    reviewUrl,
    brandName: branding.name,
    brandLogoUrl: branding.logoUrl,
  });
  const recipients = await alertRecipients(admin, row);
  for (const [userId, email] of recipients) {
    await queueOutboundDelivery({
      studioId: row.studio_id,
      channel: "email",
      templateKey: "payment_exception_alert",
      recipientEmail: email,
      subject: template.subject,
      bodyText: template.bodyText,
      bodyHtml: template.bodyHtml,
      relatedTable: "event_order_settlement_exceptions",
      relatedId: row.id,
      dedupeKey: `${notificationKey}:email:${userId}`,
    });
  }

  // Post-condition: the in-app alert exists (emails are queued idempotently above; the shared sender delivers them).
  const { data: proof, error: proofError } = await admin.from("notifications").select("id").eq("dedupe_key", notificationKey).limit(1);
  if (proofError) throw new Error(`payment exception notification check: ${proofError.message}`);
  if (!proof?.length) throw new Error("payment exception notification not recorded");
}

export async function drainSettlementExceptionAlerts(params: { admin: SupabaseClient; owner?: string; limit?: number }): Promise<AlertDrainResult> {
  const owner = params.owner ?? randomUUID();
  const { data, error } = await params.admin.rpc("claim_settlement_exception_alerts", {
    p_owner: owner,
    p_limit: params.limit ?? 20,
    p_lease_seconds: 120,
  });
  if (error) throw new Error(`claim_settlement_exception_alerts failed: ${error.message}`);
  const rows = (data ?? []) as SettlementAlertRow[];
  const result: AlertDrainResult = { claimed: rows.length, sent: 0, failed: 0 };
  for (const row of rows) {
    let ok = true;
    let message: string | null = null;
    try {
      await deliverAlert(params.admin, row);
    } catch (deliveryError) {
      ok = false;
      message = deliveryError instanceof Error ? deliveryError.message : String(deliveryError);
      console.error("payment exception alert failed", message);
    }
    const { data: completed, error: completeError } = await params.admin.rpc("complete_settlement_exception_alert", {
      p_exception_id: row.id,
      p_owner: owner,
      p_ok: ok,
      p_error: message,
    });
    if (completeError || completed !== true) {
      console.error("payment exception alert completion was not recorded", completeError?.message ?? "lease lost");
      result.failed += 1;
      continue;
    }
    if (ok) result.sent += 1;
    else result.failed += 1;
  }
  return result;
}
