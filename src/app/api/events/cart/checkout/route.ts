import { NextRequest, NextResponse } from "next/server";
import {
  createClient as createSupabaseClient,
  SupabaseClient,
} from "@supabase/supabase-js";
import { randomUUID } from "crypto";
import { getStripe } from "@/lib/payments/stripe";
import {
  cleanFormText,
  getValidatedValue,
  getValidationError,
  normalizeOptionalPhone,
  normalizeRequiredEmail,
  normalizeRequiredSlug,
  normalizeOptionalUuid,
  normalizeTextList,
  rawFormString,
} from "@/lib/validation/forms";
import { checkRateLimit, getIpFromRequest, rateLimitKey, rateLimitedJson } from "@/lib/security/rate-limit";

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

function getBoundedInt(formData: FormData, key: string, fallback = 0, max = 50) {
  const raw = getString(formData, key);
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(0, parsed));
}

function getSafeTextList(formData: FormData, key: string, fieldLabel: string, maxItemLength = 120, maxItems = 100) {
  const rawValues = formData
    .getAll(key)
    .map((value) => (typeof value === "string" ? value : ""));

  return normalizeTextList(rawValues, {
    fieldLabel,
    maxItemLength,
    maxItems,
  });
}

function getSafeUuidList(formData: FormData, key: string, fieldLabel: string, maxItems = 100) {
  const rawValues = formData
    .getAll(key)
    .map((value) => (typeof value === "string" ? value : ""));

  const cleaned = normalizeTextList(rawValues, {
    fieldLabel,
    maxItemLength: 36,
    maxItems,
  });

  if (!cleaned.ok) return cleaned;

  for (const value of cleaned.value) {
    const uuid = normalizeOptionalUuid(value, fieldLabel);
    if (!uuid.ok || !uuid.value) {
      return { ok: false as const, error: `${fieldLabel} contains an invalid selection.` };
    }
  }

  return cleaned;
}

function splitFullName(fullName: string) {
  const normalized = fullName.trim().replace(/\s+/g, " ");
  const [firstName = "", ...rest] = normalized.split(" ");

  return {
    firstName,
    lastName: rest.join(" "),
  };
}

function absoluteEventUrl(
  request: NextRequest,
  eventSlug: string,
  query: string,
) {
  return new URL(
    `/events/${encodeURIComponent(eventSlug)}${query}`,
    request.nextUrl.origin,
  ).toString();
}

function calculateApplicationFeeAmount(amount: number, feePercent: number) {
  return Math.round(
    Math.max(0, Math.round(amount * 100)) * Math.max(0, feePercent),
  );
}

const ORGANIZER_SUITE_STANDARD_FEE_PERCENT = 0.035;
const ORGANIZER_SUITE_STUDIO_ADDON_FEE_PERCENT = 0.0325;
const ORGANIZER_SUITE_PRO_ADDON_FEE_PERCENT = 0.03;

function normalizePlanCode(value: string | null | undefined) {
  return (value ?? "").trim().toLowerCase();
}

function isActiveBillingStatus(value: string | null | undefined) {
  return value === "active" || value === "trialing";
}

async function studioHasActiveOrganizerSuiteAddOn(
  supabase: SupabaseClient,
  studioId: string,
) {
  const { data, error } = await supabase
    .from("usage_addon_entitlements")
    .select("id")
    .eq("studio_id", studioId)
    .eq("feature_key", "organizer_suite")
    .in("source", ["stripe_subscription_item", "manual_grant"])
    .eq("status", "active")
    .limit(1);

  if (error) {
    console.error("Failed to read Organizer Suite add-on entitlement", error);
    return false;
  }

  return Boolean(data?.length);
}

async function getOrganizerPlatformFeePercent(
  supabase: SupabaseClient,
  studioId: string,
) {
  const { data: subscription, error } = await supabase
    .from("studio_subscriptions")
    .select(
      `
      status,
      subscription_plans (
        code,
        name
      )
    `,
    )
    .eq("studio_id", studioId)
    .maybeSingle();

  if (error) {
    console.error(
      "Failed to read studio subscription for event platform fee",
      error,
    );
    return 0;
  }

  if (!subscription || !isActiveBillingStatus(subscription.status ?? null)) {
    return 0;
  }

  const rawPlan = subscription.subscription_plans;
  const plan = Array.isArray(rawPlan) ? rawPlan[0] : rawPlan;
  const planCode = normalizePlanCode(plan?.code ?? null);

  if (planCode === "organizer") {
    return ORGANIZER_SUITE_STANDARD_FEE_PERCENT;
  }

  if (!["starter", "growth", "pro"].includes(planCode)) {
    return 0;
  }

  const hasOrganizerSuiteAddOn = await studioHasActiveOrganizerSuiteAddOn(
    supabase,
    studioId,
  );
  if (!hasOrganizerSuiteAddOn) {
    return 0;
  }

  return planCode === "pro"
    ? ORGANIZER_SUITE_PRO_ADDON_FEE_PERCENT
    : ORGANIZER_SUITE_STUDIO_ADDON_FEE_PERCENT;
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

type EventDocumentRequirementRow = {
  id: string;
  event_id: string;
  template_id: string;
  template_version_id: string | null;
  studio_id: string | null;
  organizer_id: string | null;
  document_templates:
    | {
        id: string;
        title: string;
        body: string;
        current_version: number | null;
      }
    | {
        id: string;
        title: string;
        body: string;
        current_version: number | null;
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
  attendees_per_ticket: number | null;
};

type TicketSelection = {
  ticket: TicketTypeRow;
  quantity: number;
  total: number;
  attendeeNames: string[];
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
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}

function validateRegistrationWindow(event: CartEventRow) {
  const now = Date.now();

  if (!event.registration_required) return null;

  if (
    event.registration_opens_at &&
    new Date(event.registration_opens_at).getTime() > now
  ) {
    return "registration_not_open";
  }

  if (
    event.registration_closes_at &&
    new Date(event.registration_closes_at).getTime() < now
  ) {
    return "registration_closed";
  }

  return null;
}

function validateTicketWindow(ticket: TicketTypeRow) {
  const now = Date.now();

  if (!ticket.active) return "ticket_unavailable";

  if (
    ticket.sale_starts_at &&
    new Date(ticket.sale_starts_at).getTime() > now
  ) {
    return "ticket_not_open";
  }

  if (ticket.sale_ends_at && new Date(ticket.sale_ends_at).getTime() < now) {
    return "ticket_closed";
  }

  return null;
}

export async function POST(request: NextRequest) {
  const rateLimit = checkRateLimit(
    rateLimitKey("checkout:event-cart", getIpFromRequest(request)),
    { limit: 8, windowMs: 15 * 60 * 1000 },
  );

  if (!rateLimit.allowed) {
    return rateLimitedJson(rateLimit);
  }

  const supabase = getSupabaseAdmin();
  const stripe = getStripe();
  const formData = await request.formData();

  const eventSlugResult = normalizeRequiredSlug(rawFormString(formData, "eventSlug"), "Event");
  const buyerFirstNameResult = cleanFormText(formData, "attendeeFirstName", {
    fieldLabel: "First name",
    maxLength: 80,
  });
  const fallbackBuyerFirstNameResult = cleanFormText(formData, "buyerFirstName", {
    fieldLabel: "First name",
    maxLength: 80,
  });
  const buyerLastNameResult = cleanFormText(formData, "attendeeLastName", {
    fieldLabel: "Last name",
    maxLength: 80,
  });
  const fallbackBuyerLastNameResult = cleanFormText(formData, "buyerLastName", {
    fieldLabel: "Last name",
    maxLength: 80,
  });
  const buyerNameResult = cleanFormText(formData, "buyerName", {
    fieldLabel: "Buyer name",
    maxLength: 160,
  });
  const buyerEmailResult = normalizeRequiredEmail(
    rawFormString(formData, "attendeeEmail") || rawFormString(formData, "buyerEmail"),
    "Email"
  );
  const buyerPhoneResult = normalizeOptionalPhone(
    rawFormString(formData, "attendeePhone") || rawFormString(formData, "buyerPhone"),
    "Phone"
  );
  const buyerNotesResult = cleanFormText(formData, "notes", {
    fieldLabel: "Notes",
    maxLength: 2000,
    allowNewlines: true,
  });
  const fallbackBuyerNotesResult = cleanFormText(formData, "buyerNotes", {
    fieldLabel: "Notes",
    maxLength: 2000,
    allowNewlines: true,
  });
  const legacyTicketTypeIdResult = normalizeOptionalUuid(rawFormString(formData, "ticketTypeId"), "Ticket type");
  const ticketTypeIdsResult = getSafeUuidList(formData, "ticketTypeIds", "Ticket types", 50);
  const ticketQuantitiesResult = getSafeTextList(formData, "ticketQuantities", "Ticket quantities", 6, 50);
  const additionalAttendeeNamesResult = getSafeTextList(
    formData,
    "additionalAttendeeNames",
    "Additional attendee names",
    120,
    100
  );
  const submittedDocumentRequirementIdsResult = getSafeUuidList(
    formData,
    "documentRequirementIds",
    "Document requirements",
    25
  );
  const documentSignatureNameResult = cleanFormText(formData, "documentSignatureName", {
    fieldLabel: "Signature name",
    maxLength: 120,
  });
  const slotIdsResult = getSafeUuidList(formData, "slotIds", "Coach slots", 50);
  const slotIdResult = getSafeUuidList(formData, "slotId", "Coach slots", 50);

  const validationError = getValidationError([
    eventSlugResult,
    buyerFirstNameResult,
    fallbackBuyerFirstNameResult,
    buyerLastNameResult,
    fallbackBuyerLastNameResult,
    buyerNameResult,
    buyerEmailResult,
    buyerPhoneResult,
    buyerNotesResult,
    fallbackBuyerNotesResult,
    legacyTicketTypeIdResult,
    ticketTypeIdsResult,
    ticketQuantitiesResult,
    additionalAttendeeNamesResult,
    submittedDocumentRequirementIdsResult,
    documentSignatureNameResult,
    slotIdsResult,
    slotIdResult,
  ]);

  const eventSlug = eventSlugResult.ok ? eventSlugResult.value : "";

  if (validationError) {
    return NextResponse.redirect(
      absoluteEventUrl(request, eventSlug, `?error=${encodeURIComponent("invalid_input")}`),
    );
  }

  const buyerFirstName = getValidatedValue(buyerFirstNameResult) || getValidatedValue(fallbackBuyerFirstNameResult);
  const buyerLastName = getValidatedValue(buyerLastNameResult) || getValidatedValue(fallbackBuyerLastNameResult);
  const explicitBuyerName = getValidatedValue(buyerNameResult);
  const buyerName = explicitBuyerName || [buyerFirstName, buyerLastName].filter(Boolean).join(" ");
  const buyerEmail = getValidatedValue(buyerEmailResult);
  const buyerPhone = getValidatedValue(buyerPhoneResult);
  const buyerNotes = getValidatedValue(buyerNotesResult) || getValidatedValue(fallbackBuyerNotesResult);

  const legacyTicketTypeId = getValidatedValue(legacyTicketTypeIdResult) ?? "";
  const legacyQuantity = getBoundedInt(
    formData,
    "quantity",
    legacyTicketTypeId ? 1 : 0,
    50
  );
  const ticketTypeIds = getValidatedValue(ticketTypeIdsResult);
  const ticketQuantities = getValidatedValue(ticketQuantitiesResult);
  const additionalAttendeeNames = getValidatedValue(additionalAttendeeNamesResult);
  const submittedDocumentRequirementIds = getValidatedValue(submittedDocumentRequirementIdsResult);
  const documentSignatureName = getValidatedValue(documentSignatureNameResult);
  const documentConsentAccepted =
    getString(formData, "documentConsentAccepted") === "on";
  const slotIds = Array.from(
    new Set(getValidatedValue(slotIdsResult).concat(getValidatedValue(slotIdResult))),
  );

  if (!eventSlug) {
    return NextResponse.redirect(
      absoluteEventUrl(request, "", "?error=missing_event"),
    );
  }

  if (!buyerName || !buyerEmail) {
    return NextResponse.redirect(
      absoluteEventUrl(request, eventSlug, "?error=cart_contact_required"),
    );
  }

  const submittedTicketSelections = ticketTypeIds
    .map((ticketTypeId, index) => ({
      ticketTypeId,
      quantity: Math.max(
        0,
        Math.min(50, Number.parseInt(ticketQuantities[index] ?? "0", 10) || 0),
      ),
    }))
    .filter((selection) => selection.ticketTypeId && selection.quantity > 0);

  if (
    legacyTicketTypeId &&
    legacyQuantity > 0 &&
    submittedTicketSelections.length === 0
  ) {
    submittedTicketSelections.push({
      ticketTypeId: legacyTicketTypeId,
      quantity: legacyQuantity,
    });
  }

  const dedupedSubmittedTicketSelections = Array.from(
    submittedTicketSelections
      .reduce((map, selection) => {
        const existing = map.get(selection.ticketTypeId);
        map.set(selection.ticketTypeId, {
          ticketTypeId: selection.ticketTypeId,
          quantity: (existing?.quantity ?? 0) + selection.quantity,
        });
        return map;
      }, new Map<string, { ticketTypeId: string; quantity: number }>())
      .values(),
  );

  if (dedupedSubmittedTicketSelections.length === 0 && slotIds.length === 0) {
    return NextResponse.redirect(
      absoluteEventUrl(request, eventSlug, "?error=cart_empty"),
    );
  }

  const { data: event, error: eventError } = await supabase
    .from("events")
    .select(
      `
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
    `,
    )
    .eq("slug", eventSlug)
    .maybeSingle<CartEventRow>();

  const studio = pickOne(event?.studios);

  const eventIsPublic =
    event?.status === "published" &&
    (event.visibility === "public" ||
      event.visibility === "unlisted" ||
      event.public_directory_enabled === true);
  const studioHasAccess = ["active", "trialing"].includes(
    studio?.subscription_status ?? "",
  );

  if (eventError || !event || !eventIsPublic || !studioHasAccess) {
    return NextResponse.redirect(
      absoluteEventUrl(request, eventSlug, "?error=event_unavailable"),
    );
  }

  if (!event.registration_required) {
    return NextResponse.redirect(
      absoluteEventUrl(request, eventSlug, "?error=registration_not_enabled"),
    );
  }

  const organizerPlatformFeePercent = await getOrganizerPlatformFeePercent(
    supabase,
    event.studio_id,
  );

  if (organizerPlatformFeePercent <= 0) {
    return NextResponse.redirect(
      absoluteEventUrl(request, eventSlug, "?error=organizer_suite_required"),
    );
  }

  if (
    !studio?.stripe_connected_account_id ||
    !studio.stripe_connect_onboarding_complete ||
    !studio.stripe_connect_payouts_enabled ||
    !studio.stripe_connect_charges_enabled
  ) {
    return NextResponse.redirect(
      absoluteEventUrl(request, eventSlug, "?error=studio_payouts_not_ready"),
    );
  }

  const { data: documentRequirementRows, error: documentRequirementError } =
    await supabase
      .from("event_document_requirements")
      .select(
        `
      id,
      event_id,
      template_id,
      template_version_id,
      studio_id,
      organizer_id,
      document_templates:template_id (
        id,
        title,
        body,
        current_version
      )
    `,
      )
      .eq("event_id", event.id)
      .eq("active", true)
      .eq("is_required", true);

  if (documentRequirementError) {
    console.error(
      "event waiver requirement lookup failed:",
      documentRequirementError,
    );
    return NextResponse.redirect(
      absoluteEventUrl(request, eventSlug, "?error=waiver_lookup_failed"),
    );
  }

  const requiredDocuments = (documentRequirementRows ??
    []) as EventDocumentRequirementRow[];
  const requiredDocumentIds = requiredDocuments.map((document) => document.id);

  if (requiredDocuments.length > 0) {
    const submittedIdSet = new Set(submittedDocumentRequirementIds);
    const allSubmitted = requiredDocumentIds.every((id) =>
      submittedIdSet.has(id),
    );

    if (
      !allSubmitted ||
      !documentConsentAccepted ||
      documentSignatureName.length < 2
    ) {
      return NextResponse.redirect(
        absoluteEventUrl(request, eventSlug, "?error=waiver_required"),
      );
    }
  }

  const ticketSelections: TicketSelection[] = [];
  let ticketTotal = 0;
  let ticketCurrency = "USD";
  const registrationIds: string[] = [];

  if (dedupedSubmittedTicketSelections.length > 0) {
    const registrationWindowError = validateRegistrationWindow(event);
    if (registrationWindowError) {
      return NextResponse.redirect(
        absoluteEventUrl(
          request,
          eventSlug,
          `?error=${registrationWindowError}`,
        ),
      );
    }

    const requestedTicketIds = dedupedSubmittedTicketSelections.map(
      (selection) => selection.ticketTypeId,
    );
    const { data: tickets, error: ticketsError } = await supabase
      .from("event_ticket_types")
      .select(
        `
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
        attendees_per_ticket
      `,
      )
      .eq("event_id", event.id)
      .in("id", requestedTicketIds);

    if (
      ticketsError ||
      !tickets ||
      tickets.length !== requestedTicketIds.length
    ) {
      return NextResponse.redirect(
        absoluteEventUrl(request, eventSlug, "?error=ticket_unavailable"),
      );
    }

    const ticketsById = new Map(
      (tickets as TicketTypeRow[]).map((ticket) => [ticket.id, ticket]),
    );
    let additionalAttendeeCursor = 0;

    for (const submittedSelection of dedupedSubmittedTicketSelections) {
      const ticket = ticketsById.get(submittedSelection.ticketTypeId);
      if (!ticket) {
        return NextResponse.redirect(
          absoluteEventUrl(request, eventSlug, "?error=ticket_unavailable"),
        );
      }

      const ticketWindowError = validateTicketWindow(ticket);
      if (ticketWindowError) {
        return NextResponse.redirect(
          absoluteEventUrl(request, eventSlug, `?error=${ticketWindowError}`),
        );
      }

      const safeQuantity = Math.max(1, submittedSelection.quantity);
      if (ticket.capacity != null && safeQuantity > Number(ticket.capacity)) {
        return NextResponse.redirect(
          absoluteEventUrl(
            request,
            eventSlug,
            "?error=ticket_capacity_exceeded",
          ),
        );
      }

      const attendeesPerTicket = Math.max(
        1,
        Number(ticket.attendees_per_ticket ?? 1) || 1,
      );
      const expectedAttendeeCount = safeQuantity * attendeesPerTicket;
      const additionalCount = Math.max(0, expectedAttendeeCount - 1);
      const additionalForTicket = additionalAttendeeNames.slice(
        additionalAttendeeCursor,
        additionalAttendeeCursor + additionalCount,
      );

      if (additionalForTicket.length < additionalCount) {
        return NextResponse.redirect(
          absoluteEventUrl(request, eventSlug, "?error=missing_attendees"),
        );
      }

      additionalAttendeeCursor += additionalCount;

      const unitPrice = Number(ticket.price ?? 0);
      const selectionTotal = Number((unitPrice * safeQuantity).toFixed(2));

      ticketSelections.push({
        ticket,
        quantity: safeQuantity,
        total: selectionTotal,
        attendeeNames: [buyerName, ...additionalForTicket],
      });

      ticketCurrency = ticket.currency || ticketCurrency || "USD";
      ticketTotal = Number((ticketTotal + selectionTotal).toFixed(2));
    }

    // Failed cart checkout attempts can leave pending registrations behind before Stripe is reached.
    // Only stale pending cart attempts are cancelled. Prior completed purchases by the same email remain valid
    // and should not block a new order for another class, pass, or ticket option.
    const { error: staleRegistrationCleanupError } = await supabase
      .from("event_registrations")
      .update({
        status: "cancelled",
        payment_status: "failed",
        cancelled_at: new Date().toISOString(),
      })
      .eq("event_id", event.id)
      .eq("attendee_email", buyerEmail)
      .eq("status", "pending")
      .eq("payment_status", "pending")
      .not("order_id", "is", null);

    if (staleRegistrationCleanupError) {
      console.error(
        "event cart stale registration cleanup failed:",
        staleRegistrationCleanupError,
      );
      return NextResponse.redirect(
        absoluteEventUrl(
          request,
          eventSlug,
          "?error=registration_cleanup_failed",
        ),
      );
    }
  }

  let slots: SlotRow[] = [];
  const holdToken = randomUUID();
  const holdUntil = new Date(Date.now() + 15 * 60 * 1000).toISOString();

  if (slotIds.length > 0) {
    const { data: slotRows, error: slotsError } = await supabase
      .from("event_private_lesson_slots")
      .select(
        `
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
      `,
      )
      .eq("event_id", event.id)
      .in("id", slotIds);

    if (slotsError || !slotRows || slotRows.length !== slotIds.length) {
      return NextResponse.redirect(
        absoluteEventUrl(request, eventSlug, "?error=coach_slot_unavailable"),
      );
    }

    slots = slotRows as SlotRow[];

    const unavailableSlot = slots.find(
      (slot) => slot.status !== "available" || slot.payment_status !== "unpaid",
    );

    if (unavailableSlot) {
      return NextResponse.redirect(
        absoluteEventUrl(
          request,
          eventSlug,
          "?error=coach_slot_already_booked",
        ),
      );
    }
  }

  const slotTotal = slots.reduce(
    (sum, slot) => sum + Number(slot.price ?? 0),
    0,
  );
  const currency = (ticketCurrency || "USD").toUpperCase();
  const totalAmount = Number((ticketTotal + slotTotal).toFixed(2));

  if (totalAmount <= 0) {
    return NextResponse.redirect(
      absoluteEventUrl(request, eventSlug, "?error=cart_invalid_total"),
    );
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
        holdToken,
      },
    })
    .select("id")
    .single();

  if (orderError || !order) {
    console.error("event cart order insert failed:", orderError);
    return NextResponse.redirect(
      absoluteEventUrl(request, eventSlug, "?error=cart_order_failed"),
    );
  }

  try {
    const orderItems = [];

    for (const ticketSelection of ticketSelections) {
      const ticketType = ticketSelection.ticket;
      const quantity = ticketSelection.quantity;
      const ticketTotal = ticketSelection.total;
      const unitPrice = Number(ticketType.price ?? 0);
      const attendeeNames = ticketSelection.attendeeNames;

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
          attendee_first_name:
            buyerFirstName || splitFullName(buyerName).firstName,
          attendee_last_name:
            buyerLastName || splitFullName(buyerName).lastName,
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
        throw new Error(
          registrationError?.message ?? "Registration insert failed.",
        );
      }

      registrationIds.push(registration.id);

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
        const parsed =
          index === 0
            ? {
                firstName: buyerFirstName || splitFullName(buyerName).firstName,
                lastName: buyerLastName || splitFullName(buyerName).lastName,
              }
            : splitFullName(name);

        return {
          registration_id: registration.id,
          event_id: event.id,
          ticket_type_id: ticketType.id,
          first_name: parsed.firstName || "Guest",
          last_name: parsed.lastName || `${index + 1}`,
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

      if (requiredDocuments.length > 0) {
        const signerIp =
          request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
          request.headers.get("x-real-ip") ||
          null;
        const userAgent = request.headers.get("user-agent") || null;
        const consentText =
          "I have reviewed the required event document(s), agree to sign electronically, and confirm that my typed name is my signature.";

        for (const requiredDocument of requiredDocuments) {
          const template = Array.isArray(requiredDocument.document_templates)
            ? requiredDocument.document_templates[0]
            : requiredDocument.document_templates;

          if (!template) continue;

          const { data: assignment, error: assignmentError } = await supabase
            .from("document_assignments")
            .insert({
              template_id: requiredDocument.template_id,
              template_version_id: requiredDocument.template_version_id,
              studio_id: event.studio_id,
              organizer_id: event.organizer_id,
              event_id: event.id,
              event_registration_id: registration.id,
              assigned_to_email: buyerEmail,
              status: "signed",
              signed_at: new Date().toISOString(),
            })
            .select("id")
            .single();

          if (assignmentError || !assignment) {
            throw new Error(
              assignmentError?.message ??
                "Could not save event waiver assignment.",
            );
          }

          const { error: signatureError } = await supabase
            .from("document_signatures")
            .insert({
              assignment_id: assignment.id,
              template_id: requiredDocument.template_id,
              template_version_id: requiredDocument.template_version_id,
              studio_id: event.studio_id,
              organizer_id: event.organizer_id,
              event_id: event.id,
              event_registration_id: registration.id,
              signer_name: documentSignatureName,
              signer_email: buyerEmail,
              signed_body: template.body,
              signature_text: documentSignatureName,
              consent_text: consentText,
              ip_address: signerIp,
              user_agent: userAgent,
            });

          if (signatureError) {
            throw new Error(signatureError.message);
          }
        }
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
        throw new Error(
          holdError?.message ?? "Could not hold all selected coach slots.",
        );
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

    const applicationFeeAmount = calculateApplicationFeeAmount(
      totalAmount,
      organizerPlatformFeePercent,
    );

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
      success_url: absoluteEventUrl(
        request,
        eventSlug,
        `?success=cart_paid&order=${encodeURIComponent(order.id)}`,
      ),
      cancel_url: new URL(
        `/api/events/cart/release?orderId=${encodeURIComponent(order.id)}&eventSlug=${encodeURIComponent(eventSlug)}&holdToken=${encodeURIComponent(holdToken)}`,
        request.nextUrl.origin,
      ).toString(),
      line_items: lineItems,
      payment_intent_data: {
        ...(applicationFeeAmount > 0
          ? { application_fee_amount: applicationFeeAmount }
          : {}),
        transfer_data: {
          destination: connectedAccountId,
        },
        metadata: {
          source: "event_cart_order",
          studio_id: event.studio_id,
          event_id: event.id,
          event_slug: eventSlug,
          order_id: order.id,
          registration_id: registrationIds[0] ?? "",
          registration_ids: registrationIds.join(","),
          connected_account_id: connectedAccountId,
        },
      },
      metadata: {
        source: "event_cart_order",
        studio_id: event.studio_id,
        event_id: event.id,
        event_slug: eventSlug,
        order_id: order.id,
        registration_id: registrationIds[0] ?? "",
        registration_ids: registrationIds.join(","),
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

    if (registrationIds.length > 0) {
      await supabase
        .from("event_registrations")
        .update({
          stripe_checkout_session_id: session.id,
        })
        .in("id", registrationIds);
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

    return NextResponse.redirect(
      absoluteEventUrl(request, eventSlug, "?error=cart_checkout_failed"),
    );
  }
}
