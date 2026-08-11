import { syntheticTag } from "@/lib/synthetic/runId";
import type { CreatedRecordRefs } from "@/lib/synthetic/types";
import {
  addRef,
  assertTestCondition,
  requireSession,
  type SuiteCleanupResult,
  type SuiteContext,
} from "@/lib/synthetic/suites/contract";
import {
  archiveSyntheticClientFixture,
  createSyntheticClientFixture,
} from "@/lib/synthetic/suites/shared";
import { assertRecordWasCreatedByThisRun } from "@/lib/synthetic/guards";

/**
 * SYN-ENT-001 -- Membership / Package entitlement
 *
 * Catalog assertion: "Entitlement consumption matches booking result."
 *
 * Steps: establish/reset synthetic entitlement; exercise eligible
 * booking/consumption; verify remaining entitlement; reverse/cleanup where
 * business rules support it.
 *
 * This suite deliberately calls the real `deduct_package_credit_for_appointment`
 * RPC (src/lib/supabase/migrations/20260809120000_atomic_package_credit_deduction.sql)
 * -- the same atomic, idempotent, SECURITY DEFINER function the
 * application's own attendance flow calls -- rather than reimplementing
 * the deduction logic. The RPC independently re-verifies the caller's
 * studio role and that the appointment/client/package all belong to the
 * supplied studio_id, so this also exercises real cross-tenant
 * authorization on the RPC itself.
 */
export async function runEntitlementSuite(ctx: SuiteContext): Promise<CreatedRecordRefs> {
  const session = requireSession(ctx, "owner");
  let refs: CreatedRecordRefs = {};

  const clientFixture = await createSyntheticClientFixture(session, ctx.runId, refs);
  refs = clientFixture.refs;

  // Establish entitlement: one package with exactly one private_lesson
  // credit, so deduction can be verified precisely (1 -> 0).
  const { data: pkg, error: pkgError } = await session.client
    .from("client_packages")
    .insert({
      studio_id: session.studioId,
      client_id: clientFixture.clientId,
      name_snapshot: `Synthetic Test Package ${syntheticTag(ctx.runId)}`,
      active: true,
    })
    .select("id, studio_id")
    .single();
  assertTestCondition(!pkgError && pkg, `Synthetic package creation failed: ${pkgError?.message ?? "no row returned"}`);
  assertTestCondition(pkg!.studio_id === session.studioId, "Synthetic package was created outside the synthetic tenant.");
  refs = addRef(refs, "client_packages", pkg!.id as string);

  const { data: pkgItem, error: pkgItemError } = await session.client
    .from("client_package_items")
    .insert({
      studio_id: session.studioId,
      client_package_id: pkg!.id,
      usage_type: "private_lesson",
      quantity_total: 1,
      quantity_used: 0,
      quantity_remaining: 1,
      is_unlimited: false,
    })
    .select("id, quantity_remaining")
    .single();
  assertTestCondition(!pkgItemError && pkgItem, `Synthetic package item creation failed: ${pkgItemError?.message ?? "no row returned"}`);
  assertTestCondition(pkgItem!.quantity_remaining === 1, "Synthetic package item did not start with 1 remaining credit.");
  refs = addRef(refs, "client_package_items", pkgItem!.id as string);

  // Book an appointment against this package.
  const startsAt = new Date(Date.now() - 60 * 60 * 1000); // in the past, as if already occurred
  const endsAt = new Date(startsAt.getTime() + 30 * 60 * 1000);
  const { data: appointment, error: apptError } = await session.client
    .from("appointments")
    .insert({
      studio_id: session.studioId,
      client_id: clientFixture.clientId,
      appointment_type: "private_lesson",
      title: "Synthetic entitlement test booking",
      notes: `${syntheticTag(ctx.runId)} Created by the production synthetic testing harness.`,
      starts_at: startsAt.toISOString(),
      ends_at: endsAt.toISOString(),
      billing_type: "package_credit",
      client_package_id: pkg!.id,
    })
    .select("id, studio_id")
    .single();
  assertTestCondition(!apptError && appointment, `Synthetic entitlement booking failed: ${apptError?.message ?? "no row returned"}`);
  assertTestCondition(appointment!.studio_id === session.studioId, "Synthetic entitlement appointment was created outside the synthetic tenant.");
  refs = addRef(refs, "appointments", appointment!.id as string);

  // Exercise consumption via the real atomic deduction RPC.
  const { data: rpcResult, error: rpcError } = await session.client.rpc(
    "deduct_package_credit_for_appointment",
    {
      p_studio_id: session.studioId,
      p_client_id: clientFixture.clientId,
      p_client_package_id: pkg!.id,
      p_appointment_id: appointment!.id,
      p_usage_type: "private_lesson",
    },
  );
  assertTestCondition(!rpcError, `deduct_package_credit_for_appointment RPC failed: ${rpcError?.message}`);
  const rpcRow = Array.isArray(rpcResult) ? rpcResult[0] : rpcResult;
  assertTestCondition(rpcRow?.found_item === true, "Deduction RPC did not find the synthetic package item.");
  assertTestCondition(Number(rpcRow?.quantity_remaining) === 0, `Deduction RPC left unexpected remaining balance: ${rpcRow?.quantity_remaining}`);

  // Verify remaining entitlement directly against the table too, not just
  // the RPC's own return value.
  const { data: afterDeduction, error: afterDeductionError } = await session.client
    .from("client_package_items")
    .select("quantity_used, quantity_remaining")
    .eq("id", pkgItem!.id)
    .maybeSingle();
  assertTestCondition(
    !afterDeductionError && afterDeduction?.quantity_remaining === 0 && afterDeduction?.quantity_used === 1,
    `Package item balance after deduction did not match expected 0 remaining / 1 used (got remaining=${afterDeduction?.quantity_remaining}, used=${afterDeduction?.quantity_used}).`,
  );

  const { data: ledgerRow, error: ledgerError } = await session.client
    .from("lesson_transactions")
    .select("id, transaction_type")
    .eq("appointment_id", appointment!.id)
    .eq("client_package_id", pkg!.id)
    .eq("transaction_type", "lesson_deduction")
    .maybeSingle();
  assertTestCondition(!ledgerError && ledgerRow, `Expected a lesson_deduction ledger row after RPC call: ${ledgerError?.message ?? "not found"}`);
  refs = addRef(refs, "lesson_transactions", ledgerRow!.id as string);

  return refs;
}

export async function cleanupEntitlementSuite(
  ctx: SuiteContext,
  createdRecordRefs: CreatedRecordRefs,
): Promise<SuiteCleanupResult> {
  const session = requireSession(ctx, "owner");

  try {
    // Cancel the synthetic appointment (leaves the ledger row and the
    // appointment itself in place as a harmless, clearly-tagged historical
    // record -- same reasoning as suites/schedule.ts).
    for (const appointmentId of createdRecordRefs["appointments"] ?? []) {
      assertRecordWasCreatedByThisRun(createdRecordRefs, "appointments", appointmentId);
      await session.client
        .from("appointments")
        .update({ status: "cancelled", cancelled_at: new Date().toISOString() })
        .eq("id", appointmentId)
        .eq("studio_id", session.studioId);
    }

    // Deactivate the synthetic package rather than attempting a precise
    // ledgered balance restoration -- this is a throwaway fixture, not a
    // real client's real balance, so full deactivation is the simpler and
    // safer reversal ("reverse/cleanup where business rules support it").
    for (const packageId of createdRecordRefs["client_packages"] ?? []) {
      assertRecordWasCreatedByThisRun(createdRecordRefs, "client_packages", packageId);
      await session.client
        .from("client_packages")
        .update({ active: false })
        .eq("id", packageId)
        .eq("studio_id", session.studioId);
    }

    for (const clientId of createdRecordRefs["clients"] ?? []) {
      assertRecordWasCreatedByThisRun(createdRecordRefs, "clients", clientId);
      await archiveSyntheticClientFixture(session, clientId);
    }

    return { status: "completed", error: null };
  } catch (error) {
    return { status: "failed", error: error instanceof Error ? error.message : "Unknown cleanup error" };
  }
}
