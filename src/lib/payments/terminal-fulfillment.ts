import { randomUUID } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

type FulfillTerminalPaymentParams = {
  supabase: SupabaseClient;
  studioId: string;
  paymentId: string;
  sessionId: string;
  paymentIntentId: string;
  paidAt?: string;
};

type TerminalEventRegistration = {
  id: string;
  event_id: string;
  studio_id: string;
  client_id: string | null;
  ticket_type_id: string | null;
  quantity: number | null;
  attendee_first_name: string | null;
  attendee_last_name: string | null;
  attendee_email: string | null;
  attendee_phone: string | null;
  total_amount: number | null;
  total_price: number | null;
  currency: string | null;
};

type TerminalEventTicketType = {
  id: string;
  name: string | null;
  attendees_per_ticket: number | null;
};

function makeTicketCode() {
  return `DF-${randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`;
}

function makeTicketToken() {
  return randomUUID().replaceAll("-", "");
}

function dollarsToCents(value: number | string | null | undefined) {
  return Math.round(Number(value ?? 0) * 100);
}

function normalizeCurrency(value: string | null | undefined) {
  return (value || "usd").trim().toLowerCase();
}

async function ensureTerminalEventRegistrationFulfillment(params: {
  supabase: SupabaseClient;
  studioId: string;
  registration: TerminalEventRegistration;
}) {
  const { supabase, studioId, registration } = params;

  if (!registration.ticket_type_id) {
    throw new Error(
      "Terminal payment event registration fulfillment failed: registration is missing a ticket type.",
    );
  }

  const now = new Date().toISOString();
  const quantity = Math.max(1, Number(registration.quantity ?? 1));
  const totalAmount = Number(
    registration.total_amount ?? registration.total_price ?? 0,
  );
  const unitPrice = quantity > 0 ? totalAmount / quantity : totalAmount;

  const { data: ticketType, error: ticketTypeError } = await supabase
    .from("event_ticket_types")
    .select("id, name, attendees_per_ticket")
    .eq("id", registration.ticket_type_id)
    .maybeSingle<TerminalEventTicketType>();

  if (ticketTypeError || !ticketType) {
    throw new Error(
      `Terminal payment event ticket lookup failed: ${
        ticketTypeError?.message ?? "ticket type not found"
      }`,
    );
  }

  const { data: existingItems, error: itemLookupError } = await supabase
    .from("event_registration_items")
    .select("id")
    .eq("registration_id", registration.id)
    .limit(1);

  if (itemLookupError) {
    throw new Error(
      `Terminal payment event ticket item lookup failed: ${itemLookupError.message}`,
    );
  }

  if (!existingItems?.length) {
    const { error: itemInsertError } = await supabase
      .from("event_registration_items")
      .insert({
        registration_id: registration.id,
        ticket_type_id: registration.ticket_type_id,
        ticket_name_snapshot: ticketType.name || "Event ticket",
        quantity,
        unit_price: unitPrice,
        line_total: totalAmount,
      });

    if (itemInsertError) {
      throw new Error(
        `Terminal payment event ticket item setup failed: ${itemInsertError.message}`,
      );
    }
  }

  const attendeesPerTicket = Math.max(
    1,
    Number(ticketType.attendees_per_ticket ?? 1),
  );
  const expectedAttendees = Math.max(1, quantity * attendeesPerTicket);

  const { data: existingAttendees, error: attendeeLookupError } = await supabase
    .from("event_registration_attendees")
    .select("id, sort_order, ticket_code, ticket_token, ticket_issued_at")
    .eq("registration_id", registration.id);

  if (attendeeLookupError) {
    throw new Error(
      `Terminal payment event attendee lookup failed: ${attendeeLookupError.message}`,
    );
  }

  const attendeesBySortOrder = new Map<number, { id: string }>();
  for (const attendee of existingAttendees ?? []) {
    const sortOrder = Number(attendee.sort_order ?? 1);
    if (!attendeesBySortOrder.has(sortOrder)) {
      attendeesBySortOrder.set(sortOrder, attendee);
    }
  }

  const attendeesToInsert = [];
  for (let slot = 1; slot <= expectedAttendees; slot += 1) {
    if (attendeesBySortOrder.has(slot)) continue;

    attendeesToInsert.push({
      registration_id: registration.id,
      event_id: registration.event_id,
      ticket_type_id: registration.ticket_type_id,
      first_name:
        slot === 1 ? registration.attendee_first_name || "Guest" : "Guest",
      last_name:
        slot === 1 ? registration.attendee_last_name || "Attendee" : `${slot}`,
      email: registration.attendee_email || null,
      phone: registration.attendee_phone || null,
      attendee_role: "attendee",
      sort_order: slot,
      ticket_code: makeTicketCode(),
      ticket_token: makeTicketToken(),
      ticket_issued_at: now,
    });
  }

  if (attendeesToInsert.length) {
    const { error: attendeeInsertError } = await supabase
      .from("event_registration_attendees")
      .insert(attendeesToInsert);

    if (attendeeInsertError) {
      throw new Error(
        `Terminal payment event attendee setup failed: ${attendeeInsertError.message}`,
      );
    }
  }

  const ticketUpdateResults = await Promise.all(
    (existingAttendees ?? [])
      .filter((attendee) => !attendee.ticket_code || !attendee.ticket_token)
      .map((attendee) =>
        supabase
          .from("event_registration_attendees")
          .update({
            ticket_code: attendee.ticket_code || makeTicketCode(),
            ticket_token: attendee.ticket_token || makeTicketToken(),
            ticket_issued_at: attendee.ticket_issued_at || now,
          })
          .eq("id", attendee.id),
      ),
  );

  const ticketUpdateError = ticketUpdateResults.find((result) => result.error);
  if (ticketUpdateError?.error) {
    throw new Error(
      `Terminal payment event ticket activation failed: ${ticketUpdateError.error.message}`,
    );
  }

  if (!registration.client_id) return;

  const { data: existingAttendance, error: attendanceLookupError } =
    await supabase
      .from("attendance_records")
      .select("id")
      .eq("studio_id", studioId)
      .eq("event_registration_id", registration.id)
      .limit(1);

  if (attendanceLookupError) {
    throw new Error(
      `Terminal payment event attendance lookup failed: ${attendanceLookupError.message}`,
    );
  }

  if (existingAttendance?.length) return;

  const { error: attendanceInsertError } = await supabase
    .from("attendance_records")
    .insert({
      studio_id: studioId,
      event_registration_id: registration.id,
      client_id: registration.client_id,
      status: "registered",
    });

  if (attendanceInsertError) {
    throw new Error(
      `Terminal payment event attendance setup failed: ${attendanceInsertError.message}`,
    );
  }
}

export async function fulfillTerminalPayment({
  supabase,
  studioId,
  paymentId,
  sessionId,
  paymentIntentId,
  paidAt = new Date().toISOString(),
}: FulfillTerminalPaymentParams) {
  const { data: payment, error: paymentLookupError } = await supabase
    .from("payments")
    .select(
      "id, studio_id, amount, currency, status, client_package_id, payment_type, external_reference",
    )
    .eq("id", paymentId)
    .eq("studio_id", studioId)
    .single();

  if (paymentLookupError || !payment) {
    throw new Error(
      `Terminal payment fulfillment failed: ${paymentLookupError?.message ?? "payment not found"}`,
    );
  }

  const { data: session, error: sessionLookupError } = await supabase
    .from("terminal_payment_sessions")
    .select(
      "id, studio_id, payment_id, amount_cents, currency, stripe_payment_intent_id",
    )
    .eq("id", sessionId)
    .eq("studio_id", studioId)
    .eq("payment_id", paymentId)
    .eq("stripe_payment_intent_id", paymentIntentId)
    .maybeSingle();

  if (sessionLookupError || !session) {
    throw new Error(
      `Terminal payment fulfillment failed: ${sessionLookupError?.message ?? "terminal session not found"}`,
    );
  }

  const expectedAmountCents = dollarsToCents(payment.amount);
  const sessionAmountCents = Number(session.amount_cents ?? 0);

  if (expectedAmountCents !== sessionAmountCents) {
    throw new Error(
      "Terminal payment fulfillment failed: payment amount does not match terminal session.",
    );
  }

  if (
    normalizeCurrency(payment.currency) !== normalizeCurrency(session.currency)
  ) {
    throw new Error(
      "Terminal payment fulfillment failed: payment currency does not match terminal session.",
    );
  }

  const { error } = await supabase
    .from("payments")
    .update({
      status: "paid",
      paid_at: paidAt,
      payment_method: "card",
      source: "stripe",
      payment_channel: "terminal",
      terminal_payment_session_id: sessionId,
      stripe_payment_intent_id: paymentIntentId,
    })
    .eq("id", paymentId)
    .eq("studio_id", studioId)
    .neq("status", "paid");

  if (error) {
    throw new Error(`Terminal payment fulfillment failed: ${error.message}`);
  }

  if (payment.client_package_id) {
    const { error: packageError } = await supabase
      .from("client_packages")
      .update({ active: true })
      .eq("id", payment.client_package_id)
      .eq("studio_id", studioId);

    if (packageError) {
      throw new Error(
        `Terminal payment package fulfillment failed: ${packageError.message}`,
      );
    }
  }

  if (
    payment.external_reference &&
    payment.payment_type === "pay_as_you_go_lesson"
  ) {
    const { error: appointmentError } = await supabase
      .from("appointments")
      .update({ payment_status: "paid" })
      .eq("id", payment.external_reference)
      .eq("studio_id", studioId);

    if (appointmentError) {
      throw new Error(
        `Terminal payment lesson fulfillment failed: ${appointmentError.message}`,
      );
    }
  }

  if (
    payment.external_reference &&
    payment.payment_type === "event_registration"
  ) {
    const { data: registration, error: registrationError } = await supabase
      .from("event_registrations")
      .update({
        status: "confirmed",
        payment_status: "paid",
        stripe_payment_intent_id: paymentIntentId,
      })
      .eq("id", payment.external_reference)
      .eq("studio_id", studioId)
      .select(
        `
        id,
        event_id,
        studio_id,
        client_id,
        ticket_type_id,
        quantity,
        attendee_first_name,
        attendee_last_name,
        attendee_email,
        attendee_phone,
        total_amount,
        total_price,
        currency
      `,
      )
      .single<TerminalEventRegistration>();

    if (registrationError || !registration) {
      throw new Error(
        `Terminal payment event registration fulfillment failed: ${
          registrationError?.message ?? "registration not found"
        }`,
      );
    }

    await ensureTerminalEventRegistrationFulfillment({
      supabase,
      studioId,
      registration,
    });

    const { data: existingEventPayment, error: eventPaymentLookupError } =
      await supabase
        .from("event_payments")
        .select("id")
        .eq("registration_id", payment.external_reference)
        .eq("stripe_payment_intent_id", paymentIntentId)
        .maybeSingle();

    if (eventPaymentLookupError) {
      throw new Error(
        `Terminal payment event payment lookup failed: ${eventPaymentLookupError.message}`,
      );
    }

    if (existingEventPayment?.id) {
      const { error: eventPaymentUpdateError } = await supabase
        .from("event_payments")
        .update({
          amount: Number(payment.amount ?? 0),
          currency: payment.currency ?? registration.currency ?? "usd",
          payment_method: "card",
          status: "paid",
          source: "terminal_ticket_sale",
        })
        .eq("id", existingEventPayment.id);

      if (eventPaymentUpdateError) {
        throw new Error(
          `Terminal payment event payment update failed: ${eventPaymentUpdateError.message}`,
        );
      }
    } else {
      const { error: eventPaymentInsertError } = await supabase
        .from("event_payments")
        .insert({
          event_id: registration.event_id,
          registration_id: payment.external_reference,
          amount: Number(payment.amount ?? 0),
          currency: payment.currency ?? registration.currency ?? "usd",
          payment_method: "card",
          status: "paid",
          source: "terminal_ticket_sale",
          stripe_payment_intent_id: paymentIntentId,
        });

      if (eventPaymentInsertError) {
        throw new Error(
          `Terminal payment event payment insert failed: ${eventPaymentInsertError.message}`,
        );
      }
    }
  }

  return true;
}
