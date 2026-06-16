"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { requireEventWorkspaceFeature } from "@/lib/billing/access";

const allowedStatuses = new Set(["open", "ready_to_settle", "settled", "reopened"]);

function cleanText(value: FormDataEntryValue | null) {
  return String(value ?? "").trim();
}

function cleanOptionalText(value: FormDataEntryValue | null) {
  const cleaned = cleanText(value);
  return cleaned.length > 0 ? cleaned : null;
}

function toNumber(value: number | string | null | undefined) {
  const amount = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(amount) ? amount : 0;
}

function canManageEventSettlement(params: {
  isPlatformAdmin: boolean;
  organizerUserRole: string | null;
  studioRole: string | null;
  isStudioHosted: boolean;
}) {
  const { isPlatformAdmin, organizerUserRole, studioRole, isStudioHosted } = params;

  if (isPlatformAdmin) return true;

  if (["organizer_owner", "organizer_admin", "organizer_staff"].includes(organizerUserRole ?? "")) {
    return true;
  }

  if (isStudioHosted && ["studio_owner", "studio_admin"].includes(studioRole ?? "")) {
    return true;
  }

  return false;
}

export async function updateEventSettlementAction(formData: FormData) {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    throw new Error("You must be signed in to update event settlement.");
  }

  const context = await getCurrentStudioContext();

  if (!context?.studioId) {
    throw new Error("No active workspace was found.");
  }

  const eventId = cleanText(formData.get("event_id"));
  const rawStatus = cleanText(formData.get("status")) || "open";
  const status = allowedStatuses.has(rawStatus) ? rawStatus : "open";
  const notes = cleanOptionalText(formData.get("notes"));

  if (!eventId) {
    throw new Error("Event ID is required.");
  }

  await requireEventWorkspaceFeature({
    eventId,
    feature: "organizer_tools",
    allowedOrganizerRoles: [
      "organizer_owner",
      "organizer_admin",
      "organizer_staff",
    ],
  });

  const { data: event, error: eventError } = await supabase
    .from("events")
    .select("id, studio_id, organizer_id")
    .eq("id", eventId)
    .eq("studio_id", context.studioId)
    .maybeSingle();

  if (eventError) {
    throw new Error(`Could not verify event: ${eventError.message}`);
  }

  if (!event) {
    throw new Error("Event was not found in this workspace.");
  }

  let organizerUserRole: string | null = null;

  if (event.organizer_id) {
    const { data: organizerUser, error: organizerUserError } = await supabase
      .from("organizer_users")
      .select("role")
      .eq("organizer_id", event.organizer_id)
      .eq("user_id", user.id)
      .eq("active", true)
      .maybeSingle();

    if (organizerUserError) {
      throw new Error(`Could not verify organizer role: ${organizerUserError.message}`);
    }

    organizerUserRole = organizerUser?.role ?? null;
  }

  const canManage = canManageEventSettlement({
    isPlatformAdmin: Boolean(context.isPlatformAdmin),
    organizerUserRole,
    studioRole: context.studioRole ?? null,
    isStudioHosted: !event.organizer_id,
  });

  if (!canManage) {
    throw new Error("You do not have permission to update event settlement.");
  }

  const { data: existingSettlement, error: existingSettlementError } = await (supabase as any)
    .from("event_settlements")
    .select("id, status")
    .eq("event_id", eventId)
    .maybeSingle();

  if (existingSettlementError) {
    throw new Error(`Could not verify current settlement status: ${existingSettlementError.message}`);
  }

  const existingStatus = String(existingSettlement?.status ?? "open").toLowerCase();

  if (existingStatus === "settled" && status !== "reopened") {
    throw new Error("This event has already been settled. Reopen the settlement before making closeout changes.");
  }

  if (existingStatus === "settled" && status === "reopened" && (!notes || notes.length < 8)) {
    throw new Error("A reopening reason is required before a settled event can be reopened.");
  }

  const [profitabilityResult, registrationsResult, attendeesResult] = await Promise.all([
    (supabase as any)
      .from("v_event_profit_loss")
      .select("gross_ticket_revenue, refunds, processing_and_platform_fees, net_ticket_revenue, event_expenses, event_labor_costs, total_event_costs, event_profit_loss")
      .eq("event_id", eventId)
      .maybeSingle(),
    supabase
      .from("event_registrations")
      .select("id, payment_status, status")
      .eq("event_id", eventId),
    supabase
      .from("event_registration_attendees")
      .select("id, checked_in_at")
      .eq("event_id", eventId),
  ]);

  if (profitabilityResult.error) {
    throw new Error(`Could not load event profitability: ${profitabilityResult.error.message}`);
  }

  if (registrationsResult.error) {
    throw new Error(`Could not load registrations: ${registrationsResult.error.message}`);
  }

  if (attendeesResult.error) {
    throw new Error(`Could not load attendee tickets: ${attendeesResult.error.message}`);
  }

  const profitability = profitabilityResult.data ?? {};
  const registrations = registrationsResult.data ?? [];
  const attendees = attendeesResult.data ?? [];

  const grossTicketRevenue = toNumber(profitability.gross_ticket_revenue);
  const refunds = toNumber(profitability.refunds);
  const processingAndPlatformFees = toNumber(profitability.processing_and_platform_fees);
  const netTicketRevenue = toNumber(profitability.net_ticket_revenue);
  const eventExpenses = toNumber(profitability.event_expenses);
  const eventLaborCosts = toNumber(profitability.event_labor_costs);
  const totalEventCosts = toNumber(profitability.total_event_costs) || eventExpenses + eventLaborCosts;
  const eventProfitLoss = toNumber(profitability.event_profit_loss);
  const margin = netTicketRevenue > 0 ? eventProfitLoss / netTicketRevenue : null;

  const paidRegistrations = registrations.filter((registration) =>
    ["paid", "partial", "comped", "free"].includes((registration.payment_status ?? "").toLowerCase()),
  ).length;
  const unpaidRegistrations = registrations.filter((registration) =>
    ["unpaid", "failed", "requires_payment"].includes((registration.payment_status ?? "").toLowerCase()),
  ).length;
  const pendingRegistrations = registrations.filter((registration) =>
    ["pending", "processing", "requires_action"].includes((registration.payment_status ?? "").toLowerCase()),
  ).length;
  const refundedRegistrations = registrations.filter((registration) => {
    const paymentStatus = (registration.payment_status ?? "").toLowerCase();
    const registrationStatus = (registration.status ?? "").toLowerCase();
    return paymentStatus.includes("refund") || registrationStatus.includes("refund");
  }).length;
  const ticketsIssued = attendees.length;
  const ticketsCheckedIn = attendees.filter((attendee) => attendee.checked_in_at).length;
  const nowIso = new Date().toISOString();

  const { error } = await (supabase as any)
    .from("event_settlements")
    .upsert(
      {
        studio_id: event.studio_id,
        organizer_id: event.organizer_id,
        event_id: event.id,
        status,
        notes,
        gross_ticket_revenue: grossTicketRevenue,
        refunds,
        processing_and_platform_fees: processingAndPlatformFees,
        net_ticket_revenue: netTicketRevenue,
        event_expenses: eventExpenses,
        event_labor_costs: eventLaborCosts,
        total_event_costs: totalEventCosts,
        event_profit_loss: eventProfitLoss,
        margin,
        paid_registrations: paidRegistrations,
        tickets_issued: ticketsIssued,
        tickets_checked_in: ticketsCheckedIn,
        unpaid_registrations: unpaidRegistrations,
        pending_registrations: pendingRegistrations,
        refunded_registrations: refundedRegistrations,
        settled_at: status === "settled" ? nowIso : null,
        settled_by: status === "settled" ? user.id : null,
        created_by: user.id,
        updated_by: user.id,
      },
      { onConflict: "event_id" },
    );

  if (error) {
    throw new Error(`Could not update event settlement: ${error.message}`);
  }

  revalidatePath(`/app/events/${eventId}`);
  revalidatePath("/app/events");
  revalidatePath("/app/reports");
}
