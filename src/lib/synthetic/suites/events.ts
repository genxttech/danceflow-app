import type { SupabaseClient } from "@supabase/supabase-js";
import { syntheticTag } from "@/lib/synthetic/runId";
import type { CreatedRecordRefs } from "@/lib/synthetic/types";
import {
  assertTestCondition,
  requireSession,
  type SuiteCleanupResult,
  type SuiteContext,
} from "@/lib/synthetic/suites/contract";
import {
  assertIsConfiguredFixture,
  assertRecordWasCreatedByThisRun,
} from "@/lib/synthetic/guards";

const ACTIVE_REGISTRATION_STATUSES = ["pending", "confirmed", "checked_in"];

/**
 * SYN-EVENT-001 -- Events
 *
 * Catalog assertion: "Registration/cancellation preserves capacity and
 * tenant scope."
 *
 * Unlike the other suites, this one operates against a pre-provisioned,
 * reusable "explicitly tagged synthetic fixture" (the event + ticket type
 * identified by SYNTHETIC_EVENT_ID / SYNTHETIC_EVENT_TICKET_TYPE_ID) rather
 * than creating a throwaway event every run -- events are heavier objects
 * (venue/schedule/ticket-type setup) that shouldn't be created and torn
 * down on every execution. This is exactly the "explicitly tagged
 * synthetic fixtures" case FlowOps quality/PRODUCTION-SYNTHETIC-TESTING.md
 * safety requirement #2 anticipates, alongside "records created by the
 * current synthetic run."
 *
 * Registers as the synthetic owner/staff identity with
 * registration_source "admin" (a studio-staff-created registration) rather
 * than through the public anonymous registration flow, so this suite only
 * needs the one identity the other suites already use. The public-facing
 * flow (rate limiting, bot protection, anonymous checkout) is a reasonable
 * Phase 2 addition once a dedicated public-flow test identity exists.
 */
export async function runEventsSuite(ctx: SuiteContext): Promise<CreatedRecordRefs> {
  const session = requireSession(ctx, "owner");
  const refs: CreatedRecordRefs = {};

  assertTestCondition(
    ctx.config.eventFixture,
    "SYN-EVENT-001 requires SYNTHETIC_EVENT_ID and SYNTHETIC_EVENT_TICKET_TYPE_ID to be configured.",
  );
  const fixture = ctx.config.eventFixture!;

  const { data: event, error: eventError } = await session.client
    .from("events")
    .select("id, studio_id, capacity, status")
    .eq("id", fixture.eventId)
    .eq("studio_id", session.studioId)
    .maybeSingle();
  assertTestCondition(!eventError && event, `Could not load synthetic event fixture: ${eventError?.message ?? "not found"}`);
  assertIsConfiguredFixture(fixture.eventId, event!.id as string, "SYN-EVENT-001 event fixture");

  const { data: ticketType, error: ticketTypeError } = await session.client
    .from("event_ticket_types")
    .select("id, event_id, capacity")
    .eq("id", fixture.ticketTypeId)
    .eq("event_id", fixture.eventId)
    .maybeSingle();
  assertTestCondition(!ticketTypeError && ticketType, `Could not load synthetic ticket type fixture: ${ticketTypeError?.message ?? "not found"}`);
  assertIsConfiguredFixture(fixture.ticketTypeId, ticketType!.id as string, "SYN-EVENT-001 ticket type fixture");

  const beforeCount = await countActiveRegistrations(session.client, fixture.ticketTypeId);
  const hasCapacity = ticketType!.capacity == null || beforeCount < ticketType!.capacity;

  const { data: registration, error: registerError } = await session.client
    .from("event_registrations")
    .insert({
      event_id: fixture.eventId,
      ticket_type_id: fixture.ticketTypeId,
      studio_id: session.studioId,
      status: hasCapacity ? "confirmed" : "waitlisted",
      attendee_first_name: "Synthetic",
      attendee_last_name: `Participant-${ctx.runId.slice(4, 12)}`,
      attendee_email: `synthetic-${ctx.runId.slice(4, 12)}@example.invalid`,
      registration_source: "admin",
      notes: `${syntheticTag(ctx.runId)} Created by the production synthetic testing harness. Safe to cancel.`,
    })
    .select("id, studio_id, status")
    .single();
  assertTestCondition(!registerError && registration, `Synthetic event registration failed: ${registerError?.message ?? "no row returned"}`);
  assertTestCondition(registration!.studio_id === session.studioId, "Synthetic registration was created outside the synthetic tenant.");
  refs.event_registrations = [registration!.id as string];

  // Verify capacity/registration state reflects the new registration.
  const afterRegisterCount = await countActiveRegistrations(session.client, fixture.ticketTypeId);
  assertTestCondition(
    afterRegisterCount === beforeCount + 1,
    `Active registration count did not increase by exactly 1 after registering (before=${beforeCount}, after=${afterRegisterCount}).`,
  );

  // Cancel.
  const { error: cancelError } = await session.client
    .from("event_registrations")
    .update({ status: "cancelled", cancelled_at: new Date().toISOString() })
    .eq("id", registration!.id)
    .eq("event_id", fixture.eventId);
  assertTestCondition(!cancelError, `Synthetic registration cancellation failed: ${cancelError?.message}`);

  // Verify capacity state restoration.
  const afterCancelCount = await countActiveRegistrations(session.client, fixture.ticketTypeId);
  assertTestCondition(
    afterCancelCount === beforeCount,
    `Active registration count did not return to its pre-test value after cancellation (expected=${beforeCount}, got=${afterCancelCount}).`,
  );

  return refs;
}

async function countActiveRegistrations(
  client: SupabaseClient,
  ticketTypeId: string,
): Promise<number> {
  const { count, error } = await client
    .from("event_registrations")
    .select("id", { count: "exact", head: true })
    .eq("ticket_type_id", ticketTypeId)
    .in("status", ACTIVE_REGISTRATION_STATUSES);
  assertTestCondition(!error, `Failed to count active registrations: ${error?.message}`);
  return count ?? 0;
}

export async function cleanupEventsSuite(
  ctx: SuiteContext,
  createdRecordRefs: CreatedRecordRefs,
): Promise<SuiteCleanupResult> {
  const session = requireSession(ctx, "owner");

  try {
    for (const registrationId of createdRecordRefs["event_registrations"] ?? []) {
      assertRecordWasCreatedByThisRun(createdRecordRefs, "event_registrations", registrationId);
      // Already cancelled by the suite itself; cleanup just re-confirms
      // the terminal state rather than re-issuing the same update, so a
      // cleanup retry is idempotent.
      const { data, error } = await session.client
        .from("event_registrations")
        .select("status")
        .eq("id", registrationId)
        .maybeSingle();
      if (error || data?.status !== "cancelled") {
        await session.client
          .from("event_registrations")
          .update({ status: "cancelled", cancelled_at: new Date().toISOString() })
          .eq("id", registrationId);
      }
    }
    return { status: "completed", error: null };
  } catch (error) {
    return { status: "failed", error: error instanceof Error ? error.message : "Unknown cleanup error" };
  }
}
