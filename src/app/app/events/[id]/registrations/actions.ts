"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getStripe } from "@/lib/payments/stripe";

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>;

type EventAccessRow = {
  id: string;
  studio_id: string;
  name: string;
};

type TicketTypeRelation =
  | { name: string | null }
  | { name: string | null }[]
  | null;

type RegistrationRow = {
  id: string;
  event_id: string;
  client_id: string | null;
  attendee_first_name: string | null;
  attendee_last_name: string | null;
  attendee_email: string | null;
  attendee_phone: string | null;
  quantity: number | null;
  unit_price: number | null;
  total_price: number | null;
  total_amount: number | null;
  currency: string | null;
  status: string | null;
  payment_status: string | null;
  notes: string | null;
  checked_in_at: string | null;
  promoted_from_waitlist_at: string | null;
  event_ticket_types: TicketTypeRelation;
};

type ClientRow = {
  id: string;
};

type AttendanceLookupRow = {
  id: string;
};

type DuplicateLookupRow = {
  id: string;
};

type EventPaymentRow = {
  id: string;
  registration_id: string;
  amount: number | null;
  currency: string | null;
  payment_method: string | null;
  status: string | null;
  source: string | null;
  stripe_payment_intent_id: string | null;
  stripe_checkout_session_id: string | null;
  external_reference: string | null;
  refund_amount: number | null;
  refunded_at: string | null;
  created_at?: string | null;
};

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function buildReturnUrl(eventId: string, suffix?: string) {
  const base = `/app/events/${eventId}/registrations`;
  return suffix ? `${base}?${suffix}` : base;
}

function combineFollowUpDateTime(
  followUpDate: string,
  followUpTime: string
): string | null {
  if (!followUpDate) return null;

  const raw = followUpTime
    ? `${followUpDate}T${followUpTime}:00`
    : `${followUpDate}T09:00:00`;

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;

  return parsed.toISOString();
}

function getTicketTypeName(value: TicketTypeRelation) {
  const ticket = Array.isArray(value) ? value[0] : value;
  return ticket?.name ?? null;
}

function registrationStatusLabel(value: string | null) {
  if (!value) return "Unknown";
  if (value === "confirmed") return "Confirmed";
  if (value === "waitlisted") return "Waitlisted";
  if (value === "cancelled") return "Cancelled";
  if (value === "refunded") return "Refunded";
  if (value === "pending") return "Pending";
  if (value === "attended") return "Attended";
  if (value === "checked_in") return "Checked In";
  return value.replaceAll("_", " ");
}

function paymentStatusLabel(value: string | null) {
  if (!value) return "Unknown";
  if (value === "paid") return "Paid";
  if (value === "pending") return "Pending";
  if (value === "refunded") return "Refunded";
  if (value === "partial") return "Partial Refund";
  return value.replaceAll("_", " ");
}

function getRegistrationAmount(registration: RegistrationRow) {
  return Number(
    registration.total_amount ??
      registration.total_price ??
      registration.unit_price ??
      0
  );
}

function getRegistrationCurrency(registration: RegistrationRow) {
  return (registration.currency ?? "USD").toUpperCase();
}

function shouldBlockAttendanceForPayment(paymentStatus: string | null) {
  if (!paymentStatus) return false;
  return !["paid", "partial"].includes(paymentStatus);
}

function formatLeadOriginNote(params: {
  eventName: string;
  ticketTypeName: string | null;
  registrationStatus: string | null;
  paymentStatus: string | null;
  attendeeEmail: string;
  attendeePhone: string | null;
  registrationNotes: string | null;
  checkedInAt: string | null;
  promotedFromWaitlistAt: string | null;
}) {
  const {
    eventName,
    ticketTypeName,
    registrationStatus,
    paymentStatus,
    attendeeEmail,
    attendeePhone,
    registrationNotes,
    checkedInAt,
    promotedFromWaitlistAt,
  } = params;

  const lines = [
    "CRM Origin: Event Registration",
    `Event: ${eventName}`,
    `Ticket Type: ${ticketTypeName ?? "Not specified"}`,
    `Registration Status: ${registrationStatusLabel(registrationStatus)}`,
    `Payment Status: ${paymentStatusLabel(paymentStatus)}`,
    `Registrant Email: ${attendeeEmail || "Not provided"}`,
    `Registrant Phone: ${attendeePhone || "Not provided"}`,
  ];

  if (checkedInAt) {
    lines.push(`Checked In At: ${new Date(checkedInAt).toLocaleString()}`);
  }

  if (promotedFromWaitlistAt) {
    lines.push(
      `Promoted From Waitlist At: ${new Date(
        promotedFromWaitlistAt
      ).toLocaleString()}`
    );
  }

  if (registrationNotes) {
    lines.push("", "Registration Notes:", registrationNotes);
  }

  return lines.join("\n");
}

function formatLeadActivityNote(params: {
  eventName: string;
  ticketTypeName: string | null;
  registrationStatus: string | null;
  paymentStatus: string | null;
  followUpNote: string;
}) {
  const {
    eventName,
    ticketTypeName,
    registrationStatus,
    paymentStatus,
    followUpNote,
  } = params;

  const lines = [
    "Lead created from event registration.",
    `Event: ${eventName}`,
    `Ticket Type: ${ticketTypeName ?? "Not specified"}`,
    `Registration Status: ${registrationStatusLabel(registrationStatus)}`,
    `Payment Status: ${paymentStatusLabel(paymentStatus)}`,
  ];

  if (followUpNote) {
    lines.push("", "Follow-Up Note:", followUpNote);
  }

  return lines.join("\n");
}

async function getStudioContext() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { data: roleRow, error: roleError } = await supabase
    .from("user_studio_roles")
    .select("studio_id")
    .eq("user_id", user.id)
    .eq("active", true)
    .limit(1)
    .single();

  if (roleError || !roleRow) {
    redirect("/login");
  }

  return {
    supabase,
    studioId: roleRow.studio_id as string,
    userId: user.id,
  };
}

async function validateEventAccess(
  supabase: SupabaseServerClient,
  eventId: string,
  studioId: string
) {
  const { data: event, error } = await supabase
    .from("events")
    .select("id, studio_id, name")
    .eq("id", eventId)
    .eq("studio_id", studioId)
    .single();

  if (error || !event) {
    throw new Error("Event not found.");
  }

  return event as EventAccessRow;
}

async function getRegistrationForEvent(params: {
  supabase: SupabaseServerClient;
  eventId: string;
  registrationId: string;
}) {
  const { supabase, eventId, registrationId } = params;

  const { data: registration, error } = await supabase
    .from("event_registrations")
    .select(`
      id,
      event_id,
      client_id,
      attendee_first_name,
      attendee_last_name,
      attendee_email,
      attendee_phone,
      quantity,
      unit_price,
      total_price,
      total_amount,
      currency,
      status,
      payment_status,
      notes,
      checked_in_at,
      promoted_from_waitlist_at,
      event_ticket_types ( name )
    `)
    .eq("id", registrationId)
    .eq("event_id", eventId)
    .single();

  if (error || !registration) {
    return null;
  }

  return registration as RegistrationRow;
}

async function getPaymentsForRegistration(
  supabase: SupabaseServerClient,
  registrationId: string
) {
  const { data, error } = await supabase
    .from("event_payments")
    .select(`
      id,
      registration_id,
      amount,
      currency,
      payment_method,
      status,
      source,
      stripe_payment_intent_id,
      stripe_checkout_session_id,
      external_reference,
      refund_amount,
      refunded_at,
      created_at
    `)
    .eq("registration_id", registrationId)
    .order("created_at", { ascending: false });

  if (error) {
    throw new Error(error.message);
  }

  return (data ?? []) as EventPaymentRow[];
}

function getBestExistingPayment(payments: EventPaymentRow[]) {
  return (
    payments.find((payment) =>
      ["pending", "paid", "partial"].includes(payment.status ?? "")
    ) ?? payments[0] ?? null
  );
}

async function updateOrInsertManualPayment(params: {
  supabase: SupabaseServerClient;
  registration: RegistrationRow;
  note: string;
}) {
  const { supabase, registration, note } = params;
  const payments = await getPaymentsForRegistration(supabase, registration.id);
  const amount = getRegistrationAmount(registration);
  const currency = getRegistrationCurrency(registration);
  const existingPayment = getBestExistingPayment(payments);

  if (existingPayment) {
    const { error } = await supabase
      .from("event_payments")
      .update({
        amount,
        currency,
        payment_method: existingPayment.payment_method ?? "other",
        status: "paid",
        source: existingPayment.source ?? "manual_admin",
        refund_amount: null,
        refunded_at: null,
        notes: note,
      })
      .eq("id", existingPayment.id);

    if (error) {
      throw new Error(error.message);
    }

    return;
  }

  const { error } = await supabase.from("event_payments").insert({
    registration_id: registration.id,
    amount,
    currency,
    payment_method: "other",
    status: "paid",
    source: "manual_admin",
    notes: note,
  });

  if (error) {
    throw new Error(error.message);
  }
}

async function markAllLocalPaymentsRefunded(params: {
  supabase: SupabaseServerClient;
  payments: EventPaymentRow[];
  note: string;
}) {
  const { supabase, payments, note } = params;
  const refundedAt = new Date().toISOString();

  for (const payment of payments) {
    const amount = Number(payment.amount ?? 0);

    const { error } = await supabase
      .from("event_payments")
      .update({
        status: "refunded",
        refund_amount: amount,
        refunded_at: refundedAt,
        notes: note,
      })
      .eq("id", payment.id);

    if (error) {
      throw new Error(error.message);
    }
  }
}

async function findPossibleDuplicateClient(params: {
  supabase: SupabaseServerClient;
  studioId: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
}) {
  const { supabase, studioId, firstName, lastName, email, phone } = params;

  if (email) {
    const { data: emailMatch, error: emailError } = await supabase
      .from("clients")
      .select("id")
      .eq("studio_id", studioId)
      .eq("email", email)
      .maybeSingle<ClientRow>();

    if (emailError) {
      throw new Error(emailError.message);
    }

    if (emailMatch) {
      return { kind: "exact_email" as const, clientId: emailMatch.id };
    }
  }

  const checks: Array<
    Promise<{ data: DuplicateLookupRow[] | null; error: { message: string } | null }>
  > = [];

  if (firstName && lastName) {
    checks.push(
      (async () => {
        const { data, error } = await supabase
          .from("clients")
          .select("id")
          .eq("studio_id", studioId)
          .ilike("first_name", firstName)
          .ilike("last_name", lastName)
          .limit(1);

        return {
          data: (data ?? []) as DuplicateLookupRow[],
          error: error ? { message: error.message } : null,
        };
      })()
    );
  }

  if (phone) {
    checks.push(
      (async () => {
        const { data, error } = await supabase
          .from("clients")
          .select("id")
          .eq("studio_id", studioId)
          .eq("phone", phone)
          .limit(1);

        return {
          data: (data ?? []) as DuplicateLookupRow[],
          error: error ? { message: error.message } : null,
        };
      })()
    );
  }

  const results = await Promise.all(checks);

  for (const result of results) {
    if (result.error) {
      throw new Error(result.error.message);
    }

    if (result.data && result.data.length > 0) {
      return {
        kind: "possible_duplicate" as const,
        clientId: result.data[0].id,
      };
    }
  }

  return null;
}

async function upsertAttendanceLink(params: {
  supabase: SupabaseServerClient;
  studioId: string;
  registrationId: string;
  clientId: string;
}) {
  const { supabase, studioId, registrationId, clientId } = params;

  const { data: attendanceRecord, error: attendanceLookupError } = await supabase
    .from("attendance_records")
    .select("id")
    .eq("studio_id", studioId)
    .eq("event_registration_id", registrationId)
    .maybeSingle<AttendanceLookupRow>();

  if (attendanceLookupError) {
    throw new Error(attendanceLookupError.message);
  }

  if (!attendanceRecord) return;

  const { error: attendanceUpdateError } = await supabase
    .from("attendance_records")
    .update({
      client_id: clientId,
    })
    .eq("id", attendanceRecord.id)
    .eq("studio_id", studioId);

  if (attendanceUpdateError) {
    throw new Error(attendanceUpdateError.message);
  }
}

async function upsertAttendanceStatus(params: {
  supabase: SupabaseServerClient;
  studioId: string;
  registration: RegistrationRow;
  status: "checked_in" | "attended" | "cancelled";
  checkedInAt?: string | null;
  markedAttendedAt?: string | null;
}) {
  const {
    supabase,
    studioId,
    registration,
    status,
    checkedInAt = null,
    markedAttendedAt = null,
  } = params;

  const { data: attendanceRecord, error: attendanceLookupError } = await supabase
    .from("attendance_records")
    .select("id")
    .eq("studio_id", studioId)
    .eq("event_registration_id", registration.id)
    .maybeSingle<AttendanceLookupRow>();

  if (attendanceLookupError) {
    throw new Error(attendanceLookupError.message);
  }

  const payload = {
    studio_id: studioId,
    client_id: registration.client_id ?? null,
    event_registration_id: registration.id,
    status,
    checked_in_at: checkedInAt,
    marked_attended_at: markedAttendedAt,
  };

  if (attendanceRecord) {
    const { error } = await supabase
      .from("attendance_records")
      .update(payload)
      .eq("id", attendanceRecord.id)
      .eq("studio_id", studioId);

    if (error) {
      throw new Error(error.message);
    }

    return;
  }

  const { error } = await supabase.from("attendance_records").insert(payload);

  if (error) {
    throw new Error(error.message);
  }
}

export async function confirmEventRegistrationAction(formData: FormData) {
  const eventId = getString(formData, "eventId");
  const registrationId = getString(formData, "registrationId");

  if (!eventId || !registrationId) {
    redirect("/app/events");
  }

  try {
    const { supabase, studioId } = await getStudioContext();
    await validateEventAccess(supabase, eventId, studioId);

    const registration = await getRegistrationForEvent({
      supabase,
      eventId,
      registrationId,
    });

    if (!registration) {
      redirect(buildReturnUrl(eventId, "error=registration_not_found"));
    }

    if (["cancelled", "refunded"].includes(registration.status ?? "")) {
      redirect(buildReturnUrl(eventId, "error=confirm_failed"));
    }

    const { error } = await supabase
      .from("event_registrations")
      .update({
        status: "confirmed",
      })
      .eq("id", registrationId)
      .eq("event_id", eventId);

    if (error) {
      redirect(buildReturnUrl(eventId, "error=confirm_failed"));
    }

    redirect(buildReturnUrl(eventId, "success=confirmed"));
  } catch {
    redirect(buildReturnUrl(eventId, "error=confirm_failed"));
  }
}

export async function cancelEventRegistrationAction(formData: FormData) {
  const eventId = getString(formData, "eventId");
  const registrationId = getString(formData, "registrationId");

  if (!eventId || !registrationId) {
    redirect("/app/events");
  }

  try {
    const { supabase, studioId } = await getStudioContext();
    await validateEventAccess(supabase, eventId, studioId);

    const registration = await getRegistrationForEvent({
      supabase,
      eventId,
      registrationId,
    });

    if (!registration) {
      redirect(buildReturnUrl(eventId, "error=registration_not_found"));
    }

    const nextStatus =
      registration.payment_status === "refunded" ? "refunded" : "cancelled";

    const { error: registrationError } = await supabase
      .from("event_registrations")
      .update({
        status: nextStatus,
      })
      .eq("id", registrationId)
      .eq("event_id", eventId);

    if (registrationError) {
      redirect(buildReturnUrl(eventId, "error=cancel_failed"));
    }

    await upsertAttendanceStatus({
      supabase,
      studioId,
      registration,
      status: "cancelled",
      checkedInAt: registration.checked_in_at,
      markedAttendedAt: null,
    });

    redirect(buildReturnUrl(eventId, "success=cancelled"));
  } catch {
    redirect(buildReturnUrl(eventId, "error=cancel_failed"));
  }
}

export async function checkInEventRegistrationAction(formData: FormData) {
  const eventId = getString(formData, "eventId");
  const registrationId = getString(formData, "registrationId");

  if (!eventId || !registrationId) {
    redirect("/app/events");
  }

  try {
    const { supabase, studioId } = await getStudioContext();
    await validateEventAccess(supabase, eventId, studioId);

    const registration = await getRegistrationForEvent({
      supabase,
      eventId,
      registrationId,
    });

    if (!registration) {
      redirect(buildReturnUrl(eventId, "error=registration_not_found"));
    }

    if (["cancelled", "refunded"].includes(registration.status ?? "")) {
      redirect(buildReturnUrl(eventId, "error=cannot_check_in_cancelled"));
    }

    if (shouldBlockAttendanceForPayment(registration.payment_status)) {
      redirect(buildReturnUrl(eventId, "error=cannot_check_in_unpaid"));
    }

    const now = new Date().toISOString();

    const { error: registrationUpdateError } = await supabase
      .from("event_registrations")
      .update({
        checked_in_at: now,
        status: "checked_in",
      })
      .eq("id", registrationId)
      .eq("event_id", eventId);

    if (registrationUpdateError) {
      redirect(buildReturnUrl(eventId, "error=checkin_failed"));
    }

    await upsertAttendanceStatus({
      supabase,
      studioId,
      registration,
      status: "checked_in",
      checkedInAt: now,
      markedAttendedAt: null,
    });

    redirect(buildReturnUrl(eventId, "success=checked_in"));
  } catch {
    redirect(buildReturnUrl(eventId, "error=checkin_failed"));
  }
}

export async function markEventRegistrationAttendedAction(formData: FormData) {
  const eventId = getString(formData, "eventId");
  const registrationId = getString(formData, "registrationId");

  if (!eventId || !registrationId) {
    redirect("/app/events");
  }

  try {
    const { supabase, studioId } = await getStudioContext();
    await validateEventAccess(supabase, eventId, studioId);

    const registration = await getRegistrationForEvent({
      supabase,
      eventId,
      registrationId,
    });

    if (!registration) {
      redirect(buildReturnUrl(eventId, "error=registration_not_found"));
    }

    if (["cancelled", "refunded"].includes(registration.status ?? "")) {
      redirect(buildReturnUrl(eventId, "error=cannot_attend_cancelled"));
    }

    if (shouldBlockAttendanceForPayment(registration.payment_status)) {
      redirect(buildReturnUrl(eventId, "error=cannot_check_in_unpaid"));
    }

    const now = new Date().toISOString();
    const checkedInAt = registration.checked_in_at ?? now;

    const { error: registrationUpdateError } = await supabase
      .from("event_registrations")
      .update({
        checked_in_at: checkedInAt,
        status: "attended",
      })
      .eq("id", registrationId)
      .eq("event_id", eventId);

    if (registrationUpdateError) {
      redirect(buildReturnUrl(eventId, "error=attended_failed"));
    }

    await upsertAttendanceStatus({
      supabase,
      studioId,
      registration,
      status: "attended",
      checkedInAt,
      markedAttendedAt: now,
    });

    redirect(buildReturnUrl(eventId, "success=attended"));
  } catch {
    redirect(buildReturnUrl(eventId, "error=attended_failed"));
  }
}

export async function linkEventRegistrationToClientAction(formData: FormData) {
  const eventId = getString(formData, "eventId");
  const registrationId = getString(formData, "registrationId");
  const clientId = getString(formData, "clientId");

  if (!eventId || !registrationId || !clientId) {
    redirect("/app/events");
  }

  try {
    const { supabase, studioId } = await getStudioContext();
    await validateEventAccess(supabase, eventId, studioId);

    const { data: client, error: clientError } = await supabase
      .from("clients")
      .select("id")
      .eq("id", clientId)
      .eq("studio_id", studioId)
      .maybeSingle<ClientRow>();

    if (clientError || !client) {
      redirect(buildReturnUrl(eventId, "error=client_not_found"));
    }

    const { error: linkError } = await supabase
      .from("event_registrations")
      .update({
        client_id: clientId,
      })
      .eq("id", registrationId)
      .eq("event_id", eventId);

    if (linkError) {
      redirect(buildReturnUrl(eventId, "error=link_client_failed"));
    }

    await upsertAttendanceLink({
      supabase,
      studioId,
      registrationId,
      clientId,
    });

    redirect(buildReturnUrl(eventId, "success=linked_client"));
  } catch {
    redirect(buildReturnUrl(eventId, "error=link_client_failed"));
  }
}

export async function createLeadFromRegistrationAction(formData: FormData) {
  const eventId = getString(formData, "eventId");
  const registrationId = getString(formData, "registrationId");
  const followUpDate = getString(formData, "followUpDate");
  const followUpTime = getString(formData, "followUpTime");
  const followUpNote = getString(formData, "followUpNote");

  if (!eventId || !registrationId) {
    redirect("/app/events");
  }

  try {
    const { supabase, studioId, userId } = await getStudioContext();
    const event = await validateEventAccess(supabase, eventId, studioId);

    const registration = await getRegistrationForEvent({
      supabase,
      eventId,
      registrationId,
    });

    if (!registration) {
      redirect(buildReturnUrl(eventId, "error=registration_not_found"));
    }

    if (registration.client_id) {
      redirect(buildReturnUrl(eventId, "success=already_linked"));
    }

    const firstName = registration.attendee_first_name?.trim() ?? "";
    const lastName = registration.attendee_last_name?.trim() ?? "";
    const email = registration.attendee_email?.trim() ?? "";
    const phone = registration.attendee_phone?.trim() ?? "";
    const ticketTypeName = getTicketTypeName(registration.event_ticket_types);

    const duplicateResult = await findPossibleDuplicateClient({
      supabase,
      studioId,
      firstName,
      lastName,
      email,
      phone,
    });

    if (duplicateResult?.kind === "exact_email") {
      const { error: linkExistingError } = await supabase
        .from("event_registrations")
        .update({
          client_id: duplicateResult.clientId,
        })
        .eq("id", registrationId)
        .eq("event_id", eventId);

      if (linkExistingError) {
        redirect(buildReturnUrl(eventId, "error=lead_create_failed"));
      }

      await upsertAttendanceLink({
        supabase,
        studioId,
        registrationId,
        clientId: duplicateResult.clientId,
      });

      const followUpDueAt = combineFollowUpDateTime(followUpDate, followUpTime);

      if (followUpDueAt || followUpNote) {
        const { error: linkedActivityError } = await supabase
          .from("lead_activities")
          .insert({
            studio_id: studioId,
            client_id: duplicateResult.clientId,
            activity_type: followUpDueAt ? "follow_up" : "note",
            note: formatLeadActivityNote({
              eventName: event.name,
              ticketTypeName,
              registrationStatus: registration.status,
              paymentStatus: registration.payment_status,
              followUpNote,
            }),
            follow_up_due_at: followUpDueAt,
            created_by: userId,
          });

        if (linkedActivityError) {
          redirect(buildReturnUrl(eventId, "error=lead_activity_failed"));
        }
      }

      redirect(buildReturnUrl(eventId, "success=linked_existing_client"));
    }

    if (duplicateResult?.kind === "possible_duplicate") {
      redirect(buildReturnUrl(eventId, "error=possible_duplicate_client"));
    }

    const leadNote = formatLeadOriginNote({
      eventName: event.name,
      ticketTypeName,
      registrationStatus: registration.status,
      paymentStatus: registration.payment_status,
      attendeeEmail: email,
      attendeePhone: phone || null,
      registrationNotes: registration.notes,
      checkedInAt: registration.checked_in_at,
      promotedFromWaitlistAt: registration.promoted_from_waitlist_at,
    });

    const { data: createdLead, error: createLeadError } = await supabase
      .from("clients")
      .insert({
        studio_id: studioId,
        first_name: firstName,
        last_name: lastName,
        email: email || null,
        phone: phone || null,
        status: "lead",
        referral_source: "event_registration",
        notes: leadNote,
        created_by: userId,
      })
      .select("id")
      .single<ClientRow>();

    if (createLeadError || !createdLead) {
      redirect(buildReturnUrl(eventId, "error=lead_create_failed"));
    }

    const { error: updateRegistrationError } = await supabase
      .from("event_registrations")
      .update({
        client_id: createdLead.id,
      })
      .eq("id", registrationId)
      .eq("event_id", eventId);

    if (updateRegistrationError) {
      redirect(buildReturnUrl(eventId, "error=lead_create_failed"));
    }

    await upsertAttendanceLink({
      supabase,
      studioId,
      registrationId,
      clientId: createdLead.id,
    });

    const followUpDueAt = combineFollowUpDateTime(followUpDate, followUpTime);

    const { error: activityError } = await supabase
      .from("lead_activities")
      .insert({
        studio_id: studioId,
        client_id: createdLead.id,
        activity_type: followUpDueAt ? "follow_up" : "note",
        note: formatLeadActivityNote({
          eventName: event.name,
          ticketTypeName,
          registrationStatus: registration.status,
          paymentStatus: registration.payment_status,
          followUpNote,
        }),
        follow_up_due_at: followUpDueAt,
        created_by: userId,
      });

    if (activityError) {
      redirect(buildReturnUrl(eventId, "error=lead_activity_failed"));
    }

    redirect(buildReturnUrl(eventId, "success=lead_created"));
  } catch {
    redirect(buildReturnUrl(eventId, "error=lead_create_failed"));
  }
}

export async function markEventRegistrationPaidAction(formData: FormData) {
  const eventId = getString(formData, "eventId");
  const registrationId = getString(formData, "registrationId");

  if (!eventId || !registrationId) {
    redirect("/app/events");
  }

  try {
    const { supabase, studioId } = await getStudioContext();
    await validateEventAccess(supabase, eventId, studioId);

    const registration = await getRegistrationForEvent({
      supabase,
      eventId,
      registrationId,
    });

    if (!registration) {
      redirect(buildReturnUrl(eventId, "error=registration_not_found"));
    }

    if (registration.status === "refunded") {
      redirect(buildReturnUrl(eventId, "error=payment_update_failed"));
    }

    const nextStatus =
      registration.status === "attended" || registration.status === "checked_in"
        ? registration.status
        : "confirmed";

    const { error: registrationError } = await supabase
      .from("event_registrations")
      .update({
        payment_status: "paid",
        status: nextStatus,
      })
      .eq("id", registrationId)
      .eq("event_id", eventId);

    if (registrationError) {
      redirect(buildReturnUrl(eventId, "error=payment_update_failed"));
    }

    await updateOrInsertManualPayment({
      supabase,
      registration,
      note: "Marked paid manually from admin registrations.",
    });

    redirect(buildReturnUrl(eventId, "success=payment_updated"));
  } catch {
    redirect(buildReturnUrl(eventId, "error=payment_update_failed"));
  }
}

export async function refundEventRegistrationAction(formData: FormData) {
  const eventId = getString(formData, "eventId");
  const registrationId = getString(formData, "registrationId");

  if (!eventId || !registrationId) {
    redirect("/app/events");
  }

  try {
    const { supabase, studioId } = await getStudioContext();
    await validateEventAccess(supabase, eventId, studioId);

    const registration = await getRegistrationForEvent({
      supabase,
      eventId,
      registrationId,
    });

    if (!registration) {
      redirect(buildReturnUrl(eventId, "error=registration_not_found"));
    }

    const payments = await getPaymentsForRegistration(supabase, registrationId);
    const stripePayment = payments.find(
      (payment) =>
        !!payment.stripe_payment_intent_id &&
        payment.status !== "refunded"
    );

    if (stripePayment?.stripe_payment_intent_id) {
      const stripe = getStripe();

      await stripe.refunds.create({
        payment_intent: stripePayment.stripe_payment_intent_id,
      });
    } else if (payments.length > 0) {
      await markAllLocalPaymentsRefunded({
        supabase,
        payments,
        note: "Refund marked from admin registrations.",
      });
    }

    const { error: registrationError } = await supabase
      .from("event_registrations")
      .update({
        payment_status: "refunded",
        status: "refunded",
      })
      .eq("id", registrationId)
      .eq("event_id", eventId);

    if (registrationError) {
      redirect(buildReturnUrl(eventId, "error=refund_failed"));
    }

    if (payments.length === 0) {
      const amount = getRegistrationAmount(registration);

      if (amount > 0) {
        const { error: insertError } = await supabase.from("event_payments").insert({
          registration_id: registration.id,
          amount,
          currency: getRegistrationCurrency(registration),
          payment_method: "other",
          status: "refunded",
          source: "manual_admin",
          refund_amount: amount,
          refunded_at: new Date().toISOString(),
          notes: "Refund recorded from admin registrations with no prior payment row.",
        });

        if (insertError) {
          redirect(buildReturnUrl(eventId, "error=refund_failed"));
        }
      }
    }

    redirect(buildReturnUrl(eventId, "success=refunded"));
  } catch {
    redirect(buildReturnUrl(eventId, "error=refund_failed"));
  }
}