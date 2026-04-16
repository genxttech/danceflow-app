 "use server";

import { redirect } from "next/navigation";
import { isRedirectError } from "next/dist/client/components/redirect-error";
import { createClient } from "@/lib/supabase/server";
import { getStripe } from "@/lib/payments/stripe";

type ActionState = {
  error: string;
  success: string;
};

const initialState: ActionState = {
  error: "",
  success: "",
};

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function getInt(formData: FormData, key: string, fallback = 1) {
  const raw = getString(formData, key);
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function appendQueryParam(url: string, key: string, value: string) {
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}${key}=${encodeURIComponent(value)}`;
}

async function getStudioConnectStatus(studioId: string) {
  const supabase = await createClient();

  const { data: studio, error } = await supabase
    .from("studios")
    .select(
      `
      id,
      stripe_connected_account_id,
      stripe_connect_details_submitted,
      stripe_connect_charges_enabled,
      stripe_connect_payouts_enabled,
      stripe_connect_onboarding_complete
    `
    )
    .eq("id", studioId)
    .single();

  if (error || !studio) {
    throw new Error("Could not load the studio payment profile.");
  }

  return {
    connectedAccountId: studio.stripe_connected_account_id ?? null,
    detailsSubmitted: studio.stripe_connect_details_submitted ?? false,
    chargesEnabled: studio.stripe_connect_charges_enabled ?? false,
    payoutsEnabled: studio.stripe_connect_payouts_enabled ?? false,
    onboardingComplete: studio.stripe_connect_onboarding_complete ?? false,
  };
}

async function requireStudioConnectReadyForCheckout(studioId: string) {
  const status = await getStudioConnectStatus(studioId);

  if (!status.connectedAccountId) {
    throw new Error(
      "This studio has not connected Stripe yet. Online ticket sales are not available."
    );
  }

  if (!status.onboardingComplete || !status.payoutsEnabled) {
    throw new Error(
      "This studio has not completed Stripe payout setup yet. Online ticket sales are not available."
    );
  }

  return status;
}

async function createStripeCheckoutSession(params: {
  studioId: string;
  eventId: string;
  eventSlug: string;
  eventName: string;
  registrationId: string;
  ticketTypeId: string;
  ticketTypeName: string;
  ticketKind: string | null;
  attendeeEmail: string;
  quantity: number;
  unitPrice: number;
  currency: string;
}) {
  const stripe = getStripe();
  const connectStatus = await requireStudioConnectReadyForCheckout(params.studioId);

  const appUrl =
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.NEXT_PUBLIC_SITE_URL ||
    "http://localhost:3000";

  return stripe.checkout.sessions.create({
    mode: "payment",
    customer_email: params.attendeeEmail,
    success_url: `${appUrl}/events/${encodeURIComponent(
      params.eventSlug
    )}?success=paid&registration=${encodeURIComponent(params.registrationId)}`,
    cancel_url: `${appUrl}/events/${encodeURIComponent(
      params.eventSlug
    )}?error=checkout_cancelled&registration=${encodeURIComponent(params.registrationId)}`,
    line_items: [
      {
        quantity: params.quantity,
        price_data: {
          currency: (params.currency || "USD").toLowerCase(),
          unit_amount: Math.round(params.unitPrice * 100),
          product_data: {
            name: `${params.eventName} — ${params.ticketTypeName}`,
            description: params.ticketKind || "Event ticket",
          },
        },
      },
    ],
    payment_intent_data: {
      transfer_data: {
        destination: connectStatus.connectedAccountId!,
      },
      metadata: {
        source: "event_registration",
        studio_id: params.studioId,
        event_id: params.eventId,
        event_slug: params.eventSlug,
        registration_id: params.registrationId,
        ticket_type_id: params.ticketTypeId,
      },
    },
    metadata: {
      source: "event_registration",
      studio_id: params.studioId,
      event_id: params.eventId,
      event_slug: params.eventSlug,
      registration_id: params.registrationId,
      ticket_type_id: params.ticketTypeId,
    },
  });
}

export async function createEventRegistrationAction(
  _prevState: ActionState = initialState,
  formData: FormData
): Promise<ActionState> {
  const eventSlug = getString(formData, "eventSlug");
  const ticketTypeId = getString(formData, "ticketTypeId");
  const attendeeFirstName = getString(formData, "attendeeFirstName");
  const attendeeLastName = getString(formData, "attendeeLastName");
  const attendeeEmail = getString(formData, "attendeeEmail");
  const attendeePhone = getString(formData, "attendeePhone");
  const notes = getString(formData, "notes");
  const quantity = getInt(formData, "quantity", 1);

  if (!eventSlug) {
    return { error: "Missing event slug.", success: "" };
  }

  if (!ticketTypeId) {
    return { error: "Select a ticket type.", success: "" };
  }

  if (!attendeeFirstName || !attendeeLastName || !attendeeEmail) {
    return {
      error: "First name, last name, and email are required.",
      success: "",
    };
  }

  try {
    const supabase = await createClient();

    const {
      data: { user },
    } = await supabase.auth.getUser();

    const { data: event, error: eventError } = await supabase
      .from("events")
      .select(
        `
        id,
        slug,
        name,
        studio_id,
        status,
        visibility,
        registration_required,
        account_required_for_registration,
        registration_opens_at,
        registration_closes_at,
        capacity,
        waitlist_enabled
      `
      )
      .eq("slug", eventSlug)
      .eq("status", "published")
      .in("visibility", ["public", "unlisted"])
      .single();

    if (eventError || !event) {
      return { error: "Event not found.", success: "" };
    }

    if (event.account_required_for_registration && !user) {
      redirect(`/login?next=/events/${encodeURIComponent(eventSlug)}`);
    }

    if (
      event.registration_opens_at &&
      new Date(event.registration_opens_at).getTime() > Date.now()
    ) {
      return { error: "Registration has not opened yet.", success: "" };
    }

    if (
      event.registration_closes_at &&
      new Date(event.registration_closes_at).getTime() < Date.now()
    ) {
      return { error: "Registration is closed for this event.", success: "" };
    }

    const { data: ticketType, error: ticketError } = await supabase
      .from("event_ticket_types")
      .select(
        `
        id,
        event_id,
        name,
        ticket_kind,
        price,
        currency,
        capacity,
        active,
        sale_starts_at,
        sale_ends_at
      `
      )
      .eq("id", ticketTypeId)
      .eq("event_id", event.id)
      .single();

    if (ticketError || !ticketType) {
      return { error: "Ticket type not found.", success: "" };
    }

    if (!ticketType.active) {
      return { error: "This ticket type is no longer available.", success: "" };
    }

    if (
      ticketType.sale_starts_at &&
      new Date(ticketType.sale_starts_at).getTime() > Date.now()
    ) {
      return {
        error: "Ticket sales for this option have not opened yet.",
        success: "",
      };
    }

    if (
      ticketType.sale_ends_at &&
      new Date(ticketType.sale_ends_at).getTime() < Date.now()
    ) {
      return {
        error: "Ticket sales for this option have ended.",
        success: "",
      };
    }

    const { count: activeRegistrationCount, error: countError } = await supabase
      .from("event_registrations")
      .select("*", { count: "exact", head: true })
      .eq("event_id", event.id)
      .neq("status", "cancelled");

    if (countError) {
      return { error: "Could not validate event capacity.", success: "" };
    }

    const { count: activeTicketCount, error: ticketCountError } = await supabase
      .from("event_registrations")
      .select("*", { count: "exact", head: true })
      .eq("event_id", event.id)
      .eq("ticket_type_id", ticketType.id)
      .neq("status", "cancelled");

    if (ticketCountError) {
      return { error: "Could not validate ticket capacity.", success: "" };
    }

    let linkedClientId: string | null = null;

    if (attendeeEmail) {
      const { data: matchingClient } = await supabase
        .from("clients")
        .select("id")
        .eq("studio_id", event.studio_id)
        .ilike("email", attendeeEmail)
        .limit(1)
        .maybeSingle();

      linkedClientId = matchingClient?.id ?? null;
    }

    const unitPrice = Number(ticketType.price ?? 0);
    const totalPrice = Number((unitPrice * quantity).toFixed(2));
    const currency = ticketType.currency || "USD";

    const eventHasNoCapacity =
      event.capacity != null &&
      (activeRegistrationCount ?? 0) + quantity > event.capacity;

    const ticketHasNoCapacity =
      ticketType.capacity != null &&
      (activeTicketCount ?? 0) + quantity > ticketType.capacity;

    const shouldWaitlist = eventHasNoCapacity || ticketHasNoCapacity;

    if (shouldWaitlist) {
      if (!event.waitlist_enabled) {
        return {
          error: ticketHasNoCapacity
            ? "This ticket type is sold out."
            : "This event is sold out.",
          success: "",
        };
      }

      const { data: waitlistRegistration, error: waitlistRegistrationError } =
        await supabase
          .from("event_registrations")
          .insert({
            studio_id: event.studio_id,
            event_id: event.id,
            ticket_type_id: ticketType.id,
            client_id: linkedClientId,
            user_id: user?.id ?? null,
            status: "waitlisted",
            attendee_first_name: attendeeFirstName,
            attendee_last_name: attendeeLastName,
            attendee_email: attendeeEmail,
            attendee_phone: attendeePhone || null,
            quantity,
            unit_price: unitPrice,
            total_price: totalPrice,
            currency,
            registration_source: "public_event_page",
            notes: notes || null,
            checked_in_at: null,
            cancelled_at: null,
          })
          .select("id")
          .single();

      if (waitlistRegistrationError || !waitlistRegistration) {
        return { error: "Could not join the waitlist.", success: "" };
      }

      const { error: waitlistItemError } = await supabase
        .from("event_registration_items")
        .insert({
          registration_id: waitlistRegistration.id,
          ticket_type_id: ticketType.id,
          ticket_name_snapshot: ticketType.name,
          quantity,
          unit_price: unitPrice,
          line_total: totalPrice,
        });

      if (waitlistItemError) {
        return {
          error: "Waitlist entry saved, but line item creation failed.",
          success: "",
        };
      }

      const { error: waitlistAttendeeError } = await supabase
        .from("event_registration_attendees")
        .insert({
          registration_id: waitlistRegistration.id,
          first_name: attendeeFirstName,
          last_name: attendeeLastName,
          email: attendeeEmail,
          phone: attendeePhone || null,
          attendee_role: "attendee",
        });

      if (waitlistAttendeeError) {
        return {
          error: "Waitlist entry saved, but attendee creation failed.",
          success: "",
        };
      }

      redirect(
        appendQueryParam(
          `/events/${encodeURIComponent(event.slug)}`,
          "success",
          "waitlisted"
        )
      );
    }

    if (totalPrice > 0) {
      await requireStudioConnectReadyForCheckout(event.studio_id);
    }

    const { data: existingRegistration } = await supabase
      .from("event_registrations")
      .select(
        `
        id,
        status,
        stripe_checkout_session_id
        `
      )
      .eq("event_id", event.id)
      .eq("ticket_type_id", ticketType.id)
      .ilike("attendee_email", attendeeEmail)
      .neq("status", "cancelled")
      .maybeSingle();

    if (existingRegistration) {
  if (existingRegistration.status === "waitlisted") {
    redirect(
      appendQueryParam(
        `/events/${encodeURIComponent(event.slug)}`,
        "success",
        "waitlisted"
      )
    );
  }

  const session = await createStripeCheckoutSession({
    studioId: event.studio_id,
    eventId: event.id,
    eventSlug: event.slug,
    eventName: event.name,
    registrationId: existingRegistration.id,
    ticketTypeId: ticketType.id,
    ticketTypeName: ticketType.name,
    ticketKind: ticketType.ticket_kind,
    attendeeEmail,
    quantity,
    unitPrice,
    currency,
  });

  await supabase
    .from("event_registrations")
    .update({
      stripe_checkout_session_id: session.id,
    })
    .eq("id", existingRegistration.id);

  redirect(
    session.url ||
      appendQueryParam(
        `/events/${encodeURIComponent(event.slug)}`,
        "error",
        "checkout_session_failed"
      )
  );
}

    const { data: registration, error: registrationError } = await supabase
      .from("event_registrations")
      .insert({
        studio_id: event.studio_id,
        event_id: event.id,
        ticket_type_id: ticketType.id,
        client_id: linkedClientId,
        user_id: user?.id ?? null,
        status: totalPrice === 0 ? "confirmed" : "pending",
        attendee_first_name: attendeeFirstName,
        attendee_last_name: attendeeLastName,
        attendee_email: attendeeEmail,
        attendee_phone: attendeePhone || null,
        quantity,
        unit_price: unitPrice,
        total_price: totalPrice,
        currency,
        registration_source: "public_event_page",
        notes: notes || null,
        checked_in_at: null,
        cancelled_at: null,
      })
      .select("id")
      .single();

    if (registrationError || !registration) {
      console.error("event registration insert failed:", registrationError);
      return { error: "Could not create registration.", success: "" };
    }

    const { error: itemError } = await supabase
      .from("event_registration_items")
      .insert({
        registration_id: registration.id,
        ticket_type_id: ticketType.id,
        ticket_name_snapshot: ticketType.name,
        quantity,
        unit_price: unitPrice,
        line_total: totalPrice,
      });

    if (itemError) {
      console.error("event registration item insert failed:", itemError);
      return {
        error: "Registration saved, but line item creation failed.",
        success: "",
      };
    }

    const { error: attendeeError } = await supabase
      .from("event_registration_attendees")
      .insert({
        registration_id: registration.id,
        first_name: attendeeFirstName,
        last_name: attendeeLastName,
        email: attendeeEmail,
        phone: attendeePhone || null,
        attendee_role: "attendee",
      });

    if (attendeeError) {
      console.error("event registration attendee insert failed:", attendeeError);
      return {
        error: "Registration saved, but attendee creation failed.",
        success: "",
      };
    }

    if (totalPrice === 0) {
      redirect(
        appendQueryParam(
          `/events/${encodeURIComponent(event.slug)}`,
          "success",
          "registered"
        )
      );
    }

    const session = await createStripeCheckoutSession({
      studioId: event.studio_id,
      eventId: event.id,
      eventSlug: event.slug,
      eventName: event.name,
      registrationId: registration.id,
      ticketTypeId: ticketType.id,
      ticketTypeName: ticketType.name,
      ticketKind: ticketType.ticket_kind,
      attendeeEmail,
      quantity,
      unitPrice,
      currency,
    });

    const { error: registrationUpdateError } = await supabase
      .from("event_registrations")
      .update({
        stripe_checkout_session_id: session.id,
      })
      .eq("id", registration.id);

    if (registrationUpdateError) {
      console.error(
        "event registration checkout session link failed:",
        registrationUpdateError
      );
      return {
        error: "Registration created, but checkout session could not be linked.",
        success: "",
      };
    }

    redirect(
      session.url ||
        appendQueryParam(
          `/events/${encodeURIComponent(event.slug)}`,
          "error",
          "checkout_session_failed"
        )
    );
  } catch (error) {
    if (isRedirectError(error)) {
      throw error;
    }

    console.error("createEventRegistrationAction failed:", error);

    return {
      error: error instanceof Error ? error.message : "Something went wrong.",
      success: "",
    };
  }
}

export async function retryEventRegistrationCheckoutAction(formData: FormData) {
  const eventSlug = getString(formData, "eventSlug");
  const registrationId = getString(formData, "registrationId");

  if (!eventSlug || !registrationId) {
    redirect("/events");
  }

  const supabase = await createClient();

  const { data: registration, error: registrationError } = await supabase
    .from("event_registrations")
    .select(
      `
      id,
      event_id,
      ticket_type_id,
      attendee_email,
      quantity,
      unit_price,
      currency,
      status,
      events (
        id,
        slug,
        name,
        studio_id
      ),
      event_ticket_types (
        id,
        name,
        ticket_kind
      )
    `
    )
    .eq("id", registrationId)
    .single();

  if (registrationError || !registration) {
    redirect(`/events/${encodeURIComponent(eventSlug)}?error=checkout_session_failed`);
  }

  const eventValue = Array.isArray(registration.events)
    ? registration.events[0]
    : registration.events;
  const ticketTypeValue = Array.isArray(registration.event_ticket_types)
    ? registration.event_ticket_types[0]
    : registration.event_ticket_types;

  if (!eventValue || !ticketTypeValue) {
    redirect(`/events/${encodeURIComponent(eventSlug)}?error=checkout_session_failed`);
  }

  if (registration.status === "waitlisted") {
    redirect(`/events/${encodeURIComponent(eventValue.slug)}?success=waitlisted`);
  }

  const session = await createStripeCheckoutSession({
    studioId: eventValue.studio_id,
    eventId: eventValue.id,
    eventSlug: eventValue.slug,
    eventName: eventValue.name,
    registrationId: registration.id,
    ticketTypeId: ticketTypeValue.id,
    ticketTypeName: ticketTypeValue.name,
    ticketKind: ticketTypeValue.ticket_kind,
    attendeeEmail: registration.attendee_email,
    quantity: registration.quantity,
    unitPrice: Number(registration.unit_price ?? 0),
    currency: registration.currency || "USD",
  });

  const { error: registrationUpdateError } = await supabase
    .from("event_registrations")
    .update({
      stripe_checkout_session_id: session.id,
    })
    .eq("id", registration.id);

  if (registrationUpdateError) {
    redirect(`/events/${encodeURIComponent(eventValue.slug)}?error=checkout_session_failed`);
  }

  redirect(
    session.url ||
      `/events/${encodeURIComponent(eventValue.slug)}?error=checkout_session_failed`
  );
}