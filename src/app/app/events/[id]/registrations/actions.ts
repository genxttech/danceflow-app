"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getStripe } from "@/lib/payments/stripe";
import { getCurrentStudioContext } from "@/lib/auth/studio";

type RegistrationRow = {
  id: string;
  event_id: string;
  client_id: string | null;
  attendee_first_name: string;
  attendee_last_name: string;
  attendee_email: string;
  attendee_phone: string | null;
  status: string;
  payment_status: string | null;
  total_amount: number | null;
  total_price: number | null;
  currency: string | null;
  checked_in_at: string | null;
  stripe_payment_intent_id: string | null;
};

type ClientRow = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
};

type AttendanceLookupRow = {
  id: string;
};

type EventPaymentRow = {
  id: string;
};

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function buildReturnUrl(eventId: string, suffix?: string) {
  const base = `/app/events/${eventId}/registrations`;
  if (!suffix) return base;
  return `${base}?${suffix}`;
}

function resolveReturnUrl(params: {
  eventId: string;
  returnTo?: string;
  fallbackSuffix?: string;
}) {
  const { eventId, returnTo, fallbackSuffix } = params;

  if (returnTo && returnTo.startsWith(`/app/events/${eventId}/`)) {
    if (!fallbackSuffix) return returnTo;

    const separator = returnTo.includes("?") ? "&" : "?";
    return `${returnTo}${separator}${fallbackSuffix}`;
  }

  return buildReturnUrl(eventId, fallbackSuffix);
}

function shouldBlockAttendanceForPayment(paymentStatus: string | null) {
  return paymentStatus === "pending" || paymentStatus === "unpaid";
}

async function getStudioContext() {
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
    userId: user.id,
  };
}

async function validateEventAccess(
  supabase: Awaited<ReturnType<typeof createClient>>,
  eventId: string,
  studioId: string
) {
  const { data: event, error } = await supabase
    .from("events")
    .select("id")
    .eq("id", eventId)
    .eq("studio_id", studioId)
    .maybeSingle();

  if (error || !event) {
    redirect("/app/events");
  }

  return event;
}

async function getRegistrationForEvent(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  eventId: string;
  registrationId: string;
}) {
  const { supabase, eventId, registrationId } = params;

  const { data, error } = await supabase
    .from("event_registrations")
    .select(`
      id,
      event_id,
      client_id,
      attendee_first_name,
      attendee_last_name,
      attendee_email,
      attendee_phone,
      status,
      payment_status,
      total_amount,
      total_price,
      currency,
      checked_in_at,
      stripe_payment_intent_id
    `)
    .eq("id", registrationId)
    .eq("event_id", eventId)
    .maybeSingle<RegistrationRow>();

  if (error) {
    throw new Error(error.message);
  }

  return data ?? null;
}

async function upsertAttendanceLink(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  studioId: string;
  registrationId: string;
  clientId: string;
}) {
  const { supabase, studioId, registrationId, clientId } = params;

  const { data: existing, error: existingError } = await supabase
    .from("attendance_records")
    .select("id")
    .eq("studio_id", studioId)
    .eq("event_registration_id", registrationId)
    .maybeSingle<AttendanceLookupRow>();

  if (existingError) {
    throw new Error(existingError.message);
  }

  if (existing) {
    const { error: updateError } = await supabase
      .from("attendance_records")
      .update({
        client_id: clientId,
      })
      .eq("id", existing.id)
      .eq("studio_id", studioId);

    if (updateError) {
      throw new Error(updateError.message);
    }

    return existing.id;
  }

  const { data: inserted, error: insertError } = await supabase
    .from("attendance_records")
    .insert({
      studio_id: studioId,
      event_registration_id: registrationId,
      client_id: clientId,
      status: "registered",
    })
    .select("id")
    .single<AttendanceLookupRow>();

  if (insertError) {
    throw new Error(insertError.message);
  }

  return inserted.id;
}

async function upsertAttendanceStatus(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  studioId: string;
  registration: RegistrationRow;
  status: string;
  checkedInAt?: string | null;
  markedAttendedAt?: string | null;
}) {
  const { supabase, studioId, registration, status, checkedInAt, markedAttendedAt } =
    params;

  if (!registration.client_id) {
    return null;
  }

  const { data: existing, error: existingError } = await supabase
    .from("attendance_records")
    .select("id")
    .eq("studio_id", studioId)
    .eq("event_registration_id", registration.id)
    .maybeSingle<AttendanceLookupRow>();

  if (existingError) {
    throw new Error(existingError.message);
  }

  const payload = {
    studio_id: studioId,
    client_id: registration.client_id,
    event_registration_id: registration.id,
    status,
    checked_in_at: checkedInAt ?? null,
    marked_attended_at: markedAttendedAt ?? null,
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

    return existing.id;
  }

  const { data: inserted, error: insertError } = await supabase
    .from("attendance_records")
    .insert(payload)
    .select("id")
    .single<AttendanceLookupRow>();

  if (insertError) {
    throw new Error(insertError.message);
  }

  return inserted.id;
}

async function ensureClientInStudio(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  studioId: string;
  clientId: string;
}) {
  const { supabase, studioId, clientId } = params;

  const { data: client, error } = await supabase
    .from("clients")
    .select("id, first_name, last_name, email, phone")
    .eq("id", clientId)
    .eq("studio_id", studioId)
    .maybeSingle<ClientRow>();

  if (error) {
    throw new Error(error.message);
  }

  return client ?? null;
}

async function logEventPayment(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  registration: RegistrationRow;
  studioId: string;
  amount: number;
  currency: string;
  paymentMethod?: string;
  status?: string;
  source?: string;
  stripePaymentIntentId?: string | null;
}) {
  const {
    supabase,
    registration,
    studioId,
    amount,
    currency,
    paymentMethod = "other",
    status = "paid",
    source = "event_registration",
    stripePaymentIntentId = null,
  } = params;

  const { error } = await supabase.from("event_payments").insert({
    event_id: registration.event_id,
    registration_id: registration.id,
    studio_id: studioId,
    amount,
    currency,
    payment_method: paymentMethod,
    status,
    source,
    stripe_payment_intent_id: stripePaymentIntentId,
  });

  if (error) {
    throw new Error(error.message);
  }
}

async function createLeadFromRegistration(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  studioId: string;
  userId: string;
  registration: RegistrationRow;
}) {
  const { supabase, studioId, userId, registration } = params;

  const { error } = await supabase.from("leads").insert({
    studio_id: studioId,
    first_name: registration.attendee_first_name || "Event",
    last_name: registration.attendee_last_name || "Registrant",
    email: registration.attendee_email || null,
    phone: registration.attendee_phone || null,
    lead_source: "event_registration",
    status: "new",
    notes: `Created from event registration ${registration.id}`,
    created_by: userId,
  });

  if (error) {
    throw new Error(error.message);
  }
}

async function markRegistrationPaymentStatus(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  eventId: string;
  registrationId: string;
  paymentStatus: string;
  registrationStatus?: string;
}) {
  const { supabase, eventId, registrationId, paymentStatus, registrationStatus } = params;

  const payload: Record<string, string> = {
    payment_status: paymentStatus,
  };

  if (registrationStatus) {
    payload.status = registrationStatus;
  }

  const { error } = await supabase
    .from("event_registrations")
    .update(payload)
    .eq("id", registrationId)
    .eq("event_id", eventId);

  if (error) {
    throw new Error(error.message);
  }
}

async function findLatestPaymentForRegistration(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  registrationId: string;
}) {
  const { supabase, registrationId } = params;

  const { data, error } = await supabase
    .from("event_payments")
    .select("id")
    .eq("registration_id", registrationId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle<EventPaymentRow>();

  if (error) {
    throw new Error(error.message);
  }

  return data ?? null;
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

    const { error } = await supabase
      .from("event_registrations")
      .update({ status: "confirmed" })
      .eq("id", registrationId)
      .eq("event_id", eventId);

    if (error) {
      throw new Error(error.message);
    }

    redirect(buildReturnUrl(eventId, "success=registration_confirmed"));
  } catch {
    redirect(buildReturnUrl(eventId, "error=registration_confirm_failed"));
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

    const { error: registrationError } = await supabase
      .from("event_registrations")
      .update({
        status: "cancelled",
      })
      .eq("id", registrationId)
      .eq("event_id", eventId);

    if (registrationError) {
      throw new Error(registrationError.message);
    }

    const { data: existingAttendance, error: attendanceLookupError } = await supabase
      .from("attendance_records")
      .select("id")
      .eq("studio_id", studioId)
      .eq("event_registration_id", registrationId)
      .maybeSingle<AttendanceLookupRow>();

    if (attendanceLookupError) {
      throw new Error(attendanceLookupError.message);
    }

    if (existingAttendance) {
      const { error: attendanceUpdateError } = await supabase
        .from("attendance_records")
        .update({
          status: "cancelled",
        })
        .eq("id", existingAttendance.id)
        .eq("studio_id", studioId);

      if (attendanceUpdateError) {
        throw new Error(attendanceUpdateError.message);
      }
    }

    redirect(buildReturnUrl(eventId, "success=registration_cancelled"));
  } catch {
    redirect(buildReturnUrl(eventId, "error=registration_cancel_failed"));
  }
}

export async function checkInEventRegistrationAction(formData: FormData) {
  const eventId = getString(formData, "eventId");
  const registrationId = getString(formData, "registrationId");
  const returnTo = getString(formData, "returnTo");

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
      redirect(
        resolveReturnUrl({
          eventId,
          returnTo,
          fallbackSuffix: "error=registration_not_found",
        })
      );
    }

    if (["cancelled", "refunded"].includes(registration.status ?? "")) {
      redirect(
        resolveReturnUrl({
          eventId,
          returnTo,
          fallbackSuffix: "error=cannot_check_in_cancelled",
        })
      );
    }

    if (shouldBlockAttendanceForPayment(registration.payment_status)) {
      redirect(
        resolveReturnUrl({
          eventId,
          returnTo,
          fallbackSuffix: "error=cannot_check_in_unpaid",
        })
      );
    }

    if (registration.checked_in_at || registration.status === "checked_in") {
      redirect(
        resolveReturnUrl({
          eventId,
          returnTo,
          fallbackSuffix: "success=already_checked_in",
        })
      );
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
      throw new Error(registrationUpdateError.message);
    }

    await upsertAttendanceStatus({
      supabase,
      studioId,
      registration,
      status: "checked_in",
      checkedInAt: now,
      markedAttendedAt: null,
    });

    redirect(
      resolveReturnUrl({
        eventId,
        returnTo,
        fallbackSuffix: "success=checked_in",
      })
    );
  } catch {
    redirect(
      resolveReturnUrl({
        eventId,
        returnTo,
        fallbackSuffix: "error=checkin_failed",
      })
    );
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

    const checkedInAt = registration.checked_in_at ?? new Date().toISOString();
    const markedAttendedAt = new Date().toISOString();

    const { error: registrationUpdateError } = await supabase
      .from("event_registrations")
      .update({
        checked_in_at: checkedInAt,
        status: "attended",
      })
      .eq("id", registrationId)
      .eq("event_id", eventId);

    if (registrationUpdateError) {
      throw new Error(registrationUpdateError.message);
    }

    await upsertAttendanceStatus({
      supabase,
      studioId,
      registration: {
        ...registration,
        checked_in_at: checkedInAt,
      },
      status: "attended",
      checkedInAt,
      markedAttendedAt,
    });

    redirect(buildReturnUrl(eventId, "success=marked_attended"));
  } catch {
    redirect(buildReturnUrl(eventId, "error=mark_attended_failed"));
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

    const registration = await getRegistrationForEvent({
      supabase,
      eventId,
      registrationId,
    });

    if (!registration) {
      redirect(buildReturnUrl(eventId, "error=registration_not_found"));
    }

    const client = await ensureClientInStudio({
      supabase,
      studioId,
      clientId,
    });

    if (!client) {
      redirect(buildReturnUrl(eventId, "error=client_not_found"));
    }

    const { error: registrationUpdateError } = await supabase
      .from("event_registrations")
      .update({
        client_id: client.id,
      })
      .eq("id", registrationId)
      .eq("event_id", eventId);

    if (registrationUpdateError) {
      throw new Error(registrationUpdateError.message);
    }

    await upsertAttendanceLink({
      supabase,
      studioId,
      registrationId,
      clientId: client.id,
    });

    redirect(buildReturnUrl(eventId, "success=registration_linked"));
  } catch {
    redirect(buildReturnUrl(eventId, "error=link_client_failed"));
  }
}

export async function upsertEventAttendanceAction(formData: FormData) {
  const eventId = getString(formData, "eventId");
  const registrationId = getString(formData, "registrationId");
  const clientId = getString(formData, "clientId");
  const status = getString(formData, "status") as
    | "registered"
    | "checked_in"
    | "attended"
    | "no_show"
    | "cancelled";

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

    let nextClientId = registration.client_id ?? null;

    if (clientId) {
      const client = await ensureClientInStudio({
        supabase,
        studioId,
        clientId,
      });

      if (!client) {
        redirect(buildReturnUrl(eventId, "error=client_not_found"));
      }

      nextClientId = client.id;
    }

    const checkedInAt =
      status === "checked_in" || status === "attended"
        ? registration.checked_in_at ?? new Date().toISOString()
        : null;

    const registrationStatus =
      status === "cancelled"
        ? "cancelled"
        : status === "attended"
          ? "attended"
          : status === "checked_in"
            ? "checked_in"
            : registration.status === "confirmed"
              ? "confirmed"
              : "confirmed";

    const { error: registrationUpdateError } = await supabase
      .from("event_registrations")
      .update({
        client_id: nextClientId,
        status: registrationStatus,
        checked_in_at: checkedInAt,
      })
      .eq("id", registrationId)
      .eq("event_id", eventId);

    if (registrationUpdateError) {
      throw new Error(registrationUpdateError.message);
    }

    if (nextClientId) {
      await upsertAttendanceLink({
        supabase,
        studioId,
        registrationId,
        clientId: nextClientId,
      });
    }

    if (status === "registered") {
      const { data: attendanceRecord, error: attendanceLookupError } = await supabase
        .from("attendance_records")
        .select("id")
        .eq("studio_id", studioId)
        .eq("event_registration_id", registrationId)
        .maybeSingle<AttendanceLookupRow>();

      if (attendanceLookupError) {
        throw new Error(attendanceLookupError.message);
      }

      if (attendanceRecord) {
        const { error: resetError } = await supabase
          .from("attendance_records")
          .update({
            client_id: nextClientId,
            status: "registered",
            checked_in_at: null,
            marked_attended_at: null,
          })
          .eq("id", attendanceRecord.id)
          .eq("studio_id", studioId);

        if (resetError) {
          throw new Error(resetError.message);
        }
      }

      redirect(buildReturnUrl(eventId, "success=attendance_updated"));
    }

    await upsertAttendanceStatus({
      supabase,
      studioId,
      registration: {
        ...registration,
        client_id: nextClientId,
        checked_in_at: checkedInAt,
      },
      status,
      checkedInAt,
      markedAttendedAt: status === "attended" ? new Date().toISOString() : null,
    });

    redirect(buildReturnUrl(eventId, "success=attendance_updated"));
  } catch {
    redirect(buildReturnUrl(eventId, "error=attendance_update_failed"));
  }
}

export async function createLeadFromRegistrationAction(formData: FormData) {
  const eventId = getString(formData, "eventId");
  const registrationId = getString(formData, "registrationId");

  if (!eventId || !registrationId) {
    redirect("/app/events");
  }

  try {
    const { supabase, studioId, userId } = await getStudioContext();
    await validateEventAccess(supabase, eventId, studioId);

    const registration = await getRegistrationForEvent({
      supabase,
      eventId,
      registrationId,
    });

    if (!registration) {
      redirect(buildReturnUrl(eventId, "error=registration_not_found"));
    }

    await createLeadFromRegistration({
      supabase,
      studioId,
      userId,
      registration,
    });

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

    const amount = Number(registration.total_amount ?? registration.total_price ?? 0);
    const currency = registration.currency ?? "USD";

    await markRegistrationPaymentStatus({
      supabase,
      eventId,
      registrationId,
      paymentStatus: "paid",
      registrationStatus: registration.status === "pending" ? "confirmed" : undefined,
    });

    if (amount > 0) {
      await logEventPayment({
        supabase,
        registration,
        studioId,
        amount,
        currency,
        paymentMethod: "other",
        status: "paid",
        source: "manual_admin_mark_paid",
        stripePaymentIntentId: registration.stripe_payment_intent_id,
      });
    }

    redirect(buildReturnUrl(eventId, "success=registration_paid"));
  } catch {
    redirect(buildReturnUrl(eventId, "error=mark_paid_failed"));
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

    const amount = Number(registration.total_amount ?? registration.total_price ?? 0);
    const currency = registration.currency ?? "USD";

    if (registration.stripe_payment_intent_id) {
      const stripe = getStripe();
      await stripe.refunds.create({
        payment_intent: registration.stripe_payment_intent_id,
      });
    }

    await markRegistrationPaymentStatus({
      supabase,
      eventId,
      registrationId,
      paymentStatus: "refunded",
      registrationStatus: "cancelled",
    });

    const latestPayment = await findLatestPaymentForRegistration({
      supabase,
      registrationId,
    });

    if (latestPayment) {
      const { error: paymentUpdateError } = await supabase
        .from("event_payments")
        .update({
          status: "refunded",
          refund_amount: amount,
          refunded_at: new Date().toISOString(),
        })
        .eq("id", latestPayment.id);

      if (paymentUpdateError) {
        throw new Error(paymentUpdateError.message);
      }
    } else if (amount > 0) {
      await logEventPayment({
        supabase,
        registration,
        studioId,
        amount,
        currency,
        paymentMethod: "other",
        status: "refunded",
        source: "refund",
        stripePaymentIntentId: registration.stripe_payment_intent_id,
      });

      const latestInserted = await findLatestPaymentForRegistration({
        supabase,
        registrationId,
      });

      if (latestInserted) {
        const { error: paymentUpdateError } = await supabase
          .from("event_payments")
          .update({
            refund_amount: amount,
            refunded_at: new Date().toISOString(),
          })
          .eq("id", latestInserted.id);

        if (paymentUpdateError) {
          throw new Error(paymentUpdateError.message);
        }
      }
    }

    const { data: existingAttendance, error: attendanceLookupError } = await supabase
      .from("attendance_records")
      .select("id")
      .eq("studio_id", studioId)
      .eq("event_registration_id", registrationId)
      .maybeSingle<AttendanceLookupRow>();

    if (attendanceLookupError) {
      throw new Error(attendanceLookupError.message);
    }

    if (existingAttendance) {
      const { error: attendanceUpdateError } = await supabase
        .from("attendance_records")
        .update({
          status: "cancelled",
        })
        .eq("id", existingAttendance.id)
        .eq("studio_id", studioId);

      if (attendanceUpdateError) {
        throw new Error(attendanceUpdateError.message);
      }
    }

    redirect(buildReturnUrl(eventId, "success=registration_refunded"));
  } catch {
    redirect(buildReturnUrl(eventId, "error=refund_failed"));
  }
}