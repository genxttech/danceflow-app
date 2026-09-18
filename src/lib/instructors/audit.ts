import { createAdminClient } from "@/lib/supabase/admin";

export type InstructorAuditEventType =
  | "capability_granted"
  | "capability_revoked"
  | "activated"
  | "deactivated"
  | "account_linked"
  | "account_unlinked";

/**
 * Writes one row to instructor_audit_events via the admin/service-role
 * client -- the table has no authenticated INSERT policy by design
 * (Landmark 1A Slice 1), so this is the only mechanism TypeScript code
 * may use to record an event. Callers must invoke this only after their
 * own authorization and studio-scope checks (e.g.
 * requireInstructorManageAccess()) have already succeeded, and only
 * after the underlying business mutation itself has succeeded.
 */
export async function writeInstructorAuditEvent(params: {
  studioId: string;
  instructorId: string;
  actorUserId: string;
  eventType: InstructorAuditEventType;
  beforeValue: Record<string, unknown> | null;
  afterValue: Record<string, unknown> | null;
  metadata?: Record<string, unknown>;
}) {
  const {
    studioId,
    instructorId,
    actorUserId,
    eventType,
    beforeValue,
    afterValue,
    metadata,
  } = params;

  const admin = createAdminClient();

  const { error } = await admin.from("instructor_audit_events").insert({
    studio_id: studioId,
    instructor_id: instructorId,
    actor_user_id: actorUserId,
    event_type: eventType,
    before_value: beforeValue,
    after_value: afterValue,
    metadata: metadata ?? null,
  });

  if (error) {
    throw new Error(`Could not record instructor audit event: ${error.message}`);
  }
}
