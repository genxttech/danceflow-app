import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { getStripe } from "@/lib/payments/stripe";
import {
  QUICK_CHARGE_CATEGORY_LABELS as CATEGORY_LABELS,
  cleanText as clean,
  isUuid,
  parseQuickChargeAmount as parseAmount,
  startQuickCharge,
} from "@/lib/payments/terminal-quick-charge";

function canCollectTerminal(
  role: string | null | undefined,
  isPlatformAdmin: boolean,
) {
  if (isPlatformAdmin) return true;
  return ["studio_owner", "studio_admin", "front_desk"].includes(role ?? "");
}

function jsonError(message: string, status = 400) {
  return NextResponse.json({ ok: false, error: message }, { status });
}

async function getRequestJson(request: NextRequest) {
  try {
    return (await request.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function POST(request: NextRequest) {
  try {
    const userSupabase = await createClient();
    const supabase = createAdminClient();
    const stripe = getStripe();

    const {
      data: { user },
      error: authError,
    } = await userSupabase.auth.getUser();

    if (authError || !user) {
      return jsonError("Please sign in before collecting a payment.", 401);
    }

    const context = await getCurrentStudioContext();
    if (!context?.studioId) {
      return jsonError("No studio workspace is selected.", 400);
    }

    if (!canCollectTerminal(context.studioRole, context.isPlatformAdmin)) {
      return jsonError(
        "You do not have permission to collect in-person payments.",
        403,
      );
    }

    const body = await getRequestJson(request);
    const category = clean(body.category, 80) || "other";
    const amount = parseAmount(body.amount);
    const guestName = clean(body.guestName, 120) || null;
    const notes = clean(body.notes, 500) || null;
    const requestedReaderId = clean(body.readerId, 36);
    const existingPaymentId = clean(body.existingPaymentId, 36);
    const commerceOrderId = clean(body.commerceOrderId, 36);
    const clientRequestId = clean(body.clientRequestId, 64);

    if (requestedReaderId && !isUuid(requestedReaderId)) {
      return jsonError("Select a valid Stripe reader.");
    }

    if (
      (existingPaymentId && !isUuid(existingPaymentId)) ||
      (commerceOrderId && !isUuid(commerceOrderId))
    ) {
      return jsonError("The prepared commerce order is invalid.");
    }

    if (Boolean(existingPaymentId) !== Boolean(commerceOrderId)) {
      return jsonError(
        "Commerce order and payment must be supplied together.",
      );
    }

    let preparedPayment:
      | {
          id: string;
          amount: number | string;
          status: string | null;
          notes: string | null;
        }
      | null = null;
    let preparedOrder:
      | {
          id: string;
          total: number | string;
          status: string;
          payment_status: string;
        }
      | null = null;

    if (existingPaymentId && commerceOrderId) {
      const [
        { data: paymentRow, error: paymentLookupError },
        { data: orderRow, error: orderLookupError },
      ] = await Promise.all([
        supabase
          .from("payments")
          .select("id, amount, status, notes")
          .eq("id", existingPaymentId)
          .eq("studio_id", context.studioId)
          .maybeSingle(),
        supabase
          .from("commerce_orders")
          .select("id, total, status, payment_status")
          .eq("id", commerceOrderId)
          .eq("studio_id", context.studioId)
          .eq("payment_id", existingPaymentId)
          .maybeSingle(),
      ]);

      if (paymentLookupError || orderLookupError || !paymentRow || !orderRow) {
        return jsonError("Prepared commerce order was not found.", 404);
      }

      if (
        paymentRow.status !== "pending" ||
        orderRow.status !== "open" ||
        orderRow.payment_status !== "pending"
      ) {
        return jsonError(
          "This commerce order is no longer waiting for a card payment.",
          409,
        );
      }

      preparedPayment = paymentRow;
      preparedOrder = orderRow;
    } else {
      if (!Object.keys(CATEGORY_LABELS).includes(category)) {
        return jsonError("Choose a valid quick charge category.");
      }

      if (amount == null || amount <= 0) {
        return jsonError("Enter a valid payment amount.");
      }
    }

    const { data: studio, error: studioError } = await supabase
      .from("studios")
      .select("id, name, stripe_connected_account_id")
      .eq("id", context.studioId)
      .single();

    if (studioError || !studio) {
      return jsonError("Studio workspace could not be loaded.", 404);
    }

    const connectedAccountId = clean(studio.stripe_connected_account_id);
    if (!connectedAccountId) {
      return jsonError("Stripe is not connected for this studio.");
    }

    const connectedAccount = await stripe.accounts.retrieve(connectedAccountId);
    if (
      !connectedAccount.charges_enabled ||
      connectedAccount.capabilities?.card_payments !== "active"
    ) {
      return jsonError(
        "Stripe is not ready for in-person card payments yet. Finish Stripe onboarding before using Quick Charge.",
        409,
      );
    }

    let readerQuery = supabase
      .from("stripe_terminal_readers")
      .select(
        "id, terminal_location_id, stripe_reader_id, stripe_location_id, label, status, active",
      )
      .eq("studio_id", studio.id)
      .eq("active", true);

    if (requestedReaderId) {
      readerQuery = readerQuery.eq("id", requestedReaderId);
    }

    const { data: readers, error: readerError } = await readerQuery
      .order("updated_at", { ascending: false })
      .limit(5);

    if (readerError) {
      return jsonError(`Reader lookup failed: ${readerError.message}`);
    }

    const reader =
      (readers ?? []).find((row) => row.status === "online") ?? null;

    if (!reader?.stripe_reader_id) {
      return jsonError(
        "No online Stripe reader is available. Refresh or reconnect the reader before starting Quick Charge.",
        409,
      );
    }

    const result = await startQuickCharge({
      supabase,
      stripe,
      studio: { id: studio.id, stripe_connected_account_id: connectedAccountId },
      reader: {
        id: reader.id,
        label: reader.label,
        terminal_location_id: reader.terminal_location_id,
        stripe_reader_id: reader.stripe_reader_id,
        stripe_location_id: reader.stripe_location_id,
      },
      userId: user.id,
      clientRequestId,
      idempotencyNamespace: "quick-charge",
      input:
        preparedPayment && preparedOrder
          ? {
              kind: "commerce_order",
              payment: { id: preparedPayment.id, notes: preparedPayment.notes },
              order: { id: preparedOrder.id, total: preparedOrder.total },
            }
          : {
              kind: "ad_hoc",
              category,
              amount: Number(amount ?? 0),
              guestName,
              notes,
            },
    });

    if (!result.ok) {
      return jsonError(result.error, result.status);
    }

    return NextResponse.json(result);
  } catch (error) {
    console.error("Quick charge start failed", error);
    return jsonError(
      error instanceof Error
        ? error.message
        : "Quick charge could not be started.",
      500,
    );
  }
}
