import type Stripe from "stripe";
import type { createAdminClient } from "@/lib/supabase/admin";

type AdminClient = ReturnType<typeof createAdminClient>;

const POSTGRES_UNIQUE_VIOLATION = "23505";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Any terminal_payment_sessions status that means "a Stripe PaymentIntent is
// still live for this attempt" — a retry that lands here must not create a
// second PaymentIntent, it must be handed the same session back.
const OPEN_SESSION_STATUSES = [
  "created",
  "processing",
  "requires_payment_method",
  "requires_confirmation",
];

export const QUICK_CHARGE_CATEGORY_LABELS: Record<string, string> = {
  group_class: "Group Class",
  social_party: "Social Party",
  practice_party: "Practice Party",
  floor_fee: "Floor Fee",
  private_lesson_ad_hoc: "Private Lesson",
  merchandise: "Merchandise",
  other: "Other",
};

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

function isStrippableCodePoint(code: number): boolean {
  if (code <= 0x08) return true;
  if (code === 0x0b || code === 0x0c) return true;
  if (code >= 0x0e && code <= 0x1f) return true;
  if (code >= 0x7f && code <= 0x9f) return true;
  if (code >= 0x200b && code <= 0x200d) return true;
  if (code === 0xfeff) return true;
  return false;
}

export function cleanText(value: unknown, maxLength = 500): string {
  if (typeof value !== "string") return "";
  let out = "";
  for (const ch of value) {
    if (!isStrippableCodePoint(ch.codePointAt(0) ?? 0)) out += ch;
  }
  return out.trim().slice(0, maxLength);
}

export function parseQuickChargeAmount(value: unknown): number | null {
  const raw = String(value ?? "").trim();
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 100000) return null;
  return Math.round(parsed * 100) / 100;
}

export interface QuickChargeReader {
  id: string;
  label: string | null;
  terminal_location_id: string | null;
  stripe_reader_id: string;
  stripe_location_id: string | null;
}

export interface QuickChargeStudio {
  id: string;
  stripe_connected_account_id: string;
}

export type StartQuickChargeInput =
  | {
      kind: "ad_hoc";
      category: string;
      amount: number;
      guestName: string | null;
      notes: string | null;
    }
  | {
      kind: "commerce_order";
      payment: { id: string; notes: string | null };
      order: { id: string; total: number | string };
    };

export interface StartQuickChargeParams {
  supabase: AdminClient;
  stripe: Stripe;
  studio: QuickChargeStudio;
  reader: QuickChargeReader;
  userId: string;
  /** Stable per-attempt id from the client. Persisted across the caller's
   * retries of the *same* logical charge; a genuinely new charge gets a new
   * one. Not used for the commerce_order branch, which already has a stable
   * id (the pre-existing payment row). */
  clientRequestId: string;
  /** Namespaces the Stripe idempotency key and payment_channel bookkeeping
   * per calling route (quick-charge vs quick-pay) for traceability. Both
   * currently emit the same metadata.source so webhook fulfillment is
   * unaffected either way. */
  idempotencyNamespace: string;
  input: StartQuickChargeInput;
}

export type StartQuickChargeResult =
  | {
      ok: true;
      paymentId: string;
      sessionId: string;
      status: string;
      amount: number;
      category: string;
      categoryLabel: string;
      readerLabel: string;
    }
  | { ok: false; error: string; status: number };

interface ResolvedPayment {
  id: string;
  status: string;
  amount: number | string;
  quick_charge_category: string | null;
}

async function findLatestSession(
  supabase: AdminClient,
  studioId: string,
  paymentId: string,
) {
  return supabase
    .from("terminal_payment_sessions")
    .select("id, status")
    .eq("studio_id", studioId)
    .eq("payment_id", paymentId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
}

/**
 * Number of terminal_payment_sessions rows already recorded for this
 * payment, across every status. Used to derive an attempt-numbered Stripe
 * idempotency key (e.g. `<namespace>:<paymentId>:<n>`) so a raw network
 * retry of one sub-attempt is idempotent at Stripe's layer, while a
 * genuinely new sub-attempt after a failed one still gets a fresh key
 * instead of Stripe replaying a stale canceled PaymentIntent.
 */
export async function countTerminalPaymentSessions(
  supabase: AdminClient,
  studioId: string,
  paymentId: string,
) {
  const { count, error } = await supabase
    .from("terminal_payment_sessions")
    .select("id", { count: "exact", head: true })
    .eq("studio_id", studioId)
    .eq("payment_id", paymentId);
  if (error) return 0;
  return count ?? 0;
}

/**
 * Resolves the `payments` row a request should operate against, given the
 * caller's clientRequestId. Reuses an existing row on retry instead of
 * inserting a duplicate; a 23505 on the unique (studio_id, client_request_id)
 * index (src/lib/supabase/migrations/20260809130100_payments_client_request_id_dedupe_index_concurrent.sql)
 * means a concurrent request already won the race, so we re-select rather
 * than error.
 */
async function resolveAdHocPayment(params: {
  supabase: AdminClient;
  studio: QuickChargeStudio;
  userId: string;
  clientRequestId: string;
  category: string;
  amount: number;
  guestName: string | null;
  notes: string | null;
}): Promise<{ payment: ResolvedPayment | null; error: string | null }> {
  const { supabase, studio, userId, clientRequestId, category, amount, guestName, notes } = params;

  const existing = await supabase
    .from("payments")
    .select("id, status, amount, quick_charge_category")
    .eq("studio_id", studio.id)
    .eq("client_request_id", clientRequestId)
    .maybeSingle();

  if (existing.error) {
    return { payment: null, error: existing.error.message };
  }
  if (existing.data) {
    return { payment: existing.data, error: null };
  }

  const categoryLabel = QUICK_CHARGE_CATEGORY_LABELS[category] ?? QUICK_CHARGE_CATEGORY_LABELS.other;
  const noteParts = [`Quick Charge: ${categoryLabel}`, guestName ? `Guest: ${guestName}` : null, notes].filter(
    Boolean,
  );

  const inserted = await supabase
    .from("payments")
    .insert({
      studio_id: studio.id,
      client_id: null,
      amount,
      payment_method: "card",
      status: "pending",
      notes: noteParts.join(" | ") || null,
      paid_at: null,
      created_by: userId,
      payment_type: "other",
      source: "stripe",
      payment_channel: "terminal",
      currency: "usd",
      quick_charge_category: category,
      guest_name: guestName,
      client_request_id: clientRequestId,
    })
    .select("id, status, amount, quick_charge_category")
    .single();

  if (!inserted.error) {
    return { payment: inserted.data, error: null };
  }

  if (inserted.error.code === POSTGRES_UNIQUE_VIOLATION) {
    const winner = await supabase
      .from("payments")
      .select("id, status, amount, quick_charge_category")
      .eq("studio_id", studio.id)
      .eq("client_request_id", clientRequestId)
      .maybeSingle();
    if (winner.error || !winner.data) {
      return { payment: null, error: winner.error?.message ?? "Duplicate charge attempt could not be resolved." };
    }
    return { payment: winner.data, error: null };
  }

  return { payment: null, error: inserted.error.message };
}

function readerLabelOf(reader: QuickChargeReader) {
  return reader.label ?? "Stripe reader";
}

export async function startQuickCharge(params: StartQuickChargeParams): Promise<StartQuickChargeResult> {
  const { supabase, stripe, studio, reader, userId, clientRequestId, idempotencyNamespace, input } = params;

  if (!clientRequestId || !isUuid(clientRequestId)) {
    return { ok: false, error: "A valid client request id is required.", status: 400 };
  }

  let payment: ResolvedPayment;
  let resolvedAmount: number;
  let category: string;
  let categoryLabel: string;
  let metadataQuickChargeCategory: string;
  let commerceOrderId: string | null = null;

  if (input.kind === "commerce_order") {
    payment = { id: input.payment.id, status: "pending", amount: input.order.total, quick_charge_category: null };
    resolvedAmount = Number(input.order.total ?? 0);
    category = "commerce_order";
    categoryLabel = "Retail order";
    metadataQuickChargeCategory = "";
    commerceOrderId = input.order.id;
  } else {
    resolvedAmount = input.amount;
    category = input.category;
    categoryLabel = QUICK_CHARGE_CATEGORY_LABELS[category] ?? QUICK_CHARGE_CATEGORY_LABELS.other;
    metadataQuickChargeCategory = category;

    const resolved = await resolveAdHocPayment({
      supabase,
      studio,
      userId,
      clientRequestId,
      category,
      amount: input.amount,
      guestName: input.guestName,
      notes: input.notes,
    });

    if (resolved.error || !resolved.payment) {
      return { ok: false, error: resolved.error ?? "Payment record could not be created.", status: 500 };
    }

    payment = resolved.payment;

    // A reused clientRequestId must describe the same logical charge. This
    // is not reachable through the shipped clients (they scope the id to a
    // signature that includes amount/category), but the server must not
    // trust that invariant blindly: without this check, reusing an id with
    // a different amount would silently report the caller's *requested*
    // amount instead of what was actually stored/charged, and could create
    // a second Stripe sub-attempt at a different amount than payments.amount
    // still records.
    const storedAmountCents = Math.round(Number(payment.amount) * 100);
    const requestedAmountCents = Math.round(resolvedAmount * 100);
    if (storedAmountCents !== requestedAmountCents || payment.quick_charge_category !== category) {
      return {
        ok: false,
        error: "This request has already been used for a different charge amount or category.",
        status: 409,
      };
    }
  }

  const latestSession = await findLatestSession(supabase, studio.id, payment.id);
  if (latestSession.error) {
    return { ok: false, error: `Terminal session lookup failed: ${latestSession.error.message}`, status: 500 };
  }

  const shouldReplay =
    payment.status === "paid" ||
    (latestSession.data ? OPEN_SESSION_STATUSES.includes(latestSession.data.status) : false);

  if (shouldReplay && latestSession.data) {
    return {
      ok: true,
      paymentId: payment.id,
      sessionId: latestSession.data.id,
      status: latestSession.data.status,
      amount: resolvedAmount,
      category,
      categoryLabel,
      readerLabel: readerLabelOf(reader),
    };
  }

  const amountCents = Math.round(resolvedAmount * 100);
  const attemptNumber = await countTerminalPaymentSessions(supabase, studio.id, payment.id);
  const idempotencyKey = `${idempotencyNamespace}:${payment.id}:${attemptNumber}`;

  const paymentIntent = await stripe.paymentIntents.create(
    {
      amount: amountCents,
      currency: "usd",
      payment_method_types: ["card_present"],
      capture_method: "automatic",
      metadata: {
        source: "danceflow_terminal_quick_charge",
        studioId: studio.id,
        paymentId: payment.id,
        quickChargeCategory: metadataQuickChargeCategory,
        guestName: input.kind === "ad_hoc" ? (input.guestName ?? "") : "",
        commerceOrderId: commerceOrderId ?? "",
      },
    },
    { stripeAccount: studio.stripe_connected_account_id, idempotencyKey },
  );

  const { data: session, error: sessionError } = await supabase
    .from("terminal_payment_sessions")
    .insert({
      studio_id: studio.id,
      client_id: null,
      payment_id: payment.id,
      terminal_reader_id: reader.id,
      terminal_location_id: reader.terminal_location_id,
      source_type: input.kind === "commerce_order" ? "commerce_order" : "quick_charge",
      source_id: commerceOrderId ?? payment.id,
      amount_cents: amountCents,
      currency: "usd",
      stripe_account_id: studio.stripe_connected_account_id,
      stripe_payment_intent_id: paymentIntent.id,
      status: paymentIntent.status ?? "created",
      metadata: {
        reader_label: reader.label ?? null,
        quick_charge_category: input.kind === "commerce_order" ? null : category,
        guest_name: input.kind === "ad_hoc" ? input.guestName : null,
        commerce_order_id: commerceOrderId,
      },
      created_by: userId,
    })
    .select("id")
    .single();

  if (sessionError || !session) {
    // A concurrent request can reach this same point for the same
    // clientRequestId (e.g. a double-click that outraces the caller's own
    // debounce). Stripe's idempotency key already made both calls above
    // return the *same* paymentIntent.id, so the loser here is not a
    // genuine failure — terminal_payment_sessions.stripe_payment_intent_id
    // is globally unique, and the other request already recorded the
    // session for this PaymentIntent. Replay its session instead of
    // cancelling a PaymentIntent the winner is relying on.
    if (sessionError?.code === POSTGRES_UNIQUE_VIOLATION) {
      const winner = await supabase
        .from("terminal_payment_sessions")
        .select("id, status")
        .eq("studio_id", studio.id)
        .eq("stripe_payment_intent_id", paymentIntent.id)
        .maybeSingle();

      if (!winner.error && winner.data) {
        return {
          ok: true,
          paymentId: payment.id,
          sessionId: winner.data.id,
          status: winner.data.status,
          amount: resolvedAmount,
          category,
          categoryLabel,
          readerLabel: readerLabelOf(reader),
        };
      }
      // Fall through to the genuine-failure path below if the winning row
      // couldn't be found (e.g. it was somehow removed) — safer to fail
      // loudly than to report success with no session to attach to.
    }

    // Genuine session-insert failure (not a concurrent-winner race). If the
    // *cancel* or the subsequent DB write below itself fails partway
    // through — a transient DB error landing exactly between a successful
    // Stripe create and this cleanup — a retry reusing this clientRequestId
    // recomputes the same attemptNumber (no session row was ever recorded)
    // and therefore the same Stripe idempotency key, which could replay the
    // now-cancelled PaymentIntent instead of minting a fresh one. This is a
    // rare compound failure (DB write failure immediately after a Stripe
    // success) and is a documented P1 follow-up, not fixed here.
    await stripe.paymentIntents
      .cancel(paymentIntent.id, {}, { stripeAccount: studio.stripe_connected_account_id })
      .catch(() => null);
    await supabase.from("payments").update({ status: "failed" }).eq("id", payment.id).eq("studio_id", studio.id);
    return {
      ok: false,
      error: `Terminal session could not be created: ${sessionError?.message ?? "Unknown error"}`,
      status: 500,
    };
  }

  await supabase
    .from("payments")
    .update({
      terminal_payment_session_id: session.id,
      stripe_terminal_reader_id: reader.stripe_reader_id,
      stripe_terminal_location_id: reader.stripe_location_id,
      stripe_payment_intent_id: paymentIntent.id,
    })
    .eq("id", payment.id)
    .eq("studio_id", studio.id);

  try {
    await stripe.terminal.readers.processPaymentIntent(
      reader.stripe_reader_id,
      { payment_intent: paymentIntent.id },
      { stripeAccount: studio.stripe_connected_account_id },
    );
  } catch (processError) {
    const message =
      processError instanceof Error ? processError.message : "Stripe could not send the payment to the selected reader.";
    const nowIso = new Date().toISOString();

    await stripe.paymentIntents
      .cancel(paymentIntent.id, {}, { stripeAccount: studio.stripe_connected_account_id })
      .catch(() => null);

    await Promise.all([
      supabase
        .from("terminal_payment_sessions")
        .update({ status: "failed", error_message: message, completed_at: nowIso, updated_at: nowIso })
        .eq("id", session.id),
      supabase.from("payments").update({ status: "failed" }).eq("id", payment.id).eq("studio_id", studio.id),
    ]);

    console.error("Quick charge reader processing failed", processError);
    return { ok: false, error: message, status: 409 };
  }

  const nowIso = new Date().toISOString();
  await supabase
    .from("terminal_payment_sessions")
    .update({ status: "processing", updated_at: nowIso })
    .eq("id", session.id);

  return {
    ok: true,
    paymentId: payment.id,
    sessionId: session.id,
    status: "processing",
    amount: resolvedAmount,
    category,
    categoryLabel,
    readerLabel: readerLabelOf(reader),
  };
}
