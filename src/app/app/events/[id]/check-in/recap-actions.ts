"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { sendMobilePushToUser } from "@/lib/notifications/expoPush";
import { createClient } from "@/lib/supabase/server";

type EventRow = {
  id: string;
  studio_id: string;
  event_type: string | null;
  name: string;
};

type EventSessionRow = {
  id: string;
  event_id: string;
  studio_id: string;
  session_date: string;
  session_label: string | null;
  status: string;
};

type RegistrationRecipientRow = {
  id: string;
  client_id: string | null;
  attendee_first_name: string | null;
  attendee_last_name: string | null;
  attendee_email: string | null;
  clients:
    | {
        id: string;
        portal_user_id: string | null;
        email: string | null;
        first_name: string | null;
        last_name: string | null;
      }
    | {
        id: string;
        portal_user_id: string | null;
        email: string | null;
        first_name: string | null;
        last_name: string | null;
      }[]
    | null;
};

type CheckedInAttendeeRow = {
  id: string;
  registration_id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
};

type SessionCheckInRow = {
  event_registration_id: string | null;
  event_registration_attendee_id: string | null;
};

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function getOptionalString(formData: FormData, key: string) {
  const value = getString(formData, key);
  return value.length ? value : null;
}

function getMediaLinks(value: string | null) {
  if (!value) return [];
  return value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function firstJoin<T>(value: T | T[] | null | undefined) {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function buildCheckInHref(params: { eventId: string; eventSessionId?: string }) {
  const search = new URLSearchParams();
  if (params.eventSessionId) search.set("sessionId", params.eventSessionId);
  const query = search.toString();
  return query
    ? `/app/events/${params.eventId}/check-in?${query}`
    : `/app/events/${params.eventId}/check-in`;
}

function appendResult(url: string, result: string) {
  return `${url}${url.includes("?") ? "&" : "?"}${result}`;
}

async function sendEventGroupRecapPushes(params: {
  eventName: string;
  recipients: Array<Record<string, unknown>>;
}) {
  const userIds = Array.from(
    new Set(
      params.recipients
        .map((recipient) => (typeof recipient.user_id === "string" ? recipient.user_id : null))
        .filter((id): id is string => Boolean(id))
    )
  );

  await Promise.all(
    userIds.map((userId) =>
      sendMobilePushToUser({
        userId,
        category: "learning",
        title: "New class recap",
        body: `${params.eventName} recap is ready to review.`,
        data: {
          source: "event_group_lesson_recap_published",
        },
      }).catch((error) => {
        console.error("Failed to send event group recap mobile push", error);
      })
    )
  );
}

async function requireEventSessionAccess(params: {
  eventId: string;
  eventSessionId: string;
}) {
  const { eventId, eventSessionId } = params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const context = await getCurrentStudioContext();
  const studioId = context.studioId;

  const { data: event, error: eventError } = await supabase
    .from("events")
    .select("id, studio_id, event_type, name")
    .eq("id", eventId)
    .eq("studio_id", studioId)
    .single<EventRow>();

  if (eventError || !event) {
    throw new Error(eventError?.message ?? "Event not found.");
  }

  if (event.event_type !== "group_class") {
    throw new Error("Group lesson recaps can only be created for group classes.");
  }

  const { data: eventSession, error: sessionError } = await supabase
    .from("event_sessions")
    .select("id, event_id, studio_id, session_date, session_label, status")
    .eq("id", eventSessionId)
    .eq("event_id", eventId)
    .eq("studio_id", studioId)
    .single<EventSessionRow>();

  if (sessionError || !eventSession) {
    throw new Error(sessionError?.message ?? "Class session not found.");
  }

  if (eventSession.status === "cancelled") {
    throw new Error("Group lesson recaps cannot be created for cancelled sessions.");
  }

  return { supabase, user, studioId, event, eventSession };
}

export async function saveEventGroupLessonRecapAction(formData: FormData) {
  const eventId = getString(formData, "eventId");
  const eventSessionId = getString(formData, "eventSessionId");
  const title = getString(formData, "title");
  const returnTo =
    getString(formData, "returnTo") || buildCheckInHref({ eventId, eventSessionId });

  if (!eventId || !eventSessionId || !title) {
    redirect(appendResult(returnTo, "error=recap_save_failed"));
  }

  try {
    const { supabase, user, studioId } = await requireEventSessionAccess({
      eventId,
      eventSessionId,
    });

    const payload = {
      studio_id: studioId,
      appointment_id: null,
      event_id: eventId,
      event_session_id: eventSessionId,
      title,
      summary: getOptionalString(formData, "summary"),
      technique_notes: getOptionalString(formData, "techniqueNotes"),
      safety_notes: getOptionalString(formData, "safetyNotes"),
      practice_assignment: getOptionalString(formData, "practiceAssignment"),
      media_links: getMediaLinks(getOptionalString(formData, "mediaLinks")),
      status: "draft",
      created_by: user.id,
      updated_by: user.id,
      published_by: null,
      published_at: null,
    };

    const { data: existing, error: existingError } = await supabase
      .from("group_lesson_recaps")
      .select("id")
      .eq("studio_id", studioId)
      .eq("event_session_id", eventSessionId)
      .maybeSingle<{ id: string }>();

    if (existingError) throw existingError;

    const { error } = existing?.id
      ? await supabase
          .from("group_lesson_recaps")
          .update(payload)
          .eq("id", existing.id)
          .eq("studio_id", studioId)
      : await supabase.from("group_lesson_recaps").insert(payload);

    if (error) throw error;
  } catch (error) {
    console.error("Save event group lesson recap failed", error);
    redirect(appendResult(returnTo, "error=recap_save_failed"));
  }

  revalidatePath(returnTo);
  redirect(appendResult(returnTo, "success=recap_saved"));
}

export async function publishEventGroupLessonRecapAction(formData: FormData) {
  const eventId = getString(formData, "eventId");
  const eventSessionId = getString(formData, "eventSessionId");
  const returnTo =
    getString(formData, "returnTo") || buildCheckInHref({ eventId, eventSessionId });

  if (!eventId || !eventSessionId) {
    redirect(appendResult(returnTo, "error=recap_publish_failed"));
  }

  try {
    const { supabase, user, studioId, event } = await requireEventSessionAccess({
      eventId,
      eventSessionId,
    });

    const { data: recap, error: recapError } = await supabase
      .from("group_lesson_recaps")
      .select("id")
      .eq("studio_id", studioId)
      .eq("event_session_id", eventSessionId)
      .maybeSingle<{ id: string }>();

    if (recapError || !recap) {
      throw new Error(recapError?.message ?? "Save a draft before publishing.");
    }

    const { data: sessionCheckIns, error: sessionCheckInError } = await supabase
      .from("attendance_records")
      .select("event_registration_id, event_registration_attendee_id")
      .eq("studio_id", studioId)
      .eq("event_session_id", eventSessionId)
      .in("status", ["checked_in", "attended"]);

    if (sessionCheckInError) throw sessionCheckInError;

    const registrationIds = Array.from(
      new Set(
        ((sessionCheckIns ?? []) as SessionCheckInRow[])
          .map((row) => row.event_registration_id)
          .filter((id): id is string => Boolean(id)),
      ),
    );
    const attendeeIds = Array.from(
      new Set(
        ((sessionCheckIns ?? []) as SessionCheckInRow[])
          .map((row) => row.event_registration_attendee_id)
          .filter((id): id is string => Boolean(id)),
      ),
    );

    if (registrationIds.length === 0) {
      throw new Error("No checked-in attendees found for this class.");
    }

    let attendeeQuery = supabase
      .from("event_registration_attendees")
      .select("id, registration_id, first_name, last_name, email")
      .eq("event_id", eventId);

    attendeeQuery =
      attendeeIds.length > 0
        ? attendeeQuery.in("id", attendeeIds)
        : attendeeQuery.in("registration_id", registrationIds);

    const { data: attendeeRows, error: attendeeError } = await attendeeQuery
      .order("registration_id", { ascending: true })
      .order("sort_order", { ascending: true });

    if (attendeeError) throw attendeeError;

    const checkedInAttendees = (attendeeRows ?? []) as CheckedInAttendeeRow[];

    const { data: registrations, error: registrationsError } = await supabase
      .from("event_registrations")
      .select(
        `
        id,
        client_id,
        attendee_first_name,
        attendee_last_name,
        attendee_email,
        clients (
          id,
          portal_user_id,
          email,
          first_name,
          last_name
        )
      `,
      )
      .in("id", registrationIds)
      .eq("event_id", eventId);

    if (registrationsError) throw registrationsError;

    const registrationById = new Map(
      ((registrations ?? []) as RegistrationRecipientRow[]).map((row) => [
        row.id,
        row,
      ]),
    );

    const recipientByIdentity = new Map<string, Record<string, unknown>>();

    const attendeesByRegistrationId = new Map<string, CheckedInAttendeeRow[]>();
    for (const attendee of checkedInAttendees) {
      const current = attendeesByRegistrationId.get(attendee.registration_id) ?? [];
      current.push(attendee);
      attendeesByRegistrationId.set(attendee.registration_id, current);
    }

    const checkedInTargets =
      attendeeIds.length > 0
        ? checkedInAttendees.map((attendee) => ({
            registrationId: attendee.registration_id,
            attendee,
          }))
        : registrationIds.map((registrationId) => ({
            registrationId,
            attendee: attendeesByRegistrationId.get(registrationId)?.[0] ?? null,
          }));

    for (const { registrationId, attendee } of checkedInTargets) {
      const registration = registrationById.get(registrationId);
      if (!registration) continue;

      const client = firstJoin(registration.clients);
      const attendeeName = [attendee?.first_name, attendee?.last_name]
        .filter(Boolean)
        .join(" ")
        .trim();
      const registrationName = [
        registration.attendee_first_name,
        registration.attendee_last_name,
      ]
        .filter(Boolean)
        .join(" ")
        .trim();
      const guestEmail =
        attendee?.email || client?.email || registration.attendee_email || null;

      if (!registration.client_id && !guestEmail) continue;

      const identityKey = registration.client_id
        ? `client:${registration.client_id}`
        : `guest:${guestEmail?.toLowerCase()}`;

      if (recipientByIdentity.has(identityKey)) continue;

      recipientByIdentity.set(identityKey, {
        recap_id: recap.id,
        studio_id: studioId,
        appointment_id: null,
        event_id: eventId,
        event_session_id: eventSessionId,
        event_registration_id: registration.id,
        event_registration_attendee_id: attendee?.id ?? null,
        client_id: registration.client_id,
        user_id: client?.portal_user_id ?? null,
        guest_email: registration.client_id ? null : guestEmail,
        guest_name: attendeeName || registrationName || null,
        source: "checked_in",
        delivery_status: "available",
      });
    }

    const recipients = Array.from(recipientByIdentity.values());

    if (recipients.length === 0) {
      throw new Error("No eligible checked-in recipients found for this class.");
    }

    const { error: deleteRecipientError } = await supabase
      .from("group_lesson_recap_recipients")
      .delete()
      .eq("recap_id", recap.id)
      .eq("studio_id", studioId);

    if (deleteRecipientError) throw deleteRecipientError;

    const { error: recipientError } = await supabase
      .from("group_lesson_recap_recipients")
      .insert(recipients);

    if (recipientError) throw recipientError;

    const { error: publishError } = await supabase
      .from("group_lesson_recaps")
      .update({
        status: "published",
        published_at: new Date().toISOString(),
        published_by: user.id,
        updated_by: user.id,
      })
      .eq("id", recap.id)
      .eq("studio_id", studioId);

    if (publishError) throw publishError;

    await sendEventGroupRecapPushes({
      eventName: event.name || "Class",
      recipients,
    });
  } catch (error) {
    console.error("Publish event group lesson recap failed", error);
    redirect(appendResult(returnTo, "error=recap_publish_failed"));
  }

  revalidatePath(returnTo);
  redirect(appendResult(returnTo, "success=recap_published"));
}

export async function unpublishEventGroupLessonRecapAction(formData: FormData) {
  const eventId = getString(formData, "eventId");
  const eventSessionId = getString(formData, "eventSessionId");
  const returnTo =
    getString(formData, "returnTo") || buildCheckInHref({ eventId, eventSessionId });

  if (!eventId || !eventSessionId) {
    redirect(appendResult(returnTo, "error=recap_unpublish_failed"));
  }

  try {
    const { supabase, user, studioId } = await requireEventSessionAccess({
      eventId,
      eventSessionId,
    });

    const { error } = await supabase
      .from("group_lesson_recaps")
      .update({
        status: "unpublished",
        updated_by: user.id,
      })
      .eq("studio_id", studioId)
      .eq("event_session_id", eventSessionId);

    if (error) throw error;
  } catch (error) {
    console.error("Unpublish event group lesson recap failed", error);
    redirect(appendResult(returnTo, "error=recap_unpublish_failed"));
  }

  revalidatePath(returnTo);
  redirect(appendResult(returnTo, "success=recap_unpublished"));
}
