"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { isRedirectError } from "next/dist/client/components/redirect-error";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getStripe } from "@/lib/payments/stripe";
import {
  buildCompetitionStripeRefundParams,
  classifyCompetitionRefundStripeError,
  CompetitionRefundError,
  observeCompetitionStripeRefund,
  refundErrorCode,
  requestCompetitionOrderRefund,
  type CompetitionRefundLine,
} from "@/lib/payments/competitionRefunds";
import { parseDollarsToCents } from "@/lib/payments/competitionRefundSummary";

/**
 * CI-D / Competition R2 staff actions. Authority, caps, cross-event checks and idempotency are enforced in SQL
 * (request_competition_order_refund, attribute_competition_refund, resolve_competition_refund_*), which run as the
 * signed-in user. Only the Stripe call and the observe RPC use server credentials.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function text(formData: FormData, key: string) {
  return String(formData.get(key) ?? "").trim();
}

function refundPage(eventId: string, orderId: string, query: string) {
  return `/app/events/${eventId}/competition/registrations/${orderId}/refund?${query}`;
}

function refresh(eventId: string, orderId: string) {
  revalidatePath(`/app/events/${eventId}/competition/registrations`);
  revalidatePath(`/app/events/${eventId}/competition/registrations/${orderId}/refund`);
}

/** Lines from the form: amount_<itemId> (dollars) and withdraw_<itemId> (checkbox), for the listed item ids. */
function readRefundLines(formData: FormData): CompetitionRefundLine[] {
  const ids = formData.getAll("itemId").map(String).filter((value) => UUID.test(value));
  const lines: CompetitionRefundLine[] = [];
  for (const id of new Set(ids)) {
    const cents = parseDollarsToCents(text(formData, `amount_${id}`));
    if (!cents) continue;
    lines.push({ orderItemId: id, amountCents: cents, withdrawEntry: formData.get(`withdraw_${id}`) === "on" });
  }
  return lines;
}

export async function refundCompetitionOrderAction(formData: FormData): Promise<void> {
  const eventId = text(formData, "eventId");
  const orderId = text(formData, "orderId");
  const requestId = text(formData, "requestId");
  if (!UUID.test(eventId) || !UUID.test(orderId) || !UUID.test(requestId)) redirect("/app/events");

  let lines: CompetitionRefundLine[];
  try {
    lines = readRefundLines(formData);
  } catch {
    redirect(refundPage(eventId, orderId, "error=COMP_REFUND_LINE_INVALID"));
  }

  try {
    const supabase = await createClient();
    const request = await requestCompetitionOrderRefund(supabase, {
      eventId, orderId, requestId, lines, reason: text(formData, "reason"),
    });
    // A replayed form whose refund already left "requested" has been sent to Stripe: never send it again here.
    if (request.replay && request.status !== "requested") {
      redirect(refundPage(eventId, orderId, `success=refund_${request.status}`));
    }

    const admin = createAdminClient();
    const { params, options } = buildCompetitionStripeRefundParams(requestId, request);
    let refund;
    try {
      refund = await getStripe().refunds.create(params, options);
    } catch (stripeError) {
      if (classifyCompetitionRefundStripeError(stripeError) === "definitive") {
        await observeCompetitionStripeRefund(admin, {
          paymentIntentId: request.paymentIntentId, stripeAccountId: request.stripeAccountId, stripeRefundId: null,
          requestId, amountCents: request.amountCents, status: "failed", stripeEventId: null,
        });
        redirect(refundPage(eventId, orderId, "error=COMP_REFUND_STRIPE_REFUSED"));
      }
      console.error("competition_refund_stripe_unconfirmed");
      redirect(refundPage(eventId, orderId, "error=COMP_REFUND_STRIPE_UNCONFIRMED"));
    }

    try {
      await observeCompetitionStripeRefund(admin, {
        paymentIntentId: request.paymentIntentId, stripeAccountId: request.stripeAccountId, stripeRefundId: refund.id,
        requestId, amountCents: refund.amount, status: refund.status ?? "pending", stripeEventId: null,
      });
    } catch (observeError) {
      // Stripe created the refund; the webhook (same refund id + request metadata) will record it.
      console.error("competition_refund_observe_after_create_failed", observeError instanceof Error ? observeError.message : "");
      redirect(refundPage(eventId, orderId, "error=COMP_REFUND_STRIPE_UNCONFIRMED"));
    }
    refresh(eventId, orderId);
    redirect(refundPage(eventId, orderId, `success=refund_${refund.status ?? "pending"}`));
  } catch (error) {
    if (isRedirectError(error)) throw error;
    const code = error instanceof CompetitionRefundError ? error.code : "COMP_REFUND_FAILED";
    redirect(refundPage(eventId, orderId, `error=${code}`));
  }
}

export async function attributeCompetitionRefundAction(formData: FormData): Promise<void> {
  const eventId = text(formData, "eventId");
  const orderId = text(formData, "orderId");
  const refundId = text(formData, "refundId");
  if (!UUID.test(eventId) || !UUID.test(orderId) || !UUID.test(refundId)) redirect("/app/events");
  try {
    const lines = readRefundLines(formData);
    const supabase = await createClient();
    const { error } = await supabase.rpc("attribute_competition_refund", { p_refund_id: refundId, p_lines: lines });
    if (error) redirect(refundPage(eventId, orderId, `error=${refundErrorCode(error.message)}`));
    refresh(eventId, orderId);
    redirect(refundPage(eventId, orderId, "success=refund_attributed"));
  } catch (error) {
    if (isRedirectError(error)) throw error;
    redirect(refundPage(eventId, orderId, "error=COMP_REFUND_LINE_INVALID"));
  }
}

export async function resolveCompetitionRefundScopeAction(formData: FormData): Promise<void> {
  const eventId = text(formData, "eventId");
  const orderId = text(formData, "orderId");
  const scopeId = text(formData, "scopeId");
  if (!UUID.test(eventId) || !UUID.test(orderId) || !UUID.test(scopeId)) redirect("/app/events");
  const supabase = await createClient();
  const { error } = await supabase.rpc("resolve_competition_refund_scope", {
    p_scope_id: scopeId, p_resolution: text(formData, "resolution"), p_note: text(formData, "note"),
  });
  if (error) redirect(refundPage(eventId, orderId, `error=${refundErrorCode(error.message)}`));
  refresh(eventId, orderId);
  redirect(refundPage(eventId, orderId, "success=scope_resolved"));
}

export async function resolveCompetitionRefundExceptionAction(formData: FormData): Promise<void> {
  const eventId = text(formData, "eventId");
  const orderId = text(formData, "orderId");
  const exceptionId = text(formData, "exceptionId");
  if (!UUID.test(eventId) || !UUID.test(orderId) || !UUID.test(exceptionId)) redirect("/app/events");
  const supabase = await createClient();
  const { error } = await supabase.rpc("resolve_competition_refund_exception", {
    p_exception_id: exceptionId, p_note: text(formData, "note"),
  });
  if (error) redirect(refundPage(eventId, orderId, `error=${refundErrorCode(error.message)}`));
  refresh(eventId, orderId);
  redirect(refundPage(eventId, orderId, "success=exception_resolved"));
}
