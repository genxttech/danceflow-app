import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * CI-B: compare-and-set check-in primitives.
 *
 * The previous check-in actions read `checked_in_at` (or the attendance
 * status), decided "not yet checked in", then updated by id. Two scans of the
 * same ticket that both read before either wrote would both be told
 * "checked in", which double-admits at the door. Every write here carries the
 * "not yet checked in" condition in the UPDATE itself and reports which rows it
 * actually changed, so exactly one concurrent caller wins and the others get an
 * explicit "already checked in" outcome. No schema change is needed: the
 * conditions are ordinary PostgREST filters, and the group-class insert path
 * relies on the existing attendance_records_one_per_event_session_attendee
 * unique index.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = SupabaseClient<any, any, any>;

const CHECKED_IN_ATTENDANCE_STATUSES = ["checked_in", "attended"] as const;

export type AttendanceRegistration = {
  id: string;
  client_id: string | null;
};

/**
 * Claims ticket-level check-in for the given attendee rows. Only rows whose
 * `checked_in_at` is still null are written; returns the ids this call
 * actually checked in (empty when every row was already checked in).
 */
export async function claimAttendeeTicketCheckIns(params: {
  client: AnyClient;
  eventId: string;
  registrationId?: string;
  attendeeIds: string[];
  userId: string;
  now: string;
}): Promise<string[]> {
  const { client, eventId, registrationId, attendeeIds, userId, now } = params;

  if (attendeeIds.length === 0) return [];

  let query = client
    .from("event_registration_attendees")
    .update({
      checked_in_at: now,
      checked_in_by: userId,
      updated_at: now,
    })
    .in("id", attendeeIds)
    .eq("event_id", eventId);

  if (registrationId) {
    query = query.eq("registration_id", registrationId);
  }

  const { data, error } = await query.is("checked_in_at", null).select("id");

  if (error) {
    throw new Error(error.message);
  }

  return ((data ?? []) as { id: string }[]).map((row) => row.id);
}

/**
 * Sets the registration-level `checked_in_at` only if it is still null, so the
 * first admission time is kept. Returns true when this call wrote it.
 */
export async function claimRegistrationCheckIn(params: {
  client: AnyClient;
  eventId: string;
  registrationId: string;
  now: string;
}): Promise<boolean> {
  const { client, eventId, registrationId, now } = params;

  const { data, error } = await client
    .from("event_registrations")
    .update({ checked_in_at: now })
    .eq("id", registrationId)
    .eq("event_id", eventId)
    .is("checked_in_at", null)
    .select("id");

  if (error) {
    throw new Error(error.message);
  }

  return (data ?? []).length > 0;
}

/**
 * After ticket claims, stamps the registration as checked in once every
 * attendee ticket is checked in. Reads the current rows (not a snapshot taken
 * before the claim) so two attendees of one registration scanned at the same
 * time still roll the registration up.
 */
export async function rollUpRegistrationCheckIn(params: {
  readClient: AnyClient;
  writeClient: AnyClient;
  eventId: string;
  registrationId: string;
  now: string;
}): Promise<boolean> {
  const { readClient, writeClient, eventId, registrationId, now } = params;

  const { data, error } = await readClient
    .from("event_registration_attendees")
    .select("id, checked_in_at")
    .eq("event_id", eventId)
    .eq("registration_id", registrationId);

  if (error) {
    throw new Error(error.message);
  }

  const rows = (data ?? []) as { id: string; checked_in_at: string | null }[];
  const allCheckedIn = rows.length > 0 && rows.every((row) => Boolean(row.checked_in_at));

  if (!allCheckedIn) return false;

  await claimRegistrationCheckIn({
    client: writeClient,
    eventId,
    registrationId,
    now,
  });

  return true;
}

function isUniqueViolation(error: { code?: string | null } | null | undefined) {
  return error?.code === "23505";
}

/**
 * Group-class check-in is recorded per attendee per session in
 * attendance_records. Claims that record: an existing row is moved to
 * checked_in only if it is not already checked_in/attended; a missing row is
 * inserted, and losing the insert race to the unique index counts as "already
 * checked in". Returns true when this call admitted the attendee.
 */
export async function claimSessionAttendanceCheckIn(params: {
  client: AnyClient;
  studioId: string;
  registration: AttendanceRegistration;
  eventSessionId: string;
  eventRegistrationAttendeeId: string;
  now: string;
}): Promise<boolean> {
  const {
    client,
    studioId,
    registration,
    eventSessionId,
    eventRegistrationAttendeeId,
    now,
  } = params;

  const payload = {
    studio_id: studioId,
    client_id: registration.client_id,
    event_registration_id: registration.id,
    event_session_id: eventSessionId,
    event_registration_attendee_id: eventRegistrationAttendeeId,
    status: "checked_in",
    checked_in_at: now,
    marked_attended_at: null,
  };

  const { data: existing, error: existingError } = await client
    .from("attendance_records")
    .select("id, status")
    .eq("studio_id", studioId)
    .eq("event_registration_id", registration.id)
    .eq("event_session_id", eventSessionId)
    .eq("event_registration_attendee_id", eventRegistrationAttendeeId)
    .maybeSingle<{ id: string; status: string | null }>();

  if (existingError) {
    throw new Error(existingError.message);
  }

  if (existing) {
    const { data, error } = await client
      .from("attendance_records")
      .update(payload)
      .eq("id", existing.id)
      .eq("studio_id", studioId)
      .not("status", "in", `(${CHECKED_IN_ATTENDANCE_STATUSES.join(",")})`)
      .select("id");

    if (error) {
      throw new Error(error.message);
    }

    return (data ?? []).length > 0;
  }

  const { error: insertError } = await client
    .from("attendance_records")
    .insert(payload)
    .select("id")
    .single();

  if (isUniqueViolation(insertError)) {
    // Only treat the conflict as "already checked in" when the winner's row
    // for this exact attendee and session is there; any other unique
    // conflict stays a failure rather than a misleading warning.
    const { data: winner, error: winnerError } = await client
      .from("attendance_records")
      .select("id, status")
      .eq("studio_id", studioId)
      .eq("event_registration_id", registration.id)
      .eq("event_session_id", eventSessionId)
      .eq("event_registration_attendee_id", eventRegistrationAttendeeId)
      .maybeSingle<{ id: string; status: string | null }>();

    if (winnerError) {
      throw new Error(winnerError.message);
    }

    if (
      winner &&
      (CHECKED_IN_ATTENDANCE_STATUSES as readonly string[]).includes(winner.status ?? "")
    ) {
      return false;
    }
  }

  if (insertError) {
    throw new Error(insertError.message);
  }

  return true;
}
