import { randomUUID } from "node:crypto";
import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  safeCaptureOrganizerEventRegistrationContact,
  safeQueuePaidEventCartOrderConfirmation,
} from "@/lib/events/settlementSideEffects";
import { syncFeeDetailsForPaymentIntent } from "@/lib/payments/stripeFeeSync";

/**
 * PAY-WH-1 -- drains the event-cart settlement outbox (rows written by settle_event_cart_order in the same transaction
 * that marked the order paid). Each effect is claimed with a lease, executed idempotently, verified by a post-condition
 * and then completed; a failure is recorded on the row and retried with backoff (visible, never swallowed). A worker
 * interrupted after settlement loses nothing: its lease expires and the next drain (webhook or cron) picks it up.
 */

type OutboxRow = {
  id: string;
  order_id: string;
  studio_id: string;
  effect: "studio_lead" | "organizer_contact" | "order_confirmation" | "fee_sync" | "close_superseded_attempts";
  subject_id: string | null;
  payload: Record<string, unknown> | null;
  attempts: number;
};

export type OutboxDrainResult = { claimed: number; done: number; failed: number };

async function requireRow(admin: SupabaseClient, table: string, column: string, value: string, what: string) {
  const { data, error } = await admin.from(table).select("id").eq(column, value).limit(1);
  if (error) throw new Error(`${what}: ${error.message}`);
  if (!data?.length) throw new Error(`${what}: not recorded yet`);
}

async function closeSupersededAttempts(admin: SupabaseClient, stripe: Stripe | null, orderId: string) {
  const { data, error } = await admin
    .from("event_order_payment_attempts")
    .select("id, kind, stripe_account_id, stripe_checkout_session_id, stripe_payment_intent_id")
    .eq("order_id", orderId)
    .eq("status", "superseded");
  if (error) throw new Error(`superseded attempts lookup: ${error.message}`);
  if (!data?.length) return;
  if (!stripe) throw new Error("Stripe is not configured");
  for (const attempt of data) {
    const options = { stripeAccount: attempt.stripe_account_id as string };
    if (attempt.kind === "checkout_session" && attempt.stripe_checkout_session_id) {
      const session = await stripe.checkout.sessions.retrieve(attempt.stripe_checkout_session_id as string, {}, options);
      if (session.status === "open") await stripe.checkout.sessions.expire(session.id, {}, options);
    } else if (attempt.kind === "payment_intent" && attempt.stripe_payment_intent_id) {
      const intent = await stripe.paymentIntents.retrieve(attempt.stripe_payment_intent_id as string, {}, options);
      if (["requires_payment_method", "requires_confirmation", "requires_action"].includes(intent.status)) {
        await stripe.paymentIntents.cancel(intent.id, {}, options);
      }
    }
    // A superseded attempt that Stripe reports as paid is a second payment for the same order: settlement records a
    // duplicate_payment exception when its webhook arrives; nothing is refunded automatically.
  }
}

async function executeEffect(admin: SupabaseClient, stripe: Stripe | null, row: OutboxRow) {
  switch (row.effect) {
    case "studio_lead": {
      if (!row.subject_id) throw new Error("studio_lead without registration");
      const { data, error } = await admin.rpc("capture_event_registration_lead", { p_registration_id: row.subject_id });
      if (error) throw new Error(`capture_event_registration_lead: ${error.message}`);
      const outcome = (data as { outcome?: string } | null)?.outcome;
      if (outcome !== "captured" && outcome !== "skipped") throw new Error(`lead capture outcome ${String(outcome)}`);
      return;
    }
    case "organizer_contact": {
      if (!row.subject_id) throw new Error("organizer_contact without registration");
      const { data: registration, error } = await admin
        .from("event_registrations")
        .select("attendee_email, events(organizer_id)")
        .eq("id", row.subject_id)
        .maybeSingle();
      if (error) throw new Error(`organizer contact registration lookup: ${error.message}`);
      const event = (Array.isArray(registration?.events) ? registration?.events[0] : registration?.events) as { organizer_id?: string | null } | null | undefined;
      // The capture deliberately skips a registration without an attendee email or organizer: nothing to record.
      if (!registration || !String(registration.attendee_email ?? "").trim() || !event?.organizer_id) return;
      await safeCaptureOrganizerEventRegistrationContact({ supabase: admin, registrationId: row.subject_id });
      // The capture function logs and swallows its own errors; the link row is the proof it ran.
      await requireRow(admin, "organizer_contact_registrations", "registration_id", row.subject_id, "organizer contact");
      return;
    }
    case "order_confirmation": {
      const { data: order, error } = await admin.from("event_orders").select("buyer_email").eq("id", row.order_id).maybeSingle();
      if (error) throw new Error(`order lookup: ${error.message}`);
      await safeQueuePaidEventCartOrderConfirmation({ supabase: admin, orderId: row.order_id });
      if (order?.buyer_email) {
        // Queued exactly once (outbound_deliveries.dedupe_key is unique); the shared sender delivers it.
        await requireRow(admin, "outbound_deliveries", "dedupe_key", `event_cart_order_confirmed:email:${row.order_id}`, "order confirmation email");
      }
      return;
    }
    case "fee_sync": {
      const paymentIntentId = typeof row.payload?.payment_intent_id === "string" ? row.payload.payment_intent_id : null;
      const stripeAccountId = typeof row.payload?.stripe_account_id === "string" ? row.payload.stripe_account_id : null;
      if (!paymentIntentId) throw new Error("fee_sync without payment intent");
      if (!stripe) throw new Error("Stripe is not configured");
      const synced = await syncFeeDetailsForPaymentIntent(admin, stripe, paymentIntentId, stripeAccountId);
      if (!synced) throw new Error("Stripe fee details are not available yet");
      return;
    }
    case "close_superseded_attempts":
      await closeSupersededAttempts(admin, stripe, row.order_id);
      return;
    default:
      throw new Error(`unknown outbox effect ${(row as { effect: string }).effect}`);
  }
}

export async function drainEventSettlementOutbox(params: {
  admin: SupabaseClient;
  stripe: Stripe | null;
  orderId?: string | null;
  limit?: number;
  owner?: string;
}): Promise<OutboxDrainResult> {
  const owner = params.owner ?? randomUUID();
  const { data, error } = await params.admin.rpc("claim_event_settlement_outbox", {
    p_owner: owner,
    p_limit: params.limit ?? 20,
    p_lease_seconds: 120,
    p_order_id: params.orderId ?? null,
  });
  if (error) throw new Error(`claim_event_settlement_outbox failed: ${error.message}`);
  const rows = (data ?? []) as OutboxRow[];
  const result: OutboxDrainResult = { claimed: rows.length, done: 0, failed: 0 };

  for (const row of rows) {
    let ok = true;
    let message: string | null = null;
    try {
      await executeEffect(params.admin, params.stripe, row);
    } catch (effectError) {
      ok = false;
      message = effectError instanceof Error ? effectError.message : String(effectError);
      console.error(`event settlement outbox effect ${row.effect} failed`, message);
    }
    const { data: completed, error: completeError } = await params.admin.rpc("complete_event_settlement_outbox", {
      p_id: row.id,
      p_owner: owner,
      p_ok: ok,
      p_error: message,
    });
    if (completeError || completed !== true) {
      // Lease lost (another worker reclaimed it) or completion failed: the row stays claimable; never double-count.
      console.error("event settlement outbox completion was not recorded", completeError?.message ?? "lease lost");
      result.failed += 1;
      continue;
    }
    if (ok) result.done += 1;
    else result.failed += 1;
  }
  return result;
}
