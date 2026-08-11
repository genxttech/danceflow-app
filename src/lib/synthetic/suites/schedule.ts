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
 * SYN-SCHED-001 -- Schedule
 *
 * Catalog assertion: "Valid synthetic booking succeeds and cancellation
 * restores state."
 *
 * Note on scope: the appointments/schedule domain in this app has no
 * enrollment-capacity model (that only exists for Events -- see
 * suites/events.ts). "State recovery" here means the booking's own status
 * correctly transitions to cancelled and stays there, not a capacity
 * counter -- there isn't one to restore.
 *
 * Uses billing_type "free_comped" specifically so this suite never
 * touches package/membership entitlement -- that's SYN-ENT-001's job
 * (suites/entitlement.ts), which deliberately DOES exercise real credit
 * deduction. Keeping the two suites' side effects disjoint means either
 * can be run alone without the other's fixtures.
 */
export async function runScheduleSuite(ctx: SuiteContext): Promise<CreatedRecordRefs> {
  const session = requireSession(ctx, "owner");
  let refs: CreatedRecordRefs = {};

  const clientFixture = await createSyntheticClientFixture(session, ctx.runId, refs);
  refs = clientFixture.refs;

  const startsAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const endsAt = new Date(startsAt.getTime() + 30 * 60 * 1000);

  const { data: appointment, error: insertError } = await session.client
    .from("appointments")
    .insert({
      studio_id: session.studioId,
      client_id: clientFixture.clientId,
      appointment_type: "private_lesson",
      title: "Synthetic test booking",
      notes: `${syntheticTag(ctx.runId)} Created by the production synthetic testing harness. Safe to leave cancelled.`,
      starts_at: startsAt.toISOString(),
      ends_at: endsAt.toISOString(),
      billing_type: "free_comped",
    })
    .select("id, studio_id, status")
    .single();

  assertTestCondition(!insertError && appointment, `Synthetic appointment booking failed: ${insertError?.message ?? "no row returned"}`);
  assertTestCondition(appointment!.studio_id === session.studioId, "Synthetic appointment was created outside the synthetic tenant.");
  assertTestCondition(appointment!.status === "scheduled", `Synthetic appointment did not start in "scheduled" status (got "${appointment!.status}").`);
  refs = addRef(refs, "appointments", appointment!.id as string);

  // Verify.
  const { data: verifyRow, error: verifyError } = await session.client
    .from("appointments")
    .select("id, status")
    .eq("id", appointment!.id)
    .eq("studio_id", session.studioId)
    .maybeSingle();
  assertTestCondition(!verifyError && verifyRow, `Could not verify synthetic appointment: ${verifyError?.message ?? "not found"}`);

  // Cancel.
  const { error: cancelError } = await session.client
    .from("appointments")
    .update({ status: "cancelled", cancelled_at: new Date().toISOString() })
    .eq("id", appointment!.id)
    .eq("studio_id", session.studioId);
  assertTestCondition(!cancelError, `Synthetic appointment cancellation failed: ${cancelError?.message}`);

  // Verify state recovery: status transitioned and stayed cancelled.
  const { data: afterCancel, error: afterCancelError } = await session.client
    .from("appointments")
    .select("status")
    .eq("id", appointment!.id)
    .maybeSingle();
  assertTestCondition(
    !afterCancelError && afterCancel?.status === "cancelled",
    `Synthetic appointment did not reach "cancelled" status after cancellation (got "${afterCancel?.status}").`,
  );

  return refs;
}

export async function cleanupScheduleSuite(
  ctx: SuiteContext,
  createdRecordRefs: CreatedRecordRefs,
): Promise<SuiteCleanupResult> {
  const session = requireSession(ctx, "owner");

  try {
    // Appointments are already left in "cancelled" state by the suite
    // itself -- the app's own hard-delete rule only allows deleting
    // scheduled/confirmed/rescheduled appointments, so a cancelled
    // synthetic appointment is correctly left in place as a harmless,
    // clearly-tagged historical row rather than force-deleted.
    for (const clientId of createdRecordRefs["clients"] ?? []) {
      assertRecordWasCreatedByThisRun(createdRecordRefs, "clients", clientId);
      await archiveSyntheticClientFixture(session, clientId);
    }
    return { status: "completed", error: null };
  } catch (error) {
    return { status: "failed", error: error instanceof Error ? error.message : "Unknown cleanup error" };
  }
}
