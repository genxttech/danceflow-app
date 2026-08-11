import { createAdminClient } from "@/lib/supabase/admin";
import type { CreatedRecordRefs } from "@/lib/synthetic/types";
import {
  assertRecordWasCreatedByThisRun,
} from "@/lib/synthetic/guards";
import {
  assertTestCondition,
  requireSession,
  SuiteAssertionError,
  type SuiteCleanupResult,
  type SuiteContext,
} from "@/lib/synthetic/suites/contract";

/**
 * SYN-PAY-READ-001 -- Payments (non-capturing / read-only)
 *
 * Catalog assertion: "Payment routes reject unauthorized/invalid/
 * idempotency misuse safely."
 *
 * This suite NEVER imports or calls the Stripe SDK -- not "validates
 * inputs before Stripe," but structurally incapable of reaching Stripe at
 * all, since there is no Stripe import anywhere in this file. That is the
 * mechanism that satisfies "must remain non-capturing/read-only and must
 * not create a real payment," not a runtime check that could have a bug in
 * it.
 *
 * It runs as the synthetic *student* identity specifically -- the lowest-
 * privilege role, with no terminal-payment authority -- and asserts three
 * authorization/isolation properties at the RLS and RPC layer:
 *   1. No cross-tenant payment data is visible to this session.
 *   2. The privileged deduct_package_credit_for_appointment RPC rejects a
 *      call referencing an appointment that doesn't exist / doesn't
 *      belong to this tenant, rather than silently doing nothing harmful
 *      or throwing an unhandled error.
 *   3. A direct write to the payments table is rejected for this
 *      low-privilege identity.
 *
 * Known Phase 1 limitation (see the implementation report): this probes
 * authorization at the database/RLS layer, not by sending intentionally
 * invalid requests to the actual HTTP payment routes
 * (quick-charge/start, quick-pay/start, terminal/payments/start). Doing
 * the latter safely requires replicating this app's Supabase SSR cookie
 * format from an external script, which was deferred rather than
 * approximated. Ethan/Daniel should weigh in on whether Phase 2 needs
 * true HTTP-route-level coverage in addition to this.
 */
export async function runPaymentsReadSuite(ctx: SuiteContext): Promise<CreatedRecordRefs> {
  const session = requireSession(ctx, "student");

  // 1. Tenant isolation on reads: every payments row visible to this
  // session must belong to the synthetic tenant. There is no reliable
  // "known other studio's payment id" to probe against directly, so this
  // asserts the always-true invariant instead: zero leakage across
  // whatever this query does return.
  const { data: visiblePayments, error: paymentsError } = await session.client
    .from("payments")
    .select("studio_id")
    .limit(50);
  assertTestCondition(!paymentsError, `Payments visibility query failed unexpectedly: ${paymentsError?.message}`);
  assertTestCondition(
    (visiblePayments ?? []).every((row) => row.studio_id === session.studioId),
    "Synthetic student session could see a payments row outside the synthetic tenant.",
  );

  // 2. Privileged RPC misuse: calling the atomic deduction RPC with a
  // nonexistent appointment id must not succeed.
  const bogusAppointmentId = crypto.randomUUID();
  const bogusPackageId = crypto.randomUUID();
  const { data: rpcResult, error: rpcError } = await session.client.rpc(
    "deduct_package_credit_for_appointment",
    {
      p_studio_id: session.studioId,
      p_client_id: crypto.randomUUID(),
      p_client_package_id: bogusPackageId,
      p_appointment_id: bogusAppointmentId,
      p_usage_type: "private_lesson",
    },
  );
  const rpcRow = Array.isArray(rpcResult) ? rpcResult[0] : rpcResult;
  const rpcRejectedCleanly = Boolean(rpcError) || rpcRow?.found_item === false;
  assertTestCondition(
    rpcRejectedCleanly,
    "Deduction RPC did not safely reject a nonexistent/unauthorized appointment reference.",
  );

  // 3. Unauthorized write: a low-privilege student identity attempting a
  // direct payments insert must be rejected by RLS. If it unexpectedly
  // succeeds -- exactly the regression this probe exists to catch -- the
  // inserted row's id is captured and reported via SuiteAssertionError's
  // partialRecordRefs *before* the failure propagates, so the runner still
  // records it in created_record_refs and still runs cleanup on it. A
  // security regression probe must never itself leave untracked, unremoved
  // state behind, especially not on the exact failure path it exists to
  // detect.
  const { data: insertedPayment, error: insertError } = await session.client
    .from("payments")
    .insert({
      studio_id: session.studioId,
      amount: 0.01,
      payment_method: "card",
      status: "pending",
      source: "manual",
      payment_channel: "manual",
      notes: "SYN-PAY-READ-001 unauthorized-write probe -- should be rejected by RLS, never committed.",
    })
    .select("id")
    .maybeSingle();

  if (!insertError && insertedPayment?.id) {
    throw new SuiteAssertionError(
      "Unauthorized synthetic-student write to payments was NOT rejected -- this would be a serious authorization gap.",
      { payments: [insertedPayment.id as string] },
    );
  }
  assertTestCondition(
    Boolean(insertError),
    "Unauthorized synthetic-student write to payments was NOT rejected, and no row id was returned to record/clean up.",
  );

  // No records created; nothing for cleanup to do.
  return {};
}

export async function cleanupPaymentsReadSuite(
  ctx: SuiteContext,
  createdRecordRefs: CreatedRecordRefs,
): Promise<SuiteCleanupResult> {
  const paymentIds = createdRecordRefs["payments"] ?? [];
  if (paymentIds.length === 0) {
    return { status: "not_required", error: null };
  }

  // Reached only if the unauthorized-write probe above unexpectedly
  // succeeded -- i.e. RLS failed to block it, which is exactly the
  // regression this suite exists to detect. Deliberately uses the
  // service-role admin client here, not the low-privilege student
  // session: relying on the same RLS that just failed to also permit
  // cleanup would be circular, and this is a narrow, server-side-only
  // incident-cleanup operation, not a business-flow write -- the kind of
  // specific exception PRODUCTION-SYNTHETIC-TESTING.md safety requirement
  // #4 anticipates. This is a second service-role use site beyond the
  // audit table and should be confirmed explicitly by Maya, not assumed
  // pre-approved by the original "audit table only" review.
  const admin = createAdminClient();

  try {
    for (const paymentId of paymentIds) {
      assertRecordWasCreatedByThisRun(createdRecordRefs, "payments", paymentId);
      const { error } = await admin
        .from("payments")
        .delete()
        .eq("id", paymentId)
        .eq("studio_id", ctx.config.studioId);
      if (error) {
        return {
          status: "failed",
          error: `Failed to remove unauthorized-write probe row ${paymentId}: ${error.message}`,
        };
      }
    }
    return { status: "completed", error: null };
  } catch (error) {
    return { status: "failed", error: error instanceof Error ? error.message : "Unknown cleanup error" };
  }
}
