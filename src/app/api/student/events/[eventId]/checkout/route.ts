import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { createClient as createSupabaseClient, SupabaseClient } from "@supabase/supabase-js";
import { getStripe } from "@/lib/payments/stripe";
import { sendMobilePushToUser } from "@/lib/notifications/expoPush";
import { getStudentApiUser, normalizeStudentApiUuid } from "@/lib/auth/studentApiAuth";
import {
  cleanTextValue,
  getValidatedValue,
  getValidationError,
  normalizeOptionalPhone,
  normalizeOptionalUuid,
  normalizeTextList,
} from "@/lib/validation/forms";
import { checkRateLimit, getIpFromRequest, rateLimitKey, rateLimitedJson } from "@/lib/security/rate-limit";

type Params = {
  params: Promise<{ eventId: string }>;
};

type TicketSelectionInput = {
  ticketTypeId: string;
  quantity: number;
};

type CheckoutBody = {
  additionalAttendeeNames?: string[];
  buyerFirstName?: string;
  buyerLastName?: string;
  buyerPhone?: string;
  documentConsentAccepted?: boolean;
  documentRequirementIds?: string[];
  documentSignatureName?: string;
  notes?: string;
  paymentMode?: "checkout" | "payment_sheet";
  returnUrl?: string;
  ticketSelections?: TicketSelectionInput[];
};

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
        subscription_status: string | null;
        stripe_connected_account_id: string | null;
        stripe_connect_charges_enabled: boolean | null;
        stripe_connect_payouts_enabled: boolean | null;
        stripe_connect_onboarding_complete: boolean | null;
      }
    | {
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

type EventDocumentRequirementRow = {
  id: string;
  template_id: string;
  template_version_id: string | null;
  document_templates:
    | { body: string | null }
    | { body: string | null }[]
    | null;
};

type TicketHoldCountRow = {
  ticket_type_id: string | null;
  quantity: number | null;
  event_ticket_types?: { attendees_per_ticket: number | null } | { attendees_per_ticket: number | null }[] | null;
};

function requestIpAddress(request: NextRequest) {
  const forwardedFor = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const realIp = request.headers.get("x-real-ip")?.trim();
  return forwardedFor || realIp || null;
}

function requestDeviceMetadata(request: NextRequest) {
  return {
    userAgent: request.headers.get("user-agent") || null,
    acceptLanguage: request.headers.get("accept-language") || null,
    platform: "student_app",
  };
}

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

function jsonError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

function getJsonText(value: unknown, fieldLabel: string, maxLength = 255, required = false) {
  return cleanTextValue(typeof value === "string" ? value : "", {
    fieldLabel,
    maxLength,
    required,
    allowNewlines: false,
  });
}

function getJsonTextarea(value: unknown, fieldLabel: string, maxLength = 2000) {
  return cleanTextValue(typeof value === "string" ? value : "", {
    fieldLabel,
    maxLength,
    allowNewlines: true,
  });
}

function getJsonStringArray(value: unknown, fieldLabel: string, maxItemLength = 120, maxItems = 100) {
  const values = Array.isArray(value) ? value.map((item) => (typeof item === "string" ? item : "")) : [];
  return normalizeTextList(values, { fieldLabel, maxItemLength, maxItems });
}

function normalizeTicketSelections(value: unknown) {
  if (!Array.isArray(value)) return { ok: true as const, value: [] as TicketSelectionInput[] };
  if (value.length > 50) return { ok: false as const, error: "Too many ticket selections." };

  const selections: TicketSelectionInput[] = [];

  for (const item of value) {
    const record = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
    const ticketTypeIdResult = normalizeOptionalUuid(
      typeof record.ticketTypeId === "string" ? record.ticketTypeId : "",
      "Ticket type"
    );
    if (!ticketTypeIdResult.ok) return ticketTypeIdResult;
    if (!ticketTypeIdResult.value) continue;

    const quantity = Math.max(0, Math.min(50, Number(record.quantity ?? 0) || 0));
    if (quantity > 0) {
      selections.push({ ticketTypeId: ticketTypeIdResult.value, quantity });
    }
  }

  return { ok: true as const, value: selections };
}

function pickOne<T>(value: T | T[] | null | undefined) {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function splitFullName(fullName: string) {
  const normalized = fullName.trim().replace(/\s+/g, " ");
  const [firstName = "", ...rest] = normalized.split(" ");
  return { firstName, lastName: rest.join(" ") };
}

function validateRegistrationWindow(event: CartEventRow) {
  const now = Date.now();

  if (!event.registration_required) return "Registration is not enabled for this event.";
  if (event.registration_opens_at && new Date(event.registration_opens_at).getTime() > now) {
    return "Registration has not opened yet.";
  }
  if (event.registration_closes_at && new Date(event.registration_closes_at).getTime() < now) {
    return "Registration is closed for this event.";
  }

  return null;
}

function validateTicketWindow(ticket: TicketTypeRow) {
  const now = Date.now();

  if (!ticket.active) return "This ticket is not available.";
  if (ticket.sale_starts_at && new Date(ticket.sale_starts_at).getTime() > now) {
    return "Ticket sales have not opened yet.";
  }
  if (ticket.sale_ends_at && new Date(ticket.sale_ends_at).getTime() < now) {
    return "Ticket sales have ended.";
  }

  return null;
}

function activeTicketPrice(ticket: TicketTypeRow) {
  const regularPrice = Number(ticket.price ?? 0);
  const earlyBirdPrice =
    ticket.early_bird_price === null || ticket.early_bird_price === undefined
      ? null
      : Number(ticket.early_bird_price);
  const earlyBirdEndsAt = ticket.early_bird_ends_at
    ? new Date(ticket.early_bird_ends_at).getTime()
    : null;

  if (
    ticket.early_bird_enabled &&
    earlyBirdPrice !== null &&
    Number.isFinite(earlyBirdPrice) &&
    earlyBirdPrice >= 0 &&
    earlyBirdEndsAt !== null &&
    earlyBirdEndsAt >= Date.now()
  ) {
    return earlyBirdPrice;
  }

  return regularPrice;
}

function appBaseUrl(request: NextRequest) {
  return (
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.NEXT_PUBLIC_SITE_URL ||
    request.nextUrl.origin
  ).replace(/\/$/, "");
}

function safeMobileReturnUrl(value: string | undefined, fallback: string) {
  const trimmed = value?.trim();
  if (!trimmed) return fallback;
  if (trimmed.startsWith("danceflow://")) return trimmed;
  return fallback;
}

function calculateApplicationFeeAmount(amount: number, feePercent: number) {
  return Math.round(Math.max(0, Math.round(amount * 100)) * Math.max(0, feePercent));
}

function getStripePublishableKey() {
  return (
    process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ||
    process.env.STRIPE_PUBLISHABLE_KEY ||
    ""
  ).trim();
}

async function getOrganizerPlatformFeePercent(supabase: SupabaseClient, studioId: string) {
  const { data: subscription, error } = await supabase
    .from("studio_subscriptions")
    .select("status, subscription_plans ( code )")
    .eq("studio_id", studioId)
    .maybeSingle();

  if (error || !subscription || !["active", "trialing"].includes(subscription.status ?? "")) {
    return 0;
  }

  const rawPlan = subscription.subscription_plans as { code: string | null } | { code: string | null }[] | null;
  const plan = pickOne(rawPlan);
  const planCode = (plan?.code ?? "").trim().toLowerCase();

  if (planCode === "organizer") return 0.035;

  if (!["starter", "growth", "pro"].includes(planCode)) return 0;

  const { data: addOns } = await supabase
    .from("usage_addon_entitlements")
    .select("id")
    .eq("studio_id", studioId)
    .eq("feature_key", "organizer_suite")
    .in("source", ["stripe_subscription_item", "manual_grant"])
    .eq("status", "active")
    .limit(1);

  if (!addOns?.length) return 0;
  return planCode === "pro" ? 0.03 : 0.0325;
}

async function loadActiveTicketHoldCounts(
  supabase: SupabaseClient,
  ticketTypeIds: string[]
) {
  if (!ticketTypeIds.length) return new Map<string, number>();

  const { data, error } = await supabase
    .from("event_registrations")
    .select(
      `
      ticket_type_id,
      quantity,
      status,
      payment_status,
      event_ticket_types (
        attendees_per_ticket
      ),
      event_orders!inner (
        status,
        payment_status,
        expires_at
      )
    `
    )
    .in("ticket_type_id", ticketTypeIds)
    .eq("status", "pending")
    .eq("payment_status", "pending")
    .eq("event_orders.status", "pending")
    .eq("event_orders.payment_status", "pending")
    .gt("event_orders.expires_at", new Date().toISOString());

  if (error) throw new Error(error.message);

  const counts = new Map<string, number>();
  for (const row of (data ?? []) as TicketHoldCountRow[]) {
    if (!row.ticket_type_id) continue;
    const ticketType = pickOne(row.event_ticket_types);
    const admitsPerTicket = Math.max(1, Number(ticketType?.attendees_per_ticket ?? 1) || 1);
    counts.set(
      row.ticket_type_id,
      (counts.get(row.ticket_type_id) ?? 0) + Math.max(1, Number(row.quantity ?? 1) || 1) * admitsPerTicket
    );
  }

  return counts;
}

async function loadConfirmedTicketCounts(
  supabase: SupabaseClient,
  ticketTypeIds: string[]
) {
  if (!ticketTypeIds.length) return new Map<string, number>();

  const { data, error } = await supabase
    .from("event_registrations")
    .select("ticket_type_id, quantity, event_ticket_types ( attendees_per_ticket )")
    .in("ticket_type_id", ticketTypeIds)
    .or("payment_status.eq.paid,status.in.(confirmed,checked_in,attended)");

  if (error) throw new Error(error.message);

  const counts = new Map<string, number>();
  for (const row of (data ?? []) as TicketHoldCountRow[]) {
    if (!row.ticket_type_id) continue;
    const ticketType = pickOne(row.event_ticket_types);
    const admitsPerTicket = Math.max(1, Number(ticketType?.attendees_per_ticket ?? 1) || 1);
    counts.set(
      row.ticket_type_id,
      (counts.get(row.ticket_type_id) ?? 0) + Math.max(1, Number(row.quantity ?? 1) || 1) * admitsPerTicket
    );
  }

  return counts;
}

async function assertTicketCapacityAvailable(params: {
  supabase: SupabaseClient;
  selections: TicketSelectionInput[];
  ticketsById: Map<string, TicketTypeRow>;
}) {
  const ticketTypeIds = Array.from(params.ticketsById.keys());
  const [confirmedCounts, holdCounts] = await Promise.all([
    loadConfirmedTicketCounts(params.supabase, ticketTypeIds),
    loadActiveTicketHoldCounts(params.supabase, ticketTypeIds),
  ]);

  for (const selection of params.selections) {
    const ticket = params.ticketsById.get(selection.ticketTypeId);
    if (!ticket || ticket.capacity == null) continue;

    const capacity = Number(ticket.capacity);
    const reserved =
      (confirmedCounts.get(ticket.id) ?? 0) + (holdCounts.get(ticket.id) ?? 0);
    const remaining = Math.max(0, capacity - reserved);
    const admitsPerTicket = Math.max(1, Number(ticket.attendees_per_ticket ?? 1) || 1);
    const requestedTickets = Math.max(1, Number(selection.quantity ?? 1) || 1);
    const requested = requestedTickets * admitsPerTicket;

    if (requested > remaining) {
      throw new Error(
        remaining > 0
          ? `Only ${remaining} admission spot${remaining === 1 ? "" : "s"} remain for ${ticket.name}.`
          : `${ticket.name} is sold out.`
      );
    }
  }
}

export async function POST(request: NextRequest, { params }: Params) {
  const rateLimit = checkRateLimit(
    rateLimitKey("checkout:student-event", getIpFromRequest(request)),
    { limit: 8, windowMs: 15 * 60 * 1000 },
  );

  if (!rateLimit.allowed) {
    return rateLimitedJson(rateLimit);
  }

  const { eventId } = await params;
  const normalizedEventId = normalizeStudentApiUuid(eventId);
  if (!normalizedEventId) {
    return jsonError("This event is not available.", 404);
  }

  const supabase = getSupabaseAdmin();
  const stripe = getStripe();
  const user = await getStudentApiUser(request);
  const body = (await request.json().catch(() => null)) as CheckoutBody | null;

  if (!body || typeof body !== "object") {
    return jsonError("Invalid checkout request.");
  }

  if (!user?.email) {
    return jsonError("Sign in before registering for events.", 401);
  }

  const selectionsResult = normalizeTicketSelections(body.ticketSelections);
  const buyerFirstNameResult = getJsonText(body.buyerFirstName, "First name", 80);
  const buyerLastNameResult = getJsonText(body.buyerLastName, "Last name", 80);
  const buyerPhoneResult = normalizeOptionalPhone(
    typeof body.buyerPhone === "string" ? body.buyerPhone : "",
    "Phone"
  );
  const notesResult = getJsonTextarea(body.notes, "Notes", 2000);
  const additionalAttendeeNamesResult = getJsonStringArray(
    body.additionalAttendeeNames,
    "Additional attendee names",
    120,
    100
  );
  const documentRequirementIdsResult = normalizeTextList(
    Array.isArray(body.documentRequirementIds)
      ? body.documentRequirementIds.map((item) => (typeof item === "string" ? item : ""))
      : [],
    { fieldLabel: "Document requirements", maxItemLength: 36, maxItems: 25 }
  );
  const documentSignatureNameResult = getJsonText(
    body.documentSignatureName,
    "Signature name",
    120
  );

  const validationError = getValidationError([
    selectionsResult,
    buyerFirstNameResult,
    buyerLastNameResult,
    buyerPhoneResult,
    notesResult,
    additionalAttendeeNamesResult,
    documentRequirementIdsResult,
    documentSignatureNameResult,
  ]);

  if (validationError) {
    return jsonError(validationError);
  }

  const selections = getValidatedValue(selectionsResult);

  if (!selections.length) {
    return jsonError("Select at least one ticket.");
  }

  const buyerFirstName = getValidatedValue(buyerFirstNameResult);
  const buyerLastName = getValidatedValue(buyerLastNameResult);
  const buyerPhone = getValidatedValue(buyerPhoneResult);
  const buyerNotes = getValidatedValue(notesResult);
  const submittedDocumentRequirementIds = getValidatedValue(documentRequirementIdsResult);
  const documentSignatureName = getValidatedValue(documentSignatureNameResult);
  const buyerName = [buyerFirstName, buyerLastName].filter(Boolean).join(" ").trim();

  if (!buyerName) {
    return jsonError("Enter the buyer name.");
  }

  const buyerEmail = user.email.toLowerCase();
  const signerIpAddress = requestIpAddress(request);
  const signerUserAgent = request.headers.get("user-agent") || null;
  const signerDeviceMetadata = requestDeviceMetadata(request);

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
        subscription_status,
        stripe_connected_account_id,
        stripe_connect_charges_enabled,
        stripe_connect_payouts_enabled,
        stripe_connect_onboarding_complete
      )
    `
    )
    .eq("id", normalizedEventId)
    .maybeSingle<CartEventRow>();

  const studio = pickOne(event?.studios);
  const eventIsPublic =
    event?.status === "published" &&
    (event.visibility === "public" ||
      event.visibility === "unlisted" ||
      event.public_directory_enabled === true);
  const studioHasAccess = ["active", "trialing"].includes(studio?.subscription_status ?? "");

  if (eventError || !event || !eventIsPublic || !studioHasAccess) {
    return jsonError("This event is not available.", 404);
  }

  const registrationWindowError = validateRegistrationWindow(event);
  if (registrationWindowError) return jsonError(registrationWindowError);

  if (
    !studio?.stripe_connected_account_id ||
    !studio.stripe_connect_onboarding_complete ||
    !studio.stripe_connect_payouts_enabled ||
    !studio.stripe_connect_charges_enabled
  ) {
    return jsonError("Online ticket checkout is not ready for this event.");
  }

  const organizerPlatformFeePercent = await getOrganizerPlatformFeePercent(supabase, event.studio_id);
  if (organizerPlatformFeePercent <= 0) {
    return jsonError("DanceFlow event checkout is not enabled for this listing.");
  }

  const { data: requiredDocuments, error: documentError } = await supabase
    .from("event_document_requirements")
    .select("id, template_id, template_version_id, document_templates:template_id ( body )")
    .eq("event_id", event.id)
    .eq("active", true)
    .eq("is_required", true);

  if (documentError) {
    return jsonError("Required documents could not be loaded.");
  }

  const requiredDocumentRows = (requiredDocuments ?? []) as EventDocumentRequirementRow[];
  if (requiredDocumentRows.length > 0) {
    const submittedIds = new Set(submittedDocumentRequirementIds);
    const allSubmitted = requiredDocumentRows.every((document) => submittedIds.has(document.id));

    if (!allSubmitted || !body.documentConsentAccepted || documentSignatureName.length < 2) {
      return jsonError("Review and sign the required event documents before checkout.");
    }
  }

  const requestedTicketIds = selections.map((selection) => selection.ticketTypeId);
  const { data: tickets, error: ticketsError } = await supabase
    .from("event_ticket_types")
    .select("id, event_id, name, price, currency, capacity, active, sale_starts_at, sale_ends_at, early_bird_enabled, early_bird_price, early_bird_ends_at, attendees_per_ticket")
    .eq("event_id", event.id)
    .in("id", requestedTicketIds);

  if (ticketsError || !tickets || tickets.length !== requestedTicketIds.length) {
    return jsonError("One or more selected tickets are not available.");
  }

  const ticketsById = new Map((tickets as TicketTypeRow[]).map((ticket) => [ticket.id, ticket]));

  try {
    await assertTicketCapacityAvailable({
      supabase,
      selections,
      ticketsById,
    });
  } catch (error) {
    return jsonError(
      error instanceof Error
        ? error.message
        : "Selected ticket quantity is no longer available."
    );
  }

  const additionalAttendeeNames = getValidatedValue(additionalAttendeeNamesResult);
  let additionalAttendeeCursor = 0;
  let totalAmount = 0;
  let currency = "USD";
  const holdUntil = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  const orderHoldToken = randomUUID();
  const registrationIds: string[] = [];
  const orderItems: Record<string, unknown>[] = [];

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
    return jsonError("A previous checkout attempt could not be cleared.");
  }

  const { data: order, error: orderError } = await supabase
    .from("event_orders")
    .insert({
      event_id: event.id,
      studio_id: event.studio_id,
      organizer_id: event.organizer_id,
      buyer_name: buyerName,
      buyer_email: buyerEmail,
      buyer_phone: buyerPhone,
      buyer_notes: buyerNotes || null,
      subtotal_amount: 0,
      total_amount: 0,
      currency,
      status: "pending",
      payment_status: "pending",
      expires_at: holdUntil,
      metadata: {
        source: "student_app_event_tickets_v1",
        user_id: user.id,
        hold_token: orderHoldToken,
      },
    })
    .select("id")
    .single();

  if (orderError || !order) {
    return jsonError("Could not create the event checkout order.");
  }

  try {
    for (const selection of selections) {
      const ticket = ticketsById.get(selection.ticketTypeId);
      if (!ticket) throw new Error("Ticket unavailable.");

      const ticketWindowError = validateTicketWindow(ticket);
      if (ticketWindowError) throw new Error(ticketWindowError);

      const quantity = Math.max(1, selection.quantity);
      if (ticket.capacity != null && quantity > Number(ticket.capacity)) {
        throw new Error("Selected ticket quantity is no longer available.");
      }

      const attendeesPerTicket = Math.max(1, Number(ticket.attendees_per_ticket ?? 1) || 1);
      const expectedAttendeeCount = quantity * attendeesPerTicket;
      const additionalCount = Math.max(0, expectedAttendeeCount - 1);
      const additionalForTicket = additionalAttendeeNames.slice(
        additionalAttendeeCursor,
        additionalAttendeeCursor + additionalCount
      );

      if (additionalForTicket.length < additionalCount) {
        throw new Error("Add all additional attendee names before checkout.");
      }

      additionalAttendeeCursor += additionalCount;
      const unitPrice = activeTicketPrice(ticket);
      const ticketTotal = Number((unitPrice * quantity).toFixed(2));
      currency = ticket.currency || currency;
      totalAmount = Number((totalAmount + ticketTotal).toFixed(2));

      const { data: registration, error: registrationError } = await supabase
        .from("event_registrations")
        .insert({
          studio_id: event.studio_id,
          event_id: event.id,
          ticket_type_id: ticket.id,
          user_id: user.id,
          order_id: order.id,
          status: "pending",
          attendee_first_name: buyerFirstName || splitFullName(buyerName).firstName,
          attendee_last_name: buyerLastName || splitFullName(buyerName).lastName,
          attendee_email: buyerEmail,
          attendee_phone: buyerPhone,
          quantity,
          unit_price: unitPrice,
          total_price: ticketTotal,
          total_amount: ticketTotal,
          currency,
          payment_status: "pending",
          registration_source: "public_event_page",
          source: "public_event_page",
          notes: buyerNotes || null,
        })
        .select("id")
        .single();

      if (registrationError || !registration) {
        throw new Error(registrationError?.message ?? "Registration could not be created.");
      }

      registrationIds.push(registration.id);

      const { error: registrationItemError } = await supabase
        .from("event_registration_items")
        .insert({
          registration_id: registration.id,
          ticket_type_id: ticket.id,
          ticket_name_snapshot: ticket.name,
          quantity,
          unit_price: unitPrice,
          line_total: ticketTotal,
        });

      if (registrationItemError) throw new Error(registrationItemError.message);

      const attendeeNames = [buyerName, ...additionalForTicket];
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
          ticket_type_id: ticket.id,
          first_name: parsed.firstName || "Guest",
          last_name: parsed.lastName || `${index + 1}`,
          email: index === 0 ? buyerEmail : null,
          phone: index === 0 ? buyerPhone : null,
          attendee_role: "attendee",
          sort_order: index + 1,
        };
      });

      const { error: attendeeError } = await supabase.from("event_registration_attendees").insert(attendeeRows);
      if (attendeeError) throw new Error(attendeeError.message);

      for (const requiredDocument of requiredDocumentRows) {
        const template = pickOne(requiredDocument.document_templates);
        if (!template) continue;
        const signedAt = new Date().toISOString();

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
            signer_user_id: user.id,
            signed_at: signedAt,
            completed_at: signedAt,
          })
          .select("id")
          .single();

        if (assignmentError || !assignment) {
          throw new Error(assignmentError?.message ?? "Could not save event document signature.");
        }

        const consentText =
          "I have reviewed the required event document(s), agree to sign electronically, and confirm that my typed name is my signature.";

        const { data: signature, error: signatureError } = await supabase
          .from("document_signatures")
          .insert({
            assignment_id: assignment.id,
            template_id: requiredDocument.template_id,
            template_version_id: requiredDocument.template_version_id,
            studio_id: event.studio_id,
            organizer_id: event.organizer_id,
            event_id: event.id,
            event_registration_id: registration.id,
            signer_user_id: user.id,
            signer_name: documentSignatureName,
            signer_email: buyerEmail,
            signed_at: signedAt,
            signed_body: template.body,
            signature_method: "typed",
            signature_text: documentSignatureName,
            consent_text: consentText,
            ip_address: signerIpAddress,
            user_agent: signerUserAgent,
            device_metadata: signerDeviceMetadata,
            metadata: {
              source: "student_app_event_checkout",
              order_id: order.id,
              registration_id: registration.id,
            },
          })
          .select("id")
          .single();

        if (signatureError || !signature) {
          throw new Error(signatureError?.message ?? "Could not save document signature.");
        }

        const { error: auditError } = await supabase.from("document_signature_audit_events").insert({
          signature_id: signature.id,
          assignment_id: assignment.id,
          template_id: requiredDocument.template_id,
          template_version_id: requiredDocument.template_version_id,
          studio_id: event.studio_id,
          organizer_id: event.organizer_id,
          event_id: event.id,
          event_registration_id: registration.id,
          actor_user_id: user.id,
          actor_email: buyerEmail,
          event_type: "signed",
          event_summary: "Student signed required event document during mobile checkout.",
          ip_address: signerIpAddress,
          user_agent: signerUserAgent,
          metadata: {
            consent_text: consentText,
            signature_method: "typed",
            source: "student_app_event_checkout",
            order_id: order.id,
          },
        });

        if (auditError) throw new Error(auditError.message);
      }

      orderItems.push({
        order_id: order.id,
        event_id: event.id,
        item_type: "ticket",
        reference_id: ticket.id,
        ticket_type_id: ticket.id,
        description: `${event.name} - ${ticket.name}`,
        quantity,
        unit_price: unitPrice,
        total_price: ticketTotal,
        currency,
        attendee_names: attendeeNames,
        metadata: {
          registration_id: registration.id,
          attendees_per_ticket: ticket.attendees_per_ticket ?? 1,
        },
      });
    }

    const { error: orderItemsError } = await supabase.from("event_order_items").insert(orderItems);
    if (orderItemsError) throw new Error(orderItemsError.message);

    const { error: orderAmountError } = await supabase
      .from("event_orders")
      .update({
        subtotal_amount: totalAmount,
        total_amount: totalAmount,
        currency,
        updated_at: new Date().toISOString(),
      })
      .eq("id", order.id);

    if (orderAmountError) throw new Error(orderAmountError.message);

    if (totalAmount <= 0) {
      const now = new Date().toISOString();

      await supabase
        .from("event_orders")
        .update({
          status: "confirmed",
          payment_status: "paid",
          paid_at: now,
          updated_at: now,
        })
        .eq("id", order.id);

      await supabase
        .from("event_registrations")
        .update({
          status: "confirmed",
          payment_status: "paid",
        })
        .in("id", registrationIds);

      try {
        await sendMobilePushToUser({
          userId: user.id,
          category: "event",
          title: "Registration confirmed",
          body: `Your registration for ${event.name} is confirmed.`,
          data: {
            source: "student_event_free_order_confirmed",
            orderId: order.id,
            eventId: event.id,
            eventSlug: event.slug,
            registrationIds,
          },
        });
      } catch (pushError) {
        console.error(
          "Failed to send free event confirmation mobile push",
          pushError instanceof Error ? pushError.message : pushError
        );
      }

      return NextResponse.json({
        completed: true,
        orderId: order.id,
        registrationIds,
      });
    }

    const applicationFeeAmount = calculateApplicationFeeAmount(totalAmount, organizerPlatformFeePercent);
    const connectedAccountId = studio.stripe_connected_account_id;
    const baseUrl = appBaseUrl(request);
    const successUrl = `${baseUrl}/events/${encodeURIComponent(event.slug)}?success=cart_paid&order=${encodeURIComponent(order.id)}`;
    const orderReturnUrl = `danceflow://events/orders/${encodeURIComponent(order.id)}?checkout=event`;
    const mobileReturn = safeMobileReturnUrl(
      body.returnUrl,
      orderReturnUrl
    );
    const stripeSuccessUrl = mobileReturn.startsWith("danceflow://events/orders/") && !mobileReturn.includes("/pending")
      ? mobileReturn
      : orderReturnUrl;
    const checkoutSuccessUrl = stripeSuccessUrl.startsWith("danceflow://")
      ? stripeSuccessUrl
      : successUrl;
    const releaseUrl = `${baseUrl}/api/events/cart/release?orderId=${encodeURIComponent(order.id)}&eventSlug=${encodeURIComponent(event.slug)}&holdToken=${encodeURIComponent(orderHoldToken)}`;

    if (body.paymentMode === "payment_sheet") {
      const paymentIntent = await stripe.paymentIntents.create({
        amount: Math.round(totalAmount * 100),
        currency: currency.toLowerCase(),
        receipt_email: buyerEmail,
        automatic_payment_methods: {
          enabled: true,
        },
        ...(applicationFeeAmount > 0 ? { application_fee_amount: applicationFeeAmount } : {}),
        transfer_data: {
          destination: connectedAccountId,
        },
        metadata: {
          source: "event_cart_order",
          studio_id: event.studio_id,
          event_id: event.id,
          event_slug: event.slug,
          order_id: order.id,
          registration_id: registrationIds[0] ?? "",
          registration_ids: registrationIds.join(","),
          buyer_email: buyerEmail,
          connected_account_id: connectedAccountId,
          client_surface: "student_app",
          mobile_return_url: checkoutSuccessUrl,
        },
      });

      if (!paymentIntent.client_secret) {
        throw new Error("Stripe did not return a native payment secret.");
      }

      const { error: paymentIntentLinkError } = await supabase
        .from("event_orders")
        .update({
          stripe_payment_intent_id: paymentIntent.id,
          updated_at: new Date().toISOString(),
        })
        .eq("id", order.id);

      if (paymentIntentLinkError) throw new Error(paymentIntentLinkError.message);

      await supabase
        .from("event_registrations")
        .update({ stripe_payment_intent_id: paymentIntent.id })
        .in("id", registrationIds);

      return NextResponse.json({
        clientSecret: paymentIntent.client_secret,
        orderId: order.id,
        publishableKey: getStripePublishableKey(),
        registrationIds,
      });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer_email: buyerEmail,
      success_url: checkoutSuccessUrl,
      cancel_url: releaseUrl,
      line_items: orderItems.map((item) => ({
        quantity: Number(item.quantity ?? 1),
        price_data: {
          currency: currency.toLowerCase(),
          unit_amount: Math.round(Number(item.unit_price ?? 0) * 100),
          product_data: {
            name: String(item.description ?? "Event ticket"),
          },
        },
      })),
      payment_intent_data: {
        ...(applicationFeeAmount > 0 ? { application_fee_amount: applicationFeeAmount } : {}),
        transfer_data: {
          destination: connectedAccountId,
        },
        metadata: {
          source: "event_cart_order",
          studio_id: event.studio_id,
          event_id: event.id,
          event_slug: event.slug,
          order_id: order.id,
          registration_id: registrationIds[0] ?? "",
          registration_ids: registrationIds.join(","),
          buyer_email: buyerEmail,
          connected_account_id: connectedAccountId,
          mobile_return_url: checkoutSuccessUrl,
        },
      },
      metadata: {
        source: "event_cart_order",
        studio_id: event.studio_id,
        event_id: event.id,
        event_slug: event.slug,
        order_id: order.id,
        registration_id: registrationIds[0] ?? "",
        registration_ids: registrationIds.join(","),
        buyer_email: buyerEmail,
        connected_account_id: connectedAccountId,
        client_surface: "student_app",
        mobile_return_url: checkoutSuccessUrl,
      },
    });

    const { error: sessionLinkError } = await supabase
      .from("event_orders")
      .update({
        stripe_checkout_session_id: session.id,
        updated_at: new Date().toISOString(),
      })
      .eq("id", order.id);

    if (sessionLinkError) throw new Error(sessionLinkError.message);

    await supabase
      .from("event_registrations")
      .update({ stripe_checkout_session_id: session.id })
      .in("id", registrationIds);

    if (!session.url) throw new Error("Stripe did not return a checkout URL.");

    return NextResponse.json({
      checkoutUrl: session.url,
      orderId: order.id,
      registrationIds,
    });
  } catch (error) {
    console.error(
      "Student event checkout failed",
      error instanceof Error ? error.message : error,
    );

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

    return jsonError("Checkout could not be started. Please try again.");
  }
}
