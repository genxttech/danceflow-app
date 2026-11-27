import { createAdminClient } from "@/lib/supabase/admin";
import { getCronAuthFailure } from "@/lib/security/cron";
import { getStripe } from "@/lib/payments/stripe";
import { runCompetitionSettlementRepair, settlementRepairEnabled } from "@/lib/competition/settlementRepair";
import { syncFeeDetailsForPaymentIntent } from "@/lib/payments/stripeFeeSync";
import { safeQueuePaidEventCartOrderConfirmation } from "@/lib/events/settlementSideEffects";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * CF1 settlement repair for a MISSED competition payment webhook: reads Stripe's own record (on the order's bound connected account) for
 * pending competition orders that already have a bound Checkout Session, and finalizes through the same path as the webhook only when Stripe
 * shows the session complete and paid. Never releases or expires anything. NOT registered in vercel.json: nothing calls it until a release
 * owner adds it deliberately. Answered 404 unless COMPETITION_SETTLEMENT_REPAIR=on; then CRON_SECRET is required. Counts only in the response.
 */
async function run(request: Request) {
  if (!settlementRepairEnabled()) return new Response(null, { status: 404 });
  const authFailure = getCronAuthFailure(request);
  if (authFailure) return authFailure;
  const headers = { "Cache-Control": "no-store" };
  try {
    const admin = createAdminClient();
    const stripe = getStripe();
    const summary = await runCompetitionSettlementRepair(admin, stripe, {
      // The same follow-ups the webhook performs after a finalized competition payment.
      onFinalized: async ({ orderId, paymentIntentId, accountId }) => {
        if (paymentIntentId) await syncFeeDetailsForPaymentIntent(admin, stripe, paymentIntentId, accountId);
        await safeQueuePaidEventCartOrderConfirmation({ supabase: admin, orderId });
      },
    });
    return Response.json({ ok: true, ...summary }, { headers });
  } catch {
    console.error("comp_settlement_repair_failed");
    return Response.json({ ok: false }, { status: 500, headers });
  }
}

export async function GET(request: Request) {
  return run(request);
}

export async function POST(request: Request) {
  return run(request);
}
