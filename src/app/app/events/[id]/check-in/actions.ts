"use server";

import { redirect } from "next/navigation";
import { isRedirectError } from "next/dist/client/components/redirect-error";
import { createClient as createSupabaseServiceClient, type SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { canCheckInEventAttendees } from "@/lib/auth/permissions";
import {
  claimAttendeeTicketCheckIns,
  claimRegistrationCheckIn,
  claimSessionAttendanceCheckIn,
  rollUpRegistrationCheckIn,
} from "./atomicCheckIn";

/**
 * CI-B: event door check-in (ticket code scan and manual check-in).
 *
 * These replace checkInEventTicketCodeAction / checkInEventRegistrationAction in
 * ../registrations/actions.ts for the check-in page. Two changes from those:
 *   1. Every admission write is compare-and-set (see ./atomicCheckIn.ts), so
 *      two concurrent scans of one ticket admit exactly once and the loser
 *      gets warning=already_checked_in.
 *   2. The caller must pass canCheckInEventAttendees before any lookup; the
 *      old actions accepted any active studio member.
 * Lookups, validation order and banner codes are otherwise unchanged.
 */

type ServerSupabase = Awaited<ReturnType<typeof createClient>>;

type RegistrationRow = {
  id: string;
  event_id: string;
  client_id: string | null;
  status: string;
  payment_status: string | null;
  checked_in_at: string | null;
};

type TicketCodeLookupRow = {
  id: string;
  registration_id: string;
  event_id: string | null;
  ticket_code: string | null;
  checked_in_at: string | null;
};

type RegistrationAttendeeCheckInRow = {
  id: string;
  registration_id: string;
  event_id: string | null;
  checked_in_at: string | null;
};

type EventAccessRow = {
  id: string;
  event_type: string | null;
  studio_id: string;
};

type EventSessionRow = {
  id: string;
  status: string;
};

type AttendanceLookupRow = {
  id: string;
  status?: string | null;
};

function createServiceRoleClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) return null;

  return createSupabaseServiceClient(url, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function resolveReturnUrl(params: {
  eventId: string;
  returnTo?: string;
  fallbackSuffix: string;
}) {
  const { eventId, returnTo, fallbackSuffix } = params;

  if (returnTo && returnTo.startsWith(`/app/events/${eventId}/`)) {
    const separator = returnTo.includes("?") ? "&" : "?";
    return `${returnTo}${separator}${fallbackSuffix}`;
  }

  return `/app/events/${eventId}/check-in?${fallbackSuffix}`;
}

function normalizeTicketCode(value: string) {
  return value.trim().toUpperCase().replace(/\s+/g, "");
}

function isCheckedInAttendanceStatus(status: string | null | undefined) {
  return status === "checked_in" || status === "attended";
}

/** Returns the banner error code that blocks admission, or null when the registration may be checked in. */
function registrationAdmissionError(registration: RegistrationRow) {
  if (["cancelled", "refunded"].includes(registration.status ?? "")) {
    return "cannot_check_in_cancelled";
  }

  if (!["confirmed", "registered", "checked_in", "attended"].includes(registration.status ?? "")) {
    return "ticket_not_confirmed";
  }

  if (["pending", "unpaid", "failed", "refunded"].includes(registration.payment_status ?? "")) {
    return "cannot_check_in_unpaid";
  }

  return null;
}

async function getCheckInContext() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const context = await getCurrentStudioContext();

  return {
    supabase,
    studioId: context.studioId,
    canCheckIn: canCheckInEventAttendees(context.studioRole, context.isPlatformAdmin),
    userId: user.id,
  };
}

async function validateEventAccess(supabase: ServerSupabase, eventId: string, studioId: string) {
  const { data: event, error } = await supabase
    .from("events")
    .select("id, event_type, studio_id")
    .eq("id", eventId)
    .eq("studio_id", studioId)
    .maybeSingle<EventAccessRow>();

  if (error || !event) {
    redirect("/app/events");
  }

  return event;
}

async function getRegistrationForEvent(params: {
  supabase: ServerSupabase;
  eventId: string;
  registrationId: string;
}) {
  const { supabase, eventId, registrationId } = params;

  const { data, error } = await supabase
    .from("event_registrations")
    .select("id, event_id, client_id, status, payment_status, checked_in_at")
    .eq("id", registrationId)
    .eq("event_id", eventId)
    .maybeSingle<RegistrationRow>();

  if (error) {
    throw new Error(error.message);
  }

  return data ?? null;
}

async function findAttendeeByTicketCode(params: {
  supabase: ServerSupabase;
  eventId: string;
  ticketCode: string;
}) {
  const { supabase, eventId, ticketCode } = params;
  const normalizedCode = normalizeTicketCode(ticketCode);

  if (!normalizedCode) return null;

  const { data, error } = await supabase
    .from("event_registration_attendees")
    .select("id, registration_id, event_id, ticket_code, checked_in_at")
    .eq("event_id", eventId)
    .eq("ticket_code", normalizedCode)
    .maybeSingle<TicketCodeLookupRow>();

  if (error) {
    throw new Error(error.message);
  }

  return data ?? null;
}

async function getRegistrationAttendeesForCheckIn(params: {
  supabase: ServerSupabase;
  eventId: string;
  registrationId: string;
}) {
  const { supabase, eventId, registrationId } = params;

  const { data, error } = await supabase
    .from("event_registration_attendees")
    .select("id, registration_id, event_id, checked_in_at")
    .eq("event_id", eventId)
    .eq("registration_id", registrationId)
    .order("sort_order", { ascending: true });

  if (error) {
    throw new Error(error.message);
  }

  return (data ?? []) as RegistrationAttendeeCheckInRow[];
}

async function getEventSessionForEvent(params: {
  supabase: ServerSupabase;
  studioId: string;
  eventId: string;
  eventSessionId: string;
}) {
  const { supabase, studioId, eventId, eventSessionId } = params;

  const { data, error } = await supabase
    .from("event_sessions")
    .select("id, status")
    .eq("id", eventSessionId)
    .eq("event_id", eventId)
    .eq("studio_id", studioId)
    .maybeSingle<EventSessionRow>();

  if (error) {
    throw new Error(error.message);
  }

  return data ?? null;
}

async function getRegistrationLevelAttendance(params: {
  supabase: ServerSupabase;
  studioId: string;
  registrationId: string;
}) {
  const { supabase, studioId, registrationId } = params;

  const { data, error } = await supabase
    .from("attendance_records")
    .select("id, status")
    .eq("studio_id", studioId)
    .eq("event_registration_id", registrationId)
    .is("event_session_id", null)
    .is("event_registration_attendee_id", null)
    .maybeSingle<AttendanceLookupRow>();

  if (error) {
    throw new Error(error.message);
  }

  return data ?? null;
}

/**
 * Non-group-class attendance bookkeeping, written only by the caller that won
 * the ticket/registration claim. Same behavior as upsertAttendanceStatus in
 * ../registrations/actions.ts for status "checked_in".
 */
async function recordCheckedInAttendance(params: {
  supabase: ServerSupabase;
  studioId: string;
  registration: RegistrationRow;
  eventRegistrationAttendeeId: string | null;
  now: string;
}) {
  const { supabase, studioId, registration, eventRegistrationAttendeeId, now } = params;

  let existingQuery = supabase
    .from("attendance_records")
    .select("id, status")
    .eq("studio_id", studioId)
    .eq("event_registration_id", registration.id)
    .is("event_session_id", null);

  existingQuery = eventRegistrationAttendeeId
    ? existingQuery.eq("event_registration_attendee_id", eventRegistrationAttendeeId)
    : existingQuery.is("event_registration_attendee_id", null);

  const { data: existing, error: existingError } =
    await existingQuery.maybeSingle<AttendanceLookupRow>();

  if (existingError) {
    throw new Error(existingError.message);
  }

  const payload = {
    studio_id: studioId,
    client_id: registration.client_id,
    event_registration_id: registration.id,
    event_session_id: null,
    event_registration_attendee_id: eventRegistrationAttendeeId,
    status: "checked_in",
    checked_in_at: now,
    marked_attended_at: null,
  };

  if (existing) {
    const { error: updateError } = await supabase
      .from("attendance_records")
      .update(payload)
      .eq("id", existing.id)
      .eq("studio_id", studioId);

    if (updateError) {
      throw new Error(updateError.message);
    }

    return;
  }

  const { error: insertError } = await supabase.from("attendance_records").insert(payload);

  if (insertError) {
    throw new Error(insertError.message);
  }
}

export async function checkInEventTicketCodeAction(formData: FormData) {
  const eventId = getString(formData, "eventId");
  const ticketCode = getString(formData, "ticketCode");
  const eventSessionId = getString(formData, "eventSessionId");
  const returnTo = getString(formData, "returnTo");

  if (!eventId) {
    redirect("/app/events");
  }

  const back = (suffix: string) => resolveReturnUrl({ eventId, returnTo, fallbackSuffix: suffix });

  const { supabase, studioId, userId, canCheckIn } = await getCheckInContext();

  if (!canCheckIn) {
    redirect(back("error=checkin_unauthorized"));
  }

  if (!ticketCode) {
    redirect(back("error=ticket_code_required"));
  }

  const ticketSuffix = `ticket=${encodeURIComponent(normalizeTicketCode(ticketCode))}`;
  let nextUrl = back("error=checkin_failed");

  try {
    const event = await validateEventAccess(supabase, eventId, studioId);
    const isGroupClass = event.event_type === "group_class";

    const attendee = await findAttendeeByTicketCode({ supabase, eventId, ticketCode });

    if (!attendee) {
      nextUrl = back("error=ticket_code_not_found");
    } else if (isGroupClass && !eventSessionId) {
      nextUrl = back("error=session_required");
    } else {
      const registration = await getRegistrationForEvent({
        supabase,
        eventId,
        registrationId: attendee.registration_id,
      });
      const admissionError = registration ? registrationAdmissionError(registration) : "registration_not_found";

      if (!registration || admissionError) {
        nextUrl = back(`error=${admissionError}`);
      } else if (isGroupClass) {
        const session = await getEventSessionForEvent({ supabase, studioId, eventId, eventSessionId });

        if (!session || session.status === "cancelled") {
          nextUrl = back("error=session_not_found");
        } else {
          const admitted = await claimSessionAttendanceCheckIn({
            client: supabase,
            studioId,
            registration,
            eventSessionId,
            eventRegistrationAttendeeId: attendee.id,
            now: new Date().toISOString(),
          });

          nextUrl = back(`${admitted ? "success=checked_in" : "warning=already_checked_in"}&${ticketSuffix}`);
        }
      } else if (attendee.checked_in_at) {
        // QR tickets are per attendee row; the registration-level
        // checked_in_at is not proof that this ticket was used.
        nextUrl = back(`warning=already_checked_in&${ticketSuffix}`);
      } else {
        const now = new Date().toISOString();
        const writeSupabase: SupabaseClient = createServiceRoleClient() ?? supabase;

        const claimed = await claimAttendeeTicketCheckIns({
          client: writeSupabase,
          eventId,
          attendeeIds: [attendee.id],
          userId,
          now,
        });

        if (claimed.length === 0) {
          nextUrl = back(`warning=already_checked_in&${ticketSuffix}`);
        } else {
          await rollUpRegistrationCheckIn({
            readClient: supabase,
            writeClient: writeSupabase,
            eventId,
            registrationId: attendee.registration_id,
            now,
          });

          await recordCheckedInAttendance({
            supabase,
            studioId,
            registration,
            eventRegistrationAttendeeId: null,
            now,
          });

          nextUrl = back(`success=checked_in&${ticketSuffix}`);
        }
      }
    }
  } catch (error) {
    if (isRedirectError(error)) throw error;
    console.error("Event ticket code check-in failed", error);
    nextUrl = back("error=checkin_failed");
  }

  redirect(nextUrl);
}

export async function checkInEventRegistrationAction(formData: FormData) {
  const eventId = getString(formData, "eventId");
  const registrationId = getString(formData, "registrationId");
  const eventRegistrationAttendeeId = getString(formData, "eventRegistrationAttendeeId");
  const eventSessionId = getString(formData, "eventSessionId");
  const returnTo = getString(formData, "returnTo");

  if (!eventId || !registrationId) {
    redirect("/app/events");
  }

  const back = (suffix: string) => resolveReturnUrl({ eventId, returnTo, fallbackSuffix: suffix });

  const { supabase, studioId, userId, canCheckIn } = await getCheckInContext();

  if (!canCheckIn) {
    redirect(back("error=checkin_unauthorized"));
  }

  let nextUrl = back("error=checkin_failed");

  try {
    const event = await validateEventAccess(supabase, eventId, studioId);
    const isGroupClass = event.event_type === "group_class";

    const registration = await getRegistrationForEvent({ supabase, eventId, registrationId });
    const admissionError = registration ? registrationAdmissionError(registration) : "registration_not_found";

    if (!registration || admissionError) {
      nextUrl = back(`error=${admissionError}`);
    } else if (isGroupClass && !eventSessionId) {
      nextUrl = back("error=session_required");
    } else {
      const session = isGroupClass
        ? await getEventSessionForEvent({ supabase, studioId, eventId, eventSessionId })
        : null;

      const attendees = await getRegistrationAttendeesForCheckIn({ supabase, eventId, registrationId });
      const targetAttendees = eventRegistrationAttendeeId
        ? attendees.filter((attendee) => attendee.id === eventRegistrationAttendeeId)
        : attendees;
      const now = new Date().toISOString();

      if (isGroupClass && (!session || session.status === "cancelled")) {
        nextUrl = back("error=session_not_found");
      } else if (eventRegistrationAttendeeId && targetAttendees.length === 0) {
        nextUrl = back("error=attendee_not_found");
      } else if (isGroupClass) {
        if (targetAttendees.length === 0) {
          throw new Error("No attendee rows found for this registration.");
        }

        const admitted = await Promise.all(
          targetAttendees.map((attendee) =>
            claimSessionAttendanceCheckIn({
              client: supabase,
              studioId,
              registration,
              eventSessionId,
              eventRegistrationAttendeeId: attendee.id,
              now,
            }),
          ),
        );

        nextUrl = back(admitted.some(Boolean) ? "success=checked_in" : "warning=already_checked_in");
      } else if (targetAttendees.length > 0) {
        const writeSupabase: SupabaseClient = createServiceRoleClient() ?? supabase;
        const pendingIds = targetAttendees
          .filter((attendee) => !attendee.checked_in_at)
          .map((attendee) => attendee.id);

        const claimedIds = await claimAttendeeTicketCheckIns({
          client: writeSupabase,
          eventId,
          registrationId,
          attendeeIds: pendingIds,
          userId,
          now,
        });

        if (claimedIds.length === 0) {
          nextUrl = back("warning=already_checked_in");
        } else {
          await rollUpRegistrationCheckIn({
            readClient: supabase,
            writeClient: writeSupabase,
            eventId,
            registrationId,
            now,
          });

          await Promise.all(
            claimedIds.map((attendeeId) =>
              recordCheckedInAttendance({
                supabase,
                studioId,
                registration,
                eventRegistrationAttendeeId: attendeeId,
                now,
              }),
            ),
          );

          nextUrl = back("success=checked_in");
        }
      } else {
        // Registration without attendee ticket rows (legacy single-admit).
        const existingAttendance = await getRegistrationLevelAttendance({
          supabase,
          studioId,
          registrationId,
        });
        const alreadyCheckedIn =
          isCheckedInAttendanceStatus(existingAttendance?.status) ||
          Boolean(registration.checked_in_at) ||
          registration.status === "checked_in";

        const writeSupabase: SupabaseClient = createServiceRoleClient() ?? supabase;
        const claimed =
          !alreadyCheckedIn &&
          (await claimRegistrationCheckIn({ client: writeSupabase, eventId, registrationId, now }));

        if (!claimed) {
          nextUrl = back("warning=already_checked_in");
        } else {
          await recordCheckedInAttendance({
            supabase,
            studioId,
            registration,
            eventRegistrationAttendeeId: null,
            now,
          });

          nextUrl = back("success=checked_in");
        }
      }
    }
  } catch (error) {
    if (isRedirectError(error)) throw error;
    console.error("Event check-in failed", error);
    nextUrl = back("error=checkin_failed");
  }

  redirect(nextUrl);
}
