import { NextRequest, NextResponse } from "next/server";
import { createClient as createSupabaseClient, SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "crypto";
import { getStripe } from "@/lib/payments/stripe";

function getSupabaseAdmin(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new Error("Missing Supabase admin environment variables.");
  }

  return createSupabaseClient(url, serviceRoleKey, {
    auth: { persistSession: false },
  });
}

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function getStringList(formData: FormData, key: string) {
  return formData
    .getAll(key)
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter(Boolean);
}

function getInt(formData: FormData, key: string, fallback = 0) {
  const raw = getString(formData, key);
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function splitFullName(fullName: string) {
  const normalized = fullName.trim().replace(/\s+/g, " ");
  const [firstName = "", ...rest] = normalized.split(" ");

  return {
    firstName,
    lastName: rest.join(" "),
  };
}

function absoluteEventUrl(request: NextRequest, eventSlug: string, query: string) {
  return new URL(`/events/${encodeURIComponent(eventSlug)}${query}`, request.nextUrl.origin).toString();
}

function calculateApplicationFeeAmount(amount: number, feePercent: number) {
  return Math.round(Math.max(0, Math.round(amount * 100)) * Math.max(0, feePercent));
}

async function getOrganizerPlatformFeePercent(supabase: SupabaseClient, studioId: string) {
  const { data: subscription } = await supabase
    .from("studio_subscriptions")
    .select(`
      status,
      subscription_plans (
        code,
        name
      )
    `)
    .eq("studio_id", studioId)
    .maybeSingle();

  if (!subscription) return 0;

  const rawPlan = subscription.subscription_plans;
  const plan = Array.isArray(rawPlan) ? rawPlan[0] : rawPlan;
  const status = subscription.status ?? "inactive";
  const planCode = plan?.code ?? null;

  if (!["active", "trialing"].includes(status)) return 0;

  return planCode === "organizer" ? 0.035 : 0;
}

type CartEventRow = {
  id: string;
  slug: string;
  name: string;
  studio_id: string;
  organizer_id: string | null;
  status: string | null;
  visibility: string | null;
  public_directory_enabled: boolean | null;
  registration_required: boolean | null;
  registration_opens_at: string | null;
  registration_closes_at: string | null;
  studios:
    | {
        id: string;
        name: string | null;
        subscription_status: string | null;
        stripe_connected_account_id: string | null;
        stripe_connect_charges_enabled: boolean | null;
        stripe_connect_payouts_enabled: boolean | null;
        stripe_connect_onboarding_complete: boolean | null;
      }
    | {
        id: string;
        name: string | null;
        subscription_status: string | null;
        stripe_connected_account_id: string | null;
        stripe_connect_charges_enabled: boolean | null;
        stripe_connect_payouts_enabled: boolean | null;
        stripe_connect_onboarding_complete: boolean | null;
      }[]
    | null;
};

type TicketTypeRow = {
  id: string;
  event_id: string;
  name: string;
  description: string | null;
  ticket_kind: string | null;
  price: number | null;
  currency: string | null;
  capacity: number | null;
  active: boolean | null;
  sale_starts_at: string | null;
  sale_ends_at: string | null;
  early_bird_enabled: boolean | null;
  early_bird_price: number | null;
  early_bird_ends_at: string | null;
  attendees_per_ticket: number | null;
};

type SlotRow = {
  id: string;
  event_id: string;
  coach_id: string;
  block_id: string | null;
  studio_id: string;
  organizer_id: string | null;
  starts_at: string;
  ends_at: string;
  price: number | null;
  location_label: string | null;
  status: string | null;
  payment_status: string | null;
  event_guest_coaches:
    | { id: string; name: string | null }
    | { id: string; name: string | null }[]
    | null;
};

function pickOne<T>(value: T | T[] | null | undefined) {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function validateRegistrationWindow(event: CartEventRow) {
  const now = Date.now();

  if (!event.registration_required) return null;

  if (event.registration_opens_at && new Date(event.registration_opens_at).getTime() > now) {
    return "registration_not_open";
  }

  if (event.registration_closes_at && new Date(event.registration_closes_at).getTime() < now) {
    return "registration_closed";
  }

  return null;
}

function validateTicketWindow(ticket: TicketTypeRow) {
  const now = Date.now();

  if (!ticket.active) return "ticket_unavailable";

  if (ticket.sale_starts_at && new Date(ticket.sale_starts_at).getTime() > now) {
    return "ticket_not_open";
  }

  if (ticket.sale_ends_at && new Date(ticket.sale_ends_at).getTime() < now) {
    return "ticket_closed";
  }

  return null;
}

function getActiveTicketPrice(ticket: TicketTypeRow) {
  const regularPrice = Number(ticket.price ?? 0);
  const earlyBirdPrice =
    ticket.early_bird_price == null ? null : Number(ticket.early_bird_price);
  const earlyBirdEndsAt = ticket.early_bird_ends_at
    ? new Date(ticket.early_bird_ends_at).getTime()
    : null;

  if (
    ticket.early_bird_enabled &&
    earlyBirdPrice != null &&
    Number.isFinite(earlyBirdPrice) &&
    earlyBirdPrice >= 0 &&
    earlyBirdEndsAt != null &&
    Number.isFinite(earlyBirdEndsAt) &&
    earlyBirdEndsAt >= Date.now()
  ) {
    return Number(earlyBirdPrice.toFixed(2));
  }

  return Number((Number.isFinite(regularPrice) ? regularPrice : 0).toFixed(2));
}

function getTicketPriceLabel(ticket: TicketTypeRow) {
  return getActiveTicketPrice(ticket) < Number(ticket.price ?? 0)
    ? "early_bird"
    : "regular";
}


export async function POST(request: NextRequest) {
  const supabase = getSupabaseAdmin();
  const stripe = getStripe();
  const formData = await request.formData();

  const eventSlug = getString(formData, "eventSlug");
  const buyerFirstName = getString(formData, "attendeeFirstName") || getString(formData, "buyerFirstName");
  const buyerLastName = getString(formData, "attendeeLastName") || getString(formData, "buyerLastName");
  const buyerName = getString(formData, "buyerName") || [buyerFirstName, buyerLastName].filter(Boolean).join(" ");
  const buyerEmail = (getString(formData, "attendeeEmail") || getString(formData, "buyerEmail")).toLowerCase();
  const buyerPhone = getString(formData, "attendeePhone") || getString(formData, "buyerPhone");
  const buyerNotes = getString(formData, "notes") || getString(formData, "buyerNotes");

  const ticketTypeId = getString(formData, "ticketTypeId");
  const quantity = getInt(formData, "quantity", ticketTypeId ? 1 : 0);
  const additionalAttendeeNames = getStringList(formData, "additionalAttendeeNames");
  const slotIds = Array.from(new Set(getStringList(formData, "slotIds").concat(getStringList(formData, "slotId"))));

  if (!eventSlug) {
    return NextResponse.redirect(absoluteEventUrl(request, "", "?error=missing_event"));
  }

  if (!buyerName || !buyerEmail) {
    return NextResponse.redirect(absoluteEventUrl(request, eventSlug, "?error=cart_contact_required"));
  }

  if (!ticketTypeId && slotIds.length === 0) {
    return NextResponse.redirect(absoluteEventUrl(request, eventSlug, "?error=cart_empty"));
  }

  const { data: event, error: eventError } = await supabase
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
      registration_opens_at,
      registration_closes_at,
      studios:studio_id (
        id,
        name,
        subscription_status,
        stripe_connected_account_id,
        stripe_connect_charges_enabled,
        stripe_connect_payouts_enabled,
        stripe_connect_onboarding_complete
      )
    `)
    .eq("slug", eventSlug)
    .maybeSingle<CartEventRow>();

  const studio = pickOne(event?.studios);

  const eventIsPublic =
    event?.status === "published" &&
    (event.visibility === "public" || event.visibility === "unlisted" || event.public_directory_enabled === true);
  const studioHasAccess = ["active", "trialing"].includes(studio?.subscription_status ?? "");

  if (eventError || !event || !eventIsPublic || !studioHasAccess) {
    return NextResponse.redirect(absoluteEventUrl(request, eventSlug, "?error=event_unavailable"));
  }

  if (!studio?.stripe_connected_account_id || !studio.stripe_connect_onboarding_complete || !studio.stripe_connect_payouts_enabled || !studio.stripe_connect_charges_enabled) {
    return NextResponse.redirect(absoluteEventUrl(request, eventSlug, "?error=studio_payouts_not_ready"));
  }

  let ticketType: TicketTypeRow | null = null;
  let ticketTotal = 0;
  let ticketCurrency = "USD";
  let registrationId: string | null = null;

  if (ticketTypeId) {
    const registrationWindowError = validateRegistrationWindow(event);
    if (registrationWindowError) {
      return NextResponse.redirect(absoluteEventUrl(request, eventSlug, `?error=${registrationWindowError}`));
    }

    const { data: ticket, error: ticketError } = await supabase
      .from("event_ticket_types")
      .select(`
        id,
        event_id,
        name,
        description,
        ticket_kind,
        price,
        currency,
        capacity,
        active,
        sale_starts_at,
        sale_ends_at,
        early_bird_enabled,
        early_bird_price,
        early_bird_ends_at,
        attendees_per_ticket
      `)
      .eq("id", ticketTypeId)
      .eq("event_id", event.id)
      .maybeSingle<TicketTypeRow>();

    if (ticketError || !ticket) {
      return NextResponse.redirect(absoluteEventUrl(request, eventSlug, "?error=ticket_unavailable"));
    }

    const ticketWindowError = validateTicketWindow(ticket);
    if (ticketWindowError) {
      return NextResponse.redirect(absoluteEventUrl(request, eventSlug, `?error=${ticketWindowError}`));
    }

    ticketType = ticket;
    ticketCurrency = ticket.currency || "USD";
    ticketTotal = Number((getActiveTicketPrice(ticket) * quantity).toFixed(2));

    // Failed/retried cart checkout attempts can leave an active registration row behind before Stripe is reached.
    // The active-registration unique constraint is event + ticket + email. Before creating a fresh attempt:
    // - block if the buyer already has a paid/confirmed registration
    // - cancel stale unpaid attempts so the unique constraint does not stop checkout
    const { data: existingRegistrations, error: existingRegistrationError } = await supabase
      .from("event_registrations")
      .select("id,status,payment_status,order_id,cancelled_at")
      .eq("event_id", event.id)
      .eq("ticket_type_id", ticket.id)
      .ilike("attendee_email", buyerEmail)
      .is("cancelled_at", null);

    if (existingRegistrationError) {
      console.error("event cart existing registration lookup failed:", existingRegistrationError);
      return NextResponse.redirect(absoluteEventUrl(request, eventSlug, "?error=registration_lookup_failed"));
    }

    const activeRegistrations = existingRegistrations ?? [];
    const alreadyPaidRegistration = activeRegistrations.find((registration) => {
      const status = String(registration.status ?? "").toLowerCase();
      const paymentStatus = String(registration.payment_status ?? "").toLowerCase();

      return (
        status === "confirmed" ||
        status === "checked_in" ||
        paymentStatus === "paid" ||
        paymentStatus === "succeeded"
      );
    });

    if (alreadyPaidRegistration) {
      return NextResponse.redirect(absoluteEventUrl(request, eventSlug, "?error=already_registered"));
    }

    const staleRegistrationIds = activeRegistrations
      .map((registration) => registration.id)
      .filter(Boolean);

    if (staleRegistrationIds.length > 0) {
      const { error: staleRegistrationCleanupError } = await supabase
        .from("event_registrations")
        .update({
          status: "cancelled",
          payment_status: "failed",
          cancelled_at: new Date().toISOString(),
        })
        .in("id", staleRegistrationIds);

      if (staleRegistrationCleanupError) {
        console.error("event cart stale registration cleanup failed:", staleRegistrationCleanupError);
        return NextResponse.redirect(absoluteEventUrl(request, eventSlug, "?error=registration_cleanup_failed"));
      }
    }

    const attendeesPerTicket = Math.max(1, Number(ticket.attendees_per_ticket ?? 1) || 1);
    const expectedAttendeeCount = Math.max(1, quantity) * attendeesPerTicket;
    if (additionalAttendeeNames.length < expectedAttendeeCount - 1) {
      return NextResponse.redirect(absoluteEventUrl(request, eventSlug, "?error=missing_attendees"));
    }
  }

  let slots: SlotRow[] = [];
  const holdToken = randomUUID();
  const holdUntil = new Date(Date.now() + 15 * 60 * 1000).toISOString();

  if (slotIds.length > 0) {
    const { data: slotRows, error: slotsError } = await supabase
      .from("event_private_lesson_slots")
      .select(`
        id,
        event_id,
        coach_id,
        block_id,
        studio_id,
        organizer_id,
        starts_at,
        ends_at,
        price,
        location_label,
        status,
        payment_status,
        event_guest_coaches:coach_id (
          id,
          name
        )
      `)
      .eq("event_id", event.id)
      .in("id", slotIds);

    if (slotsError || !slotRows || slotRows.length !== slotIds.length) {
      return NextResponse.redirect(absoluteEventUrl(request, eventSlug, "?error=coach_slot_unavailable"));
    }

    slots = slotRows as SlotRow[];

    const unavailableSlot = slots.find(
      (slot) => slot.status !== "available" || slot.payment_status !== "unpaid"
    );

    if (unavailableSlot) {
      return NextResponse.redirect(absoluteEventUrl(request, eventSlug, "?error=coach_slot_already_booked"));
    }
  }

  const slotTotal = slots.reduce((sum, slot) => sum + Number(slot.price ?? 0), 0);
  const currency = (ticketCurrency || "USD").toUpperCase();
  const totalAmount = Number((ticketTotal + slotTotal).toFixed(2));

  if (totalAmount <= 0) {
    return NextResponse.redirect(absoluteEventUrl(request, eventSlug, "?error=cart_invalid_total"));
  }

  const expiresAt = holdUntil;

  const { data: order, error: orderError } = await supabase
    .from("event_orders")
    .insert({
      event_id: event.id,
      studio_id: event.studio_id,
      organizer_id: event.organizer_id,
      buyer_name: buyerName,
      buyer_email: buyerEmail,
      buyer_phone: buyerPhone || null,
      buyer_notes: buyerNotes || null,
      subtotal_amount: totalAmount,
      total_amount: totalAmount,
      currency,
      status: "pending",
      payment_status: "pending",
      expires_at: expiresAt,
      metadata: {
        source: "event_cart_v1",
        ticket_price_source: ticketType ? getTicketPriceLabel(ticketType) : null,
      },
    })
    .select("id")
    .single();

  if (orderError || !order) {
    console.error("event cart order insert failed:", orderError);
    return NextResponse.redirect(absoluteEventUrl(request, eventSlug, "?error=cart_order_failed"));
  }

  try {
    const orderItems = [];

    if (ticketType) {
      const unitPrice = getActiveTicketPrice(ticketType);
      const attendeeNames = [
        buyerName,
        ...additionalAttendeeNames.slice(
          0,
          Math.max(0, Math.max(1, quantity) * Math.max(1, Number(ticketType.attendees_per_ticket ?? 1) || 1) - 1)
        ),
      ];

      const { data: registration, error: registrationError } = await supabase
        .from("event_registrations")
        .insert({
          studio_id: event.studio_id,
          event_id: event.id,
          ticket_type_id: ticketType.id,
          client_id: null,
          user_id: null,
          order_id: order.id,
          status: "pending",
          attendee_first_name: buyerFirstName || splitFullName(buyerName).firstName,
          attendee_last_name: buyerLastName || splitFullName(buyerName).lastName,
          attendee_email: buyerEmail,
          attendee_phone: buyerPhone || null,
          quantity,
          unit_price: unitPrice,
          total_price: ticketTotal,
          total_amount: ticketTotal,
          currency,
          payment_status: "pending",
          registration_source: "public_event_page",
          source: "public_event_page",
          notes: buyerNotes || null,
          checked_in_at: null,
          cancelled_at: null,
        })
        .select("id")
        .single();

      if (registrationError || !registration) {
        throw new Error(registrationError?.message ?? "Registration insert failed.");
      }

      registrationId = registration.id;

      const { error: registrationItemError } = await supabase
        .from("event_registration_items")
        .insert({
          registration_id: registration.id,
          ticket_type_id: ticketType.id,
          ticket_name_snapshot: ticketType.name,
          quantity,
          unit_price: unitPrice,
          line_total: ticketTotal,
        });

      if (registrationItemError) {
        throw new Error(registrationItemError.message);
      }

      const attendeeRows = attendeeNames.map((name, index) => {
        const parsed = index === 0
          ? {
              firstName: buyerFirstName || splitFullName(buyerName).firstName,
              lastName: buyerLastName || splitFullName(buyerName).lastName,
            }
          : splitFullName(name);

        return {
          registration_id: registration.id,
          event_id: event.id,
          ticket_type_id: ticketType!.id,
          first_name: parsed.firstName,
          last_name: parsed.lastName,
          email: index === 0 ? buyerEmail : null,
          phone: index === 0 ? buyerPhone || null : null,
          attendee_role: "attendee",
          sort_order: index + 1,
        };
      });

      const { error: attendeeError } = await supabase
        .from("event_registration_attendees")
        .insert(attendeeRows);

      if (attendeeError) {
        throw new Error(attendeeError.message);
      }

      orderItems.push({
        order_id: order.id,
        event_id: event.id,
        item_type: "ticket",
        reference_id: ticketType.id,
        ticket_type_id: ticketType.id,
        description: `${event.name} — ${ticketType.name}`,
        quantity,
        unit_price: unitPrice,
        total_price: ticketTotal,
        currency,
        attendee_names: attendeeNames,
        metadata: {
          registration_id: registration.id,
          attendees_per_ticket: ticketType.attendees_per_ticket ?? 1,
        },
      });
    }

    if (slots.length > 0) {
      const { data: heldSlots, error: holdError } = await supabase
        .from("event_private_lesson_slots")
        .update({
          status: "held",
          buyer_name: buyerName,
          buyer_email: buyerEmail,
          buyer_phone: buyerPhone || null,
          buyer_notes: buyerNotes || null,
          order_id: order.id,
          held_until: holdUntil,
          hold_token: holdToken,
          updated_at: new Date().toISOString(),
        })
        .in("id", slotIds)
        .eq("status", "available")
        .eq("payment_status", "unpaid")
        .select("id");

      if (holdError || !heldSlots || heldSlots.length !== slotIds.length) {
        throw new Error(holdError?.message ?? "Could not hold all selected coach slots.");
      }

      for (const slot of slots) {
        const coach = pickOne(slot.event_guest_coaches);
        const price = Number(slot.price ?? 0);

        orderItems.push({
          order_id: order.id,
          event_id: event.id,
          item_type: "coach_slot",
          reference_id: slot.id,
          coach_slot_id: slot.id,
          description: `${event.name} — Private Lesson with ${coach?.name ?? "Guest Coach"}`,
          quantity: 1,
          unit_price: price,
          total_price: price,
          currency,
          attendee_names: [buyerName],
          metadata: {
            coach_id: slot.coach_id,
            starts_at: slot.starts_at,
            ends_at: slot.ends_at,
            location_label: slot.location_label,
          },
        });
      }
    }

    const { error: orderItemsError } = await supabase
      .from("event_order_items")
      .insert(orderItems);

    if (orderItemsError) {
      throw new Error(orderItemsError.message);
    }

    const feePercent = await getOrganizerPlatformFeePercent(supabase, event.studio_id);
    const applicationFeeAmount = calculateApplicationFeeAmount(totalAmount, feePercent);

    const lineItems = orderItems.map((item) => ({
      quantity: item.quantity,
      price_data: {
        currency: currency.toLowerCase(),
        unit_amount: Math.round(Number(item.unit_price ?? 0) * 100),
        product_data: {
          name: item.description,
        },
      },
    }));

    const connectedAccountId = studio.stripe_connected_account_id;

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer_email: buyerEmail,
      success_url: absoluteEventUrl(request, eventSlug, `?success=cart_paid&order=${encodeURIComponent(order.id)}`),
      cancel_url: new URL(`/api/events/cart/release?orderId=${encodeURIComponent(order.id)}&eventSlug=${encodeURIComponent(eventSlug)}`, request.nextUrl.origin).toString(),
      line_items: lineItems,
      payment_intent_data: {
        ...(applicationFeeAmount > 0 ? { application_fee_amount: applicationFeeAmount } : {}),
        transfer_data: {
          destination: connectedAccountId,
        },
        metadata: {
          source: "event_cart_order",
          studio_id: event.studio_id,
          event_id: event.id,
          event_slug: eventSlug,
          order_id: order.id,
          registration_id: registrationId ?? "",
          connected_account_id: connectedAccountId,
        },
      },
      metadata: {
        source: "event_cart_order",
        studio_id: event.studio_id,
        event_id: event.id,
        event_slug: eventSlug,
        order_id: order.id,
        registration_id: registrationId ?? "",
        buyer_email: buyerEmail,
        connected_account_id: connectedAccountId,
      },
    });

    const { error: sessionLinkError } = await supabase
      .from("event_orders")
      .update({
        stripe_checkout_session_id: session.id,
        updated_at: new Date().toISOString(),
      })
      .eq("id", order.id);

    if (sessionLinkError) {
      throw new Error(sessionLinkError.message);
    }

    if (registrationId) {
      await supabase
        .from("event_registrations")
        .update({
          stripe_checkout_session_id: session.id,
        })
        .eq("id", registrationId);
    }

    if (!session.url) {
      throw new Error("Stripe did not return a checkout URL.");
    }

    return NextResponse.redirect(session.url, { status: 303 });
  } catch (error) {
    console.error("event cart checkout failed:", error);

    await supabase
      .from("event_private_lesson_slots")
      .update({
        status: "available",
        payment_status: "unpaid",
        buyer_name: null,
        buyer_email: null,
        buyer_phone: null,
        buyer_notes: null,
        order_id: null,
        held_until: null,
        hold_token: null,
        stripe_checkout_session_id: null,
        updated_at: new Date().toISOString(),
      })
      .eq("order_id", order.id)
      .eq("status", "held");

    await supabase
      .from("event_registrations")
      .update({
        status: "cancelled",
        payment_status: "failed",
        cancelled_at: new Date().toISOString(),
      })
      .eq("order_id", order.id)
      .eq("status", "pending");

    await supabase
      .from("event_orders")
      .update({
        status: "cancelled",
        payment_status: "failed",
        cancelled_at: new Date().toISOString(),
      })
      .eq("id", order.id);

    return NextResponse.redirect(absoluteEventUrl(request, eventSlug, "?error=cart_checkout_failed"));
  }
}



