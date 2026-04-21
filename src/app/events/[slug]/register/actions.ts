"use server";

import { redirect } from "next/navigation";
import { isRedirectError } from "next/dist/client/components/redirect-error";
import { createClient } from "@/lib/supabase/server";
import { getStripe } from "@/lib/payments/stripe";
import { queueOutboundDelivery } from "@/lib/notifications/outbound";
import {
  buildEventConfirmedEmailTemplate,
  buildEventConfirmedSmsTemplate,
  buildEventWaitlistEmailTemplate,
  buildEventWaitlistSmsTemplate,
} from "@/lib/notifications/templates";

type StudioSubscriptionPlanRow = {
  status: string | null;
  subscription_plans:
    | { code: string | null; name?: string | null }
    | { code: string | null; name?: string | null }[]
    | null;
};

type ActionState = {
  error: string;
  success: string;
};

type PublicEventRow = {
  id: string;
  slug: string;
  name: string;
  studio_id: string;
  organizer_id: string | null;
  status: string;
  visibility: string;
  public_directory_enabled: boolean;
  registration_required: boolean;
  account_required_for_registration: boolean;
  registration_opens_at: string | null;
  registration_closes_at: string | null;
  capacity: number | null;
  waitlist_enabled: boolean;
};

type PublicTicketTypeRow = {
  id: string;
  event_id: string;
  name: string;
  ticket_kind: string | null;
  price: number;
  currency: string | null;
  capacity: number | null;
  active: boolean;
  sale_starts_at: string | null;
  sale_ends_at: string | null;
};

type ExistingRegistrationRow = {
  id: string;
  status: string;
  stripe_checkout_session_id: string | null;
  quantity: number | null;
  attendee_email: string;
};

const initialState: ActionState = {
  error: "",
  success: "",
};

function getSubscriptionPlan(
  value:
    | { code: string | null; name?: string | null }
    | { code: string | null; name?: string | null }[]
    | null
) {
  return Array.isArray(value) ? value[0] ?? null : value;
}

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

function eventUrlFromSlug(eventSlug: string) {
  return `/events/${encodeURIComponent(eventSlug)}`;
}

function eventUrlWithQuery(eventSlug: string, key: string, value: string) {
  return appendQueryParam(eventUrlFromSlug(eventSlug), key, value);
}

function getAppUrl() {
  return (
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.NEXT_PUBLIC_SITE_URL ||
    "http://localhost:3000"
  );
}

async function getOrganizerPlatformFeePercent(studioId: string) {
  const supabase = await createClient();

  const { data: subscription, error } = await supabase
    .from("studio_subscriptions")
    .select(
      `
      status,
      subscription_plans (
        code,
        name
      )
    `
    )
    .eq("studio_id", studioId)
    .maybeSingle();

  if (error || !subscription) {
    return 0;
  }

  const typedSubscription = subscription as StudioSubscriptionPlanRow;
  const plan = getSubscriptionPlan(typedSubscription.subscription_plans);
  const status = typedSubscription.status ?? "inactive";
  const planCode = plan?.code ?? null;

  if (!["active", "trialing"].includes(status)) {
    return 0;
  }

  return planCode === "organizer" ? 0.035 : 0;
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

  const baseStatus = {
    connectedAccountId: studio.stripe_connected_account_id ?? null,
    detailsSubmitted: studio.stripe_connect_details_submitted ?? false,
    chargesEnabled: studio.stripe_connect_charges_enabled ?? false,
    payoutsEnabled: studio.stripe_connect_payouts_enabled ?? false,
    onboardingComplete: studio.stripe_connect_onboarding_complete ?? false,
    cardPaymentsEnabled: false,
    transfersEnabled: false,
  };

  if (!baseStatus.connectedAccountId) {
    return baseStatus;
  }

  try {
    const stripe = getStripe();
    const account = await stripe.accounts.retrieve(baseStatus.connectedAccountId);

    return {
      ...baseStatus,
      detailsSubmitted: account.details_submitted ?? baseStatus.detailsSubmitted,
      chargesEnabled: account.charges_enabled ?? baseStatus.chargesEnabled,
      payoutsEnabled: account.payouts_enabled ?? baseStatus.payoutsEnabled,
      onboardingComplete:
        (account.details_submitted ?? false) &&
        (account.charges_enabled ?? false) &&
        (account.payouts_enabled ?? false),
      cardPaymentsEnabled: account.capabilities?.card_payments === "active",
      transfersEnabled: account.capabilities?.transfers === "active",
    };
  } catch (error) {
    console.error("Could not retrieve Stripe connected account capabilities:", error);
    return baseStatus;
  }
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

  if (!status.cardPaymentsEnabled || !status.transfersEnabled || !status.chargesEnabled) {
    throw new Error(
      "This studio Stripe account is not ready for direct-charge ticket sales yet. The connected account still needs card payments and transfers enabled."
    );
  }

  return status;
}

function calculateOrganizerApplicationFeeAmount(params: {
  unitPrice: number;
  quantity: number;
  feePercent: number;
}) {
  const grossAmount =
    Math.max(0, Math.round(params.unitPrice * 100)) * Math.max(1, params.quantity);

  return Math.round(grossAmount * Math.max(0, params.feePercent));
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

  const appUrl = getAppUrl();

  const organizerPlatformFeePercent = await getOrganizerPlatformFeePercent(
    params.studioId
  );

  const applicationFeeAmount = calculateOrganizerApplicationFeeAmount({
    unitPrice: params.unitPrice,
    quantity: params.quantity,
    feePercent: organizerPlatformFeePercent,
  });

  return stripe.checkout.sessions.create(
    {
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
        ...(applicationFeeAmount > 0
          ? { application_fee_amount: applicationFeeAmount }
          : {}),
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
    },
    {
      stripeAccount: connectStatus.connectedAccountId!,
    }
  );
}

async function safeQueueEventWaitlistOutbound(params: {
  studioId: string;
  registrationId: string;
  eventSlug: string;
  eventName: string;
  attendeeFirstName: string;
  attendeeLastName: string;
  attendeeEmail: string;
  attendeePhone: string | null;
  ticketTypeName: string;
  quantity: number;
  totalPrice: number;
  currency: string;
}) {
  try {
    const eventUrl = `${getAppUrl()}/events/${encodeURIComponent(params.eventSlug)}`;

    const emailTemplate = buildEventWaitlistEmailTemplate({
      eventName: params.eventName,
      attendeeFirstName: params.attendeeFirstName,
      attendeeLastName: params.attendeeLastName,
      ticketTypeName: params.ticketTypeName,
      quantity: params.quantity,
      totalPrice: params.totalPrice,
      currency: params.currency,
      eventUrl,
    });

    const smsBody = buildEventWaitlistSmsTemplate({
      eventName: params.eventName,
      attendeeFirstName: params.attendeeFirstName,
      attendeeLastName: params.attendeeLastName,
      ticketTypeName: params.ticketTypeName,
      quantity: params.quantity,
      totalPrice: params.totalPrice,
      currency: params.currency,
      eventUrl,
    });

    await Promise.allSettled([
      queueOutboundDelivery({
        studioId: params.studioId,
        channel: "email",
        templateKey: "event_waitlist_confirmation",
        recipientEmail: params.attendeeEmail,
        subject: emailTemplate.subject,
        bodyText: emailTemplate.bodyText,
        relatedTable: "event_registrations",
        relatedId: params.registrationId,
        dedupeKey: `event_waitlist_confirmation:email:${params.registrationId}`,
      }),
      queueOutboundDelivery({
        studioId: params.studioId,
        channel: "sms",
        templateKey: "event_waitlist_confirmation",
        recipientPhone: params.attendeePhone,
        bodyText: smsBody,
        relatedTable: "event_registrations",
        relatedId: params.registrationId,
        dedupeKey: `event_waitlist_confirmation:sms:${params.registrationId}`,
      }),
    ]);
  } catch (error) {
    console.error("queue waitlist outbound failed:", error);
  }
}

async function safeQueueEventConfirmedOutbound(params: {
  studioId: string;
  registrationId: string;
  eventSlug: string;
  eventName: string;
  attendeeFirstName: string;
  attendeeLastName: string;
  attendeeEmail: string;
  attendeePhone: string | null;
  ticketTypeName: string;
  quantity: number;
  totalPrice: number;
  currency: string;
}) {
  try {
    const eventUrl = `${getAppUrl()}/events/${encodeURIComponent(params.eventSlug)}`;

    const emailTemplate = buildEventConfirmedEmailTemplate({
      eventName: params.eventName,
      attendeeFirstName: params.attendeeFirstName,
      attendeeLastName: params.attendeeLastName,
      ticketTypeName: params.ticketTypeName,
      quantity: params.quantity,
      totalPrice: params.totalPrice,
      currency: params.currency,
      eventUrl,
    });

    const smsBody = buildEventConfirmedSmsTemplate({
      eventName: params.eventName,
      attendeeFirstName: params.attendeeFirstName,
      attendeeLastName: params.attendeeLastName,
      ticketTypeName: params.ticketTypeName,
      quantity: params.quantity,
      totalPrice: params.totalPrice,
      currency: params.currency,
      eventUrl,
    });

    await Promise.allSettled([
      queueOutboundDelivery({
        studioId: params.studioId,
        channel: "email",
        templateKey: "event_registration_confirmed",
        recipientEmail: params.attendeeEmail,
        subject: emailTemplate.subject,
        bodyText: emailTemplate.bodyText,
        relatedTable: "event_registrations",
        relatedId: params.registrationId,
        dedupeKey: `event_registration_confirmed:email:${params.registrationId}`,
      }),
      queueOutboundDelivery({
        studioId: params.studioId,
        channel: "sms",
        templateKey: "event_registration_confirmed",
        recipientPhone: params.attendeePhone,
        bodyText: smsBody,
        relatedTable: "event_registrations",
        relatedId: params.registrationId,
        dedupeKey: `event_registration_confirmed:sms:${params.registrationId}`,
      }),
    ]);
  } catch (error) {
    console.error("queue confirmed outbound failed:", error);
  }
}

async function getPublicEventBySlug(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  eventSlug: string;
}) {
  const { supabase, eventSlug } = params;

  const { data: event, error } = await supabase
    .from("events")
    .select(`
      id,
      slug,
      name,
      studio_id,
      organizer_id,
      status,
      visibility,
      public_directory_enabled,
      registration_required,
      account_required_for_registration,
      registration_opens_at,
      registration_closes_at,
      capacity,
      waitlist_enabled
    `)
    .eq("slug", eventSlug)
    .eq("status", "published")
    .in("visibility", ["public", "unlisted"])
    .single<PublicEventRow>();

  if (error || !event) {
    return null;
  }

  return event;
}

async function getPublicTicketType(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  eventId: string;
  ticketTypeId: string;
}) {
  const { supabase, eventId, ticketTypeId } = params;

  const { data: ticketType, error } = await supabase
    .from("event_ticket_types")
    .select(`
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
    `)
    .eq("id", ticketTypeId)
    .eq("event_id", eventId)
    .single<PublicTicketTypeRow>();

  if (error || !ticketType) {
    return null;
  }

  return ticketType;
}

async function findExistingOpenRegistration(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  eventId: string;
  ticketTypeId: string;
  attendeeEmail: string;
}) {
  const { supabase, eventId, ticketTypeId, attendeeEmail } = params;

  const { data } = await supabase
    .from("event_registrations")
    .select(`
      id,
      status,
      stripe_checkout_session_id,
      quantity,
      attendee_email
    `)
    .eq("event_id", eventId)
    .eq("ticket_type_id", ticketTypeId)
    .ilike("attendee_email", attendeeEmail)
    .neq("status", "cancelled")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle<ExistingRegistrationRow>();

  return data ?? null;
}

function validateRegistrationWindow(event: PublicEventRow) {
  if (!event.registration_required) {
    return "Registration is not enabled for this event.";
  }

  if (
    event.registration_opens_at &&
    new Date(event.registration_opens_at).getTime() > Date.now()
  ) {
    return "Registration has not opened yet.";
  }

  if (
    event.registration_closes_at &&
    new Date(event.registration_closes_at).getTime() < Date.now()
  ) {
    return "Registration is closed for this event.";
  }

  return null;
}

function validateTicketWindow(ticketType: PublicTicketTypeRow) {
  if (!ticketType.active) {
    return "This ticket type is no longer available.";
  }

  if (
    ticketType.sale_starts_at &&
    new Date(ticketType.sale_starts_at).getTime() > Date.now()
  ) {
    return "Ticket sales for this option have not opened yet.";
  }

  if (
    ticketType.sale_ends_at &&
    new Date(ticketType.sale_ends_at).getTime() < Date.now()
  ) {
    return "Ticket sales for this option have ended.";
  }

  return null;
}

async function getCapacitySnapshot(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  eventId: string;
  ticketTypeId: string;
}) {
  const { supabase, eventId, ticketTypeId } = params;

  const { count: activeRegistrationCount, error: countError } = await supabase
    .from("event_registrations")
    .select("*", { count: "exact", head: true })
    .eq("event_id", eventId)
    .not("status", "in", "(cancelled,waitlisted)");

  if (countError) {
    throw new Error("Could not validate event capacity.");
  }

  const { count: activeTicketCount, error: ticketCountError } = await supabase
    .from("event_registrations")
    .select("*", { count: "exact", head: true })
    .eq("event_id", eventId)
    .eq("ticket_type_id", ticketTypeId)
    .not("status", "in", "(cancelled,waitlisted)");

  if (ticketCountError) {
    throw new Error("Could not validate ticket capacity.");
  }

  return {
    activeRegistrationCount: activeRegistrationCount ?? 0,
    activeTicketCount: activeTicketCount ?? 0,
  };
}

async function findLinkedClientId(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  studioId: string;
  attendeeEmail: string;
}) {
  const { supabase, studioId, attendeeEmail } = params;

  if (!attendeeEmail) return null;

  const { data: matchingClient } = await supabase
    .from("clients")
    .select("id")
    .eq("studio_id", studioId)
    .ilike("email", attendeeEmail)
    .limit(1)
    .maybeSingle();

  return matchingClient?.id ?? null;
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

    const event = await getPublicEventBySlug({
      supabase,
      eventSlug,
    });

    if (!event) {
      return { error: "Event not found.", success: "" };
    }

    if (!event.organizer_id) {
      return { error: "This event is not available for public registration.", success: "" };
    }

    const registrationWindowError = validateRegistrationWindow(event);
    if (registrationWindowError) {
      return { error: registrationWindowError, success: "" };
    }

    if (event.account_required_for_registration && !user) {
      return {
        error: "You need a free account and must be logged in to register for this event.",
        success: "",
      };
    }

    const ticketType = await getPublicTicketType({
      supabase,
      eventId: event.id,
      ticketTypeId,
    });

    if (!ticketType) {
      return { error: "Ticket type not found.", success: "" };
    }

    const ticketWindowError = validateTicketWindow(ticketType);
    if (ticketWindowError) {
      return { error: ticketWindowError, success: "" };
    }

    const existingRegistration = await findExistingOpenRegistration({
      supabase,
      eventId: event.id,
      ticketTypeId: ticketType.id,
      attendeeEmail,
    });

    const unitPrice = Number(ticketType.price ?? 0);
    const totalPrice = Number((unitPrice * quantity).toFixed(2));
    const currency = ticketType.currency || "USD";

    if (existingRegistration) {
      if (existingRegistration.status === "waitlisted") {
        redirect(eventUrlWithQuery(event.slug, "success", "waitlisted"));
      }

      if (
        existingRegistration.status === "confirmed" ||
        existingRegistration.status === "attended" ||
        existingRegistration.status === "checked_in"
      ) {
        redirect(
          eventUrlWithQuery(event.slug, "success", totalPrice > 0 ? "paid" : "registered")
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
        quantity: existingRegistration.quantity ?? quantity,
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
        session.url || eventUrlWithQuery(event.slug, "error", "checkout_session_failed")
      );
    }

    const capacitySnapshot = await getCapacitySnapshot({
      supabase,
      eventId: event.id,
      ticketTypeId: ticketType.id,
    });

    const eventHasNoCapacity =
      event.capacity != null &&
      capacitySnapshot.activeRegistrationCount + quantity > event.capacity;

    const ticketHasNoCapacity =
      ticketType.capacity != null &&
      capacitySnapshot.activeTicketCount + quantity > ticketType.capacity;

    const shouldWaitlist = eventHasNoCapacity || ticketHasNoCapacity;

    const linkedClientId = await findLinkedClientId({
      supabase,
      studioId: event.studio_id,
      attendeeEmail,
    });

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

      await safeQueueEventWaitlistOutbound({
        studioId: event.studio_id,
        registrationId: waitlistRegistration.id,
        eventSlug: event.slug,
        eventName: event.name,
        attendeeFirstName,
        attendeeLastName,
        attendeeEmail,
        attendeePhone: attendeePhone || null,
        ticketTypeName: ticketType.name,
        quantity,
        totalPrice,
        currency,
      });

      redirect(eventUrlWithQuery(event.slug, "success", "waitlisted"));
    }

    if (totalPrice > 0) {
      await requireStudioConnectReadyForCheckout(event.studio_id);
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
      await safeQueueEventConfirmedOutbound({
        studioId: event.studio_id,
        registrationId: registration.id,
        eventSlug: event.slug,
        eventName: event.name,
        attendeeFirstName,
        attendeeLastName,
        attendeeEmail,
        attendeePhone: attendeePhone || null,
        ticketTypeName: ticketType.name,
        quantity,
        totalPrice,
        currency,
      });

      redirect(eventUrlWithQuery(event.slug, "success", "registered"));
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
      session.url || eventUrlWithQuery(event.slug, "error", "checkout_session_failed")
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
    .select(`
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
        studio_id,
        organizer_id,
        status,
        visibility
      ),
      event_ticket_types (
        id,
        name,
        ticket_kind,
        active,
        sale_starts_at,
        sale_ends_at
      )
    `)
    .eq("id", registrationId)
    .single();

  if (registrationError || !registration) {
    redirect(eventUrlWithQuery(eventSlug, "error", "checkout_session_failed"));
  }

  const eventValue = Array.isArray(registration.events)
    ? registration.events[0]
    : registration.events;

  const ticketTypeValue = Array.isArray(registration.event_ticket_types)
    ? registration.event_ticket_types[0]
    : registration.event_ticket_types;

  if (!eventValue || !ticketTypeValue) {
    redirect(eventUrlWithQuery(eventSlug, "error", "checkout_session_failed"));
  }

  if (
    eventValue.status !== "published" ||
    !["public", "unlisted"].includes(eventValue.visibility) ||
    !eventValue.organizer_id
  ) {
    redirect(eventUrlWithQuery(eventValue.slug, "error", "checkout_session_failed"));
  }

  if (!ticketTypeValue.active) {
    redirect(eventUrlWithQuery(eventValue.slug, "error", "checkout_session_failed"));
  }

  if (
    ticketTypeValue.sale_starts_at &&
    new Date(ticketTypeValue.sale_starts_at).getTime() > Date.now()
  ) {
    redirect(eventUrlWithQuery(eventValue.slug, "error", "checkout_session_failed"));
  }

  if (
    ticketTypeValue.sale_ends_at &&
    new Date(ticketTypeValue.sale_ends_at).getTime() < Date.now()
  ) {
    redirect(eventUrlWithQuery(eventValue.slug, "error", "checkout_session_failed"));
  }

  if (registration.status === "waitlisted") {
    redirect(eventUrlWithQuery(eventValue.slug, "success", "waitlisted"));
  }

  if (
    registration.status === "confirmed" ||
    registration.status === "attended" ||
    registration.status === "checked_in"
  ) {
    redirect(eventUrlWithQuery(eventValue.slug, "success", "paid"));
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
    redirect(eventUrlWithQuery(eventValue.slug, "error", "checkout_session_failed"));
  }

  redirect(session.url || eventUrlWithQuery(eventValue.slug, "error", "checkout_session_failed"));
}