"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireAppointmentCreateAccess } from "@/lib/auth/serverRoleGuard";
import { detectAppointmentConflicts } from "@/lib/schedule/conflicts";

const DEFAULT_TIME_ZONE = "America/New_York";

function getStudioTimeZone(value?: string | null) {
  const timeZone = value?.trim() || DEFAULT_TIME_ZONE;

  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
    return timeZone;
  } catch {
    return DEFAULT_TIME_ZONE;
  }
}

function getZonedDateTimeParts(value: Date | string, timeZone: string) {
  const date = value instanceof Date ? value : new Date(value);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const part = (type: string) => Number(parts.find((item) => item.type === type)?.value ?? "0");
  const hourPart = part("hour");

  return {
    year: part("year"),
    month: part("month"),
    day: part("day"),
    hour: hourPart === 24 ? 0 : hourPart,
    minute: part("minute"),
    second: part("second"),
  };
}

function getZonedOffsetMs(date: Date, timeZone: string) {
  const parts = getZonedDateTimeParts(date, timeZone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );

  return asUtc - date.getTime();
}

function zonedDateTimeToUtcDate(date: string, time: string, timeZone: string) {
  const [year, month, day] = date.split("-").map(Number);
  const [hours, minutes] = time.split(":").map(Number);

  let utcMs = Date.UTC(year, month - 1, day, hours, minutes, 0, 0);

  for (let index = 0; index < 3; index += 1) {
    const offsetMs = getZonedOffsetMs(new Date(utcMs), timeZone);
    utcMs = Date.UTC(year, month - 1, day, hours, minutes, 0, 0) - offsetMs;
  }

  return new Date(utcMs);
}

function zonedDateTimeToUtcIso(date: string, time: string, timeZone: string) {
  return zonedDateTimeToUtcDate(date, time, timeZone).toISOString();
}

function getZonedDateKey(value: Date | string, timeZone: string) {
  const parts = getZonedDateTimeParts(value, timeZone);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function addDaysToDateKey(dateKey: string, days: number) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days, 12, 0, 0, 0));

  return date.toISOString().slice(0, 10);
}

function getZonedWeekday(dateKey: string, timeZone: string) {
  const date = zonedDateTimeToUtcDate(dateKey, "12:00", timeZone);
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
  }).format(date);

  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(weekday);
}

function getLocalDayUtcRange(dateKey: string, timeZone: string) {
  const safeTimeZone = getStudioTimeZone(timeZone);
  const nextDateKey = addDaysToDateKey(dateKey, 1);

  return {
    startIso: zonedDateTimeToUtcIso(dateKey, "00:00", safeTimeZone),
    endIso: zonedDateTimeToUtcIso(nextDateKey, "00:00", safeTimeZone),
  };
}

function formatStudioDate(value: string | null | undefined, timeZone: string, options?: Intl.DateTimeFormatOptions) {
  if (!value) return "Unknown";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: getStudioTimeZone(timeZone),
    month: "short",
    day: "numeric",
    year: "numeric",
    ...options,
  }).format(new Date(value));
}

function formatStudioDateTime(value: string | null | undefined, timeZone: string, options?: Intl.DateTimeFormatOptions) {
  if (!value) return "Not requested";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: getStudioTimeZone(timeZone),
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    ...options,
  }).format(new Date(value));
}

function formatStudioTime(value: string | null | undefined, timeZone: string) {
  if (!value) return "";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: getStudioTimeZone(timeZone),
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function getConflictErrorMessage(conflict: unknown) {
  if (!conflict) return "Scheduling conflict detected.";

  if (typeof conflict === "string") return conflict;

  if (typeof conflict === "object") {
    const value = conflict as {
      message?: string;
      error?: string;
      hasConflict?: boolean;
      roomConflict?: boolean;
      instructorConflict?: boolean;
      clientConflict?: boolean;
    };

    if (value.message) return value.message;
    if (value.error) return value.error;
    if (value.instructorConflict) {
      return "The selected instructor already has an appointment during that time.";
    }
    if (value.roomConflict) {
      return "There is a room conflict for the selected time.";
    }
    if (value.clientConflict) {
      return "The client already has an appointment during that time.";
    }
  }

  return "Scheduling conflict detected.";
}


function formatBookingRequestDateTime(value: string, timeZone: string) {
  return formatStudioDateTime(value, timeZone, { weekday: "short" });
}

async function queueBookingDecisionEmail(params: {
  supabase: Awaited<ReturnType<typeof requireAppointmentCreateAccess>>["supabase"];
  studioId: string;
  bookingRequestId: string;
  clientId: string;
  status: "approved" | "declined";
  requestedStartsAt: string;
  staffNote: string | null;
  appointmentId?: string | null;
}) {
  const { data: client } = await params.supabase
    .from("clients")
    .select("first_name, last_name, email")
    .eq("id", params.clientId)
    .eq("studio_id", params.studioId)
    .maybeSingle();

  const recipientEmail = (client as { email?: string | null } | null)?.email?.trim();
  if (!recipientEmail) return;

  const firstName =
    (client as { first_name?: string | null } | null)?.first_name?.trim() || "there";

  const [{ data: studio }, { data: settingsRow }] = await Promise.all([
    params.supabase
      .from("studios")
      .select("name")
      .eq("id", params.studioId)
      .maybeSingle(),
    params.supabase
      .from("studio_settings")
      .select("timezone")
      .eq("studio_id", params.studioId)
      .maybeSingle(),
  ]);

  const studioName = (studio as { name?: string | null } | null)?.name ?? "The studio";
  const studioTimeZone = getStudioTimeZone(
    (settingsRow as { timezone?: string | null } | null)?.timezone,
  );
  const requestedTime = formatBookingRequestDateTime(params.requestedStartsAt, studioTimeZone);

  const isApproved = params.status === "approved";
  const subject = isApproved
    ? `${studioName} approved your lesson request`
    : `${studioName} update about your lesson request`;

  const bodyText = isApproved
    ? [
        `Hi ${firstName},`,
        "",
        `${studioName} approved your lesson request for ${requestedTime}.`,
        "",
        "Your appointment has been added to the studio schedule.",
        params.staffNote ? `Studio note: ${params.staffNote}` : null,
        "",
        "Thanks,",
        studioName,
      ].filter(Boolean).join("\n")
    : [
        `Hi ${firstName},`,
        "",
        `${studioName} reviewed your lesson request for ${requestedTime}, but it was not approved for that time.`,
        params.staffNote ? `Studio note: ${params.staffNote}` : "Please contact the studio if you would like to request another time.",
        "",
        "Thanks,",
        studioName,
      ].filter(Boolean).join("\n");

  const { error } = await params.supabase.from("outbound_deliveries").insert({
    studio_id: params.studioId,
    channel: "email",
    template_key: isApproved
      ? "booking_request_approved_client"
      : "booking_request_declined_client",
    recipient_email: recipientEmail,
    subject,
    body_text: bodyText,
    body_html: null,
    related_table: "booking_requests",
    related_id: params.bookingRequestId,
    dedupe_key: `booking-request-${params.status}:${params.bookingRequestId}`,
    status: "queued",
    updated_at: new Date().toISOString(),
  });

  if (error && error.code !== "23505") {
    console.error(`Failed to queue booking request ${params.status} email`, error.message);
  }
}

type BookingRequestRow = {
  id: string;
  studio_id: string;
  client_id: string | null;
  instructor_id: string | null;
  room_id: string | null;
  appointment_type: string;
  title: string | null;
  requested_starts_at: string;
  requested_ends_at: string;
  notes: string | null;
  status: string;
};

export async function approveBookingRequestAction(formData: FormData) {
  const requestId = getString(formData, "requestId");
  const staffNote = getString(formData, "staffNote");

  if (!requestId) {
    redirect("/app/schedule/requests?error=missing_request");
  }

  const { supabase, studioId, user } = await requireAppointmentCreateAccess();

  const { data: request, error: requestError } = await supabase
    .from("booking_requests")
    .select(`
      id,
      studio_id,
      client_id,
      instructor_id,
      room_id,
      appointment_type,
      title,
      requested_starts_at,
      requested_ends_at,
      notes,
      status
    `)
    .eq("id", requestId)
    .eq("studio_id", studioId)
    .maybeSingle();

  if (requestError || !request) {
    redirect("/app/schedule/requests?error=request_not_found");
  }

  const typedRequest = request as BookingRequestRow;

  if (typedRequest.status !== "pending") {
    redirect("/app/schedule/requests?error=request_already_reviewed");
  }

  if (!typedRequest.client_id) {
    redirect("/app/schedule/requests?error=missing_client");
  }

  const conflict = await detectAppointmentConflicts({
    studioId,
    startsAt: typedRequest.requested_starts_at,
    endsAt: typedRequest.requested_ends_at,
    instructorId: typedRequest.instructor_id,
    roomId: typedRequest.room_id,
    clientId: typedRequest.client_id,
  });

  if ((conflict as { hasConflict?: boolean } | null)?.hasConflict) {
    redirect(
      `/app/schedule/requests?error=${encodeURIComponent(getConflictErrorMessage(conflict))}`,
    );
  }

  const appointmentNotes = [
    "Created from booking request.",
    typedRequest.notes,
    staffNote ? `Staff note: ${staffNote}` : null,
  ]
    .filter(Boolean)
    .join("\n\n");

  const { data: appointment, error: appointmentError } = await supabase
    .from("appointments")
    .insert({
      studio_id: studioId,
      client_id: typedRequest.client_id,
      instructor_id: typedRequest.instructor_id,
      room_id: typedRequest.room_id,
      appointment_type: typedRequest.appointment_type,
      title: typedRequest.title?.replace(" Request", "") || "Intro Lesson",
      notes: appointmentNotes || null,
      starts_at: typedRequest.requested_starts_at,
      ends_at: typedRequest.requested_ends_at,
      status: "scheduled",
      is_recurring: false,
      created_by: user.id,
    })
    .select("id")
    .single();

  if (appointmentError || !appointment) {
    redirect(
      `/app/schedule/requests?error=${encodeURIComponent(
        appointmentError?.message ?? "Could not create appointment.",
      )}`,
    );
  }

  const { error: updateError } = await supabase
    .from("booking_requests")
    .update({
      status: "approved",
      appointment_id: appointment.id,
      staff_note: staffNote || null,
      reviewed_by: user.id,
      reviewed_at: new Date().toISOString(),
    })
    .eq("id", typedRequest.id)
    .eq("studio_id", studioId)
    .eq("status", "pending");

  if (updateError) {
    redirect(
      `/app/schedule/requests?error=${encodeURIComponent(
        `Appointment was created, but request update failed: ${updateError.message}`,
      )}`,
    );
  }

  await supabase.from("notifications").insert({
    studio_id: studioId,
    type: "booking_request_approved",
    title: "Booking request approved",
    body: "A booking request was approved and converted to an appointment.",
    client_id: typedRequest.client_id,
    appointment_id: appointment.id,
  });

  await queueBookingDecisionEmail({
    supabase,
    studioId,
    bookingRequestId: typedRequest.id,
    clientId: typedRequest.client_id,
    status: "approved",
    requestedStartsAt: typedRequest.requested_starts_at,
    staffNote: staffNote || null,
    appointmentId: appointment.id,
  });

  revalidatePath("/app/schedule/requests");
  revalidatePath("/app/schedule");
  revalidatePath("/app");

  redirect("/app/schedule/requests?success=approved");
}

export async function declineBookingRequestAction(formData: FormData) {
  const requestId = getString(formData, "requestId");
  const staffNote = getString(formData, "staffNote");

  if (!requestId) {
    redirect("/app/schedule/requests?error=missing_request");
  }

  const { supabase, studioId, user } = await requireAppointmentCreateAccess();

  const { data: request, error: requestError } = await supabase
    .from("booking_requests")
    .select("id, studio_id, status, client_id, requested_starts_at")
    .eq("id", requestId)
    .eq("studio_id", studioId)
    .maybeSingle();

  if (requestError || !request) {
    redirect("/app/schedule/requests?error=request_not_found");
  }

  if ((request as { status: string }).status !== "pending") {
    redirect("/app/schedule/requests?error=request_already_reviewed");
  }

  const { error: updateError } = await supabase
    .from("booking_requests")
    .update({
      status: "declined",
      staff_note: staffNote || null,
      reviewed_by: user.id,
      reviewed_at: new Date().toISOString(),
    })
    .eq("id", requestId)
    .eq("studio_id", studioId)
    .eq("status", "pending");

  if (updateError) {
    redirect(
      `/app/schedule/requests?error=${encodeURIComponent(updateError.message)}`,
    );
  }

  const typedRequest = request as {
    id: string;
    client_id: string | null;
    requested_starts_at: string | null;
  };

  if (typedRequest.client_id && typedRequest.requested_starts_at) {
    await queueBookingDecisionEmail({
      supabase,
      studioId,
      bookingRequestId: typedRequest.id,
      clientId: typedRequest.client_id,
      status: "declined",
      requestedStartsAt: typedRequest.requested_starts_at,
      staffNote: staffNote || null,
    });
  }

  await supabase.from("notifications").insert({
    studio_id: studioId,
    type: "booking_request_declined",
    title: "Booking request declined",
    body: "A booking request was declined.",
    client_id: typedRequest.client_id,
  });

  revalidatePath("/app/schedule/requests");
  revalidatePath("/app/schedule");
  revalidatePath("/app");

  redirect("/app/schedule/requests?success=declined");
}
