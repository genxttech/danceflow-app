import { NextRequest, NextResponse } from "next/server";
import {
  createClient as createSupabaseClient,
  SupabaseClient,
} from "@supabase/supabase-js";
import { randomUUID } from "crypto";
import { beginEventSigningCheckpoint } from "@/lib/documents/event-signing";
import { getStripe } from "@/lib/payments/stripe";
import {
  checkoutSessionExpiresAtForHold,
  newEventCartHoldUntil,
  recordEventCartPaymentAttempt,
  releaseEventCartOrder,
  releaseUnattemptedEventCartOrders,
} from "@/lib/events/cartSettlement";
import {
  cleanFormText,
  getValidatedValue,
  getValidationError,
  normalizeOptionalPhone,
  normalizeRequiredEmail,
  normalizeRequiredSlug,
  normalizeOptionalUuid,
  normalizeTextList,
  cleanTextValue,
  rawFormString,
} from "@/lib/validation/forms";
import { checkRateLimit, getIpFromRequest, rateLimitKey, rateLimitedJson } from "@/lib/security/rate-limit";
import { effectiveTicketPrice, fromMinorUnits, ticketLineTotalCents, toMinorUnits } from "@/lib/events/ticketPricing";
import { studioHasCurrentOrganizerSuiteEntitlement } from "@/lib/billing/organizerSuiteEntitlement";

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

/**
 * CI-A: an ORDER-PRESERVING list for the per-line cart fields (ticketTypeIds, ticketQuantities,
 * expectedUnitPriceCents). These are paired by position, so duplicates and empty entries must be kept:
 * normalizeTextList de-duplicates and drops empties, which misaligned lines (e.g. two tickets each with quantity "1"
 * collapsed to one quantity and silently dropped the second ticket).
 */
function getPositionalTextList(formData: FormData, key: string, fieldLabel: string, maxItemLength: number, maxItems: number) {
  const rawValues = formData.getAll(key).map((value) => (typeof value === "string" ? value : ""));
  if (rawValues.length > maxItems) return { ok: false as const, error: `${fieldLabel} has too many selections.` };
  const values: string[] = [];
  for (const value of rawValues) {
    const cleaned = cleanTextValue(value, { fieldLabel, maxLength: maxItemLength });
    if (!cleaned.ok) return cleaned;
    values.push(cleaned.value ?? "");
  }
  return { ok: true as const, value: values };
}

function getPositionalUuidList(formData: FormData, key: string, fieldLabel: string, maxItems: number) {
  const list = getPositionalTextList(formData, key, fieldLabel, 36, maxItems);
  if (!list.ok) return list;
  for (const value of list.value) {
    if (!value) continue;
    const uuid = normalizeOptionalUuid(value, fieldLabel);
    if (!uuid.ok || !uuid.value) return { ok: false as const, error: `${fieldLabel} contains an invalid selection.` };
  }
  return list;
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

  const hasOrganizerSuiteAddOn = await studioHasCurrentOrganizerSuiteEntitlement(
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
  early_bird_enabled: boolean | null;
  early_bird_price: number | string | null;
  early_bird_ends_at: string | null;
};

type TicketSelection = {
  ticket: TicketTypeRow;
  quantity: number;
  /** CI-A: server-authoritative effective unit price and line total, in cents. */
  unitCents: number;
  lineCents: number;
  regularCents: number;
  isEarlyBird: boolean;
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
  const ticketTypeIdsResult = getPositionalUuidList(formData, "ticketTypeIds", "Ticket types", 50);
  const ticketQuantitiesResult = getPositionalTextList(formData, "ticketQuantities", "Ticket quantities", 6, 50);
  // CI-A: the unit price (cents) the buyer was shown for each submitted ticket line, aligned with ticketTypeIds.
  const expectedUnitPriceCentsResult = getPositionalTextList(formData, "expectedUnitPriceCents", "Ticket prices", 9, 50);
  const additionalAttendeeNamesResult = getSafeTextList(
    formData,
    "additionalAttendeeNames",
    "Additional attendee names",
    120,
    100
  );
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
    expectedUnitPriceCentsResult,
    additionalAttendeeNamesResult,
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
  const expectedUnitPriceCentsValues = getValidatedValue(expectedUnitPriceCentsResult);
  const additionalAttendeeNames = getValidatedValue(additionalAttendeeNamesResult);
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

  const expectedUnitCentsByTicketType = new Map<string, number>();
  ticketTypeIds.forEach((ticketTypeId, index) => {
    const raw = expectedUnitPriceCentsValues[index];
    if (!ticketTypeId || raw === undefined || raw === "") return;
    const cents = /^\d{1,8}$/.test(raw) ? Number(raw) : Number.NaN;
    const current = expectedUnitCentsByTicketType.get(ticketTypeId);
    // A malformed expectation is treated as "shown nothing payable": it can only cause a price-change refusal.
    const value = Number.isSafeInteger(cents) ? cents : -1;
    expectedUnitCentsByTicketType.set(ticketTypeId, current === undefined ? value : Math.min(current, value));
  });

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

  const organizerPlatformFeePercent = event.organizer_id
    ? await getOrganizerPlatformFeePercent(supabase, event.studio_id)
    : 0;

  if (event.organizer_id && organizerPlatformFeePercent <= 0) {
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


  const ticketSelections: TicketSelection[] = [];
  let ticketTotalCents = 0;
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
        attendees_per_ticket,
        early_bird_enabled,
        early_bird_price,
        early_bird_ends_at
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
    // CI-A: one evaluation instant for the whole cart.
    const pricingNowMs = Date.now();

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

      // CI-A: the server-authoritative effective price (early bird strictly before its cutoff). A ticket whose
      // price is not a valid amount is not sold. Nothing has been written yet.
      const pricing = effectiveTicketPrice(ticket, pricingNowMs);
      const lineCents = pricing.ok ? ticketLineTotalCents(pricing.unitCents, safeQuantity) : null;
      if (!pricing.ok || lineCents === null) {
        return NextResponse.redirect(
          absoluteEventUrl(request, eventSlug, "?error=ticket_unavailable"),
        );
      }

      // The price the buyer saw must not be exceeded silently (e.g. the early-bird cutoff passed while the form was
      // open): refuse, so the buyer reviews the current price and submits again.
      const expectedUnitCents = expectedUnitCentsByTicketType.get(ticket.id);
      if (expectedUnitCents !== undefined && pricing.unitCents > expectedUnitCents) {
        return NextResponse.redirect(
          absoluteEventUrl(request, eventSlug, "?error=ticket_price_changed"),
        );
      }

      ticketSelections.push({
        ticket,
        quantity: safeQuantity,
        unitCents: pricing.unitCents,
        lineCents,
        regularCents: pricing.regularCents,
        isEarlyBird: pricing.isEarlyBird,
        attendeeNames: [buyerName, ...additionalForTicket],
      });

      ticketCurrency = ticket.currency || ticketCurrency || "USD";
      ticketTotalCents += lineCents;
    }

    // PAY-WH-1: only this buyer's earlier orders for this event that never reached Stripe (no payment attempt, no
    // stored Stripe reference) are released here. An order whose Checkout Session may still be paid is left to its
    // own expiry / two-phase release, so a second tab can never cancel a payable checkout.
    try {
      await releaseUnattemptedEventCartOrders(supabase, {
        eventId: event.id,
        buyerEmail,
        excludeOrderId: null,
      });
    } catch (staleRegistrationCleanupError) {
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
  // PAY-WH-1: the hold outlives the Checkout Session (which expires first), see checkoutSessionExpiresAtForHold.
  const holdUntil = newEventCartHoldUntil();

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

  let slotTotalCents = 0;
  for (const slot of slots) {
    const slotCents = toMinorUnits(slot.price ?? 0);
    if (slotCents === null) {
      return NextResponse.redirect(
        absoluteEventUrl(request, eventSlug, "?error=coach_slot_unavailable"),
      );
    }
    slotTotalCents += slotCents;
  }
  const currency = (ticketCurrency || "USD").toUpperCase();
  // CI-A: totals are summed in integer cents; the stored amounts are the exact cents / 100.
  const totalAmountCents = ticketTotalCents + slotTotalCents;
  const totalAmount = fromMinorUnits(totalAmountCents);

  if (totalAmountCents <= 0) {
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
    .select("id, metadata")
    .single();

  if (orderError || !order) {
    console.error("event cart order insert failed:", orderError);
    return NextResponse.redirect(
      absoluteEventUrl(request, eventSlug, "?error=cart_order_failed"),
    );
  }

  // Deterministic failure classification: set from known execution phase, not
  // guessed from exception text. Flipped to "checkout_session" immediately
  // before the Stripe call; everything before that point (including
  // required-document checkpoint creation) is "document_setup". A genuine
  // Stripe user cancellation never reaches this catch block at all -- it is
  // handled entirely by /api/events/cart/release, a separate route that
  // never writes event_orders.metadata.
  let executionPhase: "document_setup" | "checkout_session" = "document_setup";
  let createdCheckoutSessionId: string | null = null;
  let createdCheckoutSessionAccount: string | null = null;

  try {
    const orderItems = [];

    for (const ticketSelection of ticketSelections) {
      const ticketType = ticketSelection.ticket;
      const quantity = ticketSelection.quantity;
      const ticketTotal = fromMinorUnits(ticketSelection.lineCents);
      const unitPrice = fromMinorUnits(ticketSelection.unitCents);
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
          // CI-A: the price evidence for this line, as charged.
          pricing: {
            rule: "effective_ticket_price_v1",
            unit_cents: ticketSelection.unitCents,
            regular_unit_cents: ticketSelection.regularCents,
            early_bird: ticketSelection.isEarlyBird,
            early_bird_ends_at: ticketSelection.isEarlyBird ? ticketType.early_bird_ends_at : null,
          },
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

    if (requiredDocuments.length > 0) {
      const checkpoint = await beginEventSigningCheckpoint({
        orderId: order.id,
        eventId: event.id,
        studioId: event.studio_id,
        organizerId: event.organizer_id,
        buyerEmail,
        requirementIds: requiredDocumentIds,
        registrationIds,
        surface: "web",
        paymentMode: "checkout",
      });

      if (!checkpoint?.signingUrl) {
        throw new Error("Required event documents could not be started.");
      }

      return NextResponse.redirect(checkpoint.signingUrl, { status: 303 });
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

    executionPhase = "checkout_session";
    const sessionExpiresAt = checkoutSessionExpiresAtForHold(holdUntil);
    if (!sessionExpiresAt) {
      throw new Error("Checkout hold is too short for a Stripe Checkout Session.");
    }
    const session = await stripe.checkout.sessions.create(
      {
      mode: "payment",
      // PAY-WH-1: the Session stops accepting payment before the capacity hold ends.
      expires_at: sessionExpiresAt,
      // PAY-WH-1A: card payments only (wallets included) -- the settlement path tested end to end. Delayed methods
      // (ACH etc.) stay off until they are released as a separate, tested decision.
      payment_method_types: ["card"],
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
        metadata: {
          source: "event_cart_order",
          studio_id: event.studio_id,
          event_id: event.id,
          event_slug: eventSlug,
          order_id: order.id,
          registration_id: registrationIds[0] ?? "",
          registration_ids: registrationIds.join(","),
          connected_account_id: connectedAccountId,
          charge_model: "direct",
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
        charge_model: "direct",
      },
    },
    {
      stripeAccount: connectedAccountId,
    },
    );

    createdCheckoutSessionId = session.id;
    createdCheckoutSessionAccount = connectedAccountId;
    // PAY-WH-1: every Stripe object created for an order is recorded as an immutable payment attempt; settlement
    // binds the attempt that actually paid. Registrations get their Stripe identifiers only at settlement.
    await recordEventCartPaymentAttempt(supabase, {
      orderId: order.id,
      stripeAccountId: connectedAccountId,
      kind: "checkout_session",
      checkoutSessionId: session.id,
      amountCents: totalAmountCents,
      currency,
      surface: "web",
      expiresAt: new Date(sessionExpiresAt * 1000).toISOString(),
    });

    if (!session.url) {
      throw new Error("Stripe did not return a checkout URL.");
    }

    return NextResponse.redirect(session.url, { status: 303 });
  } catch (error) {
    console.error("event cart checkout failed:", error);

    if (createdCheckoutSessionId && createdCheckoutSessionAccount) {
      // A Session that was created but could not be recorded must not stay payable.
      try {
        await stripe.checkout.sessions.expire(createdCheckoutSessionId, {}, { stripeAccount: createdCheckoutSessionAccount });
      } catch (expireError) {
        console.error("event cart checkout: could not expire the unrecorded Checkout Session", expireError);
      }
    }

    const failureReason =
      executionPhase === "document_setup"
        ? "document_setup_failed"
        : "checkout_session_failed";

    try {
      await releaseEventCartOrder({ admin: supabase, stripe, orderId: order.id, reason: failureReason });
    } catch (releaseError) {
      // The hold lapses on its own and the reconcile sweeper retries the release.
      console.error("event cart checkout: release after failure did not complete", releaseError);
    }

    await supabase
      .from("event_orders")
      .update({
        metadata: { ...(order.metadata ?? {}), failure_reason: failureReason },
      })
      .eq("id", order.id);
    return NextResponse.redirect(
      absoluteEventUrl(request, eventSlug, "?error=cart_checkout_failed"),
    );
  }
}