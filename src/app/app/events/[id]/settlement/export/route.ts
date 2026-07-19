import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { canExportOrganizerFinancials } from "@/lib/auth/permissions";

type EventRow = {
  id: string;
  studio_id: string;
  organizer_id: string | null;
  name: string | null;
  slug: string | null;
  status: string | null;
  event_type: string | null;
  start_date: string | null;
};

type EventProfitLossRow = {
  gross_ticket_revenue: number | string | null;
  refunds: number | string | null;
  processing_and_platform_fees: number | string | null;
  net_ticket_revenue: number | string | null;
  event_expenses: number | string | null;
  event_labor_costs: number | string | null;
  total_event_costs: number | string | null;
  event_profit_loss: number | string | null;
};

type RegistrationRow = {
  id: string;
  payment_status: string | null;
  status: string | null;
  quantity: number | string | null;
  checked_in_at: string | null;
};

type AttendeeRow = {
  id: string;
  checked_in_at: string | null;
};

type SettlementRow = {
  status: string | null;
  notes: string | null;
  gross_ticket_revenue: number | string | null;
  refunds: number | string | null;
  processing_and_platform_fees: number | string | null;
  net_ticket_revenue: number | string | null;
  event_expenses: number | string | null;
  event_labor_costs: number | string | null;
  total_event_costs: number | string | null;
  event_profit_loss: number | string | null;
  margin: number | string | null;
  paid_registrations: number | string | null;
  tickets_issued: number | string | null;
  tickets_checked_in: number | string | null;
  unpaid_registrations: number | string | null;
  pending_registrations: number | string | null;
  refunded_registrations: number | string | null;
  settled_at: string | null;
  settled_by: string | null;
  updated_at: string | null;
};

function csvEscape(value: unknown) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  if (/[",\n\r]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

function toCsv(headers: string[], rows: Array<Array<unknown>>) {
  return [headers, ...rows]
    .map((row) => row.map(csvEscape).join(","))
    .join("\n");
}

function csvResponse(csv: string, filename: string) {
  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}

function safeNumber(value: number | string | null | undefined) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function formatMoney(value: number) {
  return value.toFixed(2);
}

function formatPercentDecimal(value: number | null) {
  if (value === null || !Number.isFinite(value)) return "";
  return (value * 100).toFixed(2);
}

function slugifyFilename(value: string) {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return slug || "event";
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const context = await getCurrentStudioContext();

  if (!context?.studioId) {
    return new NextResponse("No active workspace was found.", { status: 401 });
  }

  const { data: event, error: eventError } = await supabase
    .from("events")
    .select("id, studio_id, organizer_id, name, slug, status, event_type, start_date")
    .eq("id", id)
    .eq("studio_id", context.studioId)
    .maybeSingle();

  if (eventError) {
    return new NextResponse(`Failed to load event: ${eventError.message}`, { status: 500 });
  }

  if (!event) {
    return new NextResponse("Event not found", { status: 404 });
  }

  const typedEvent = event as EventRow;
  const isStudioHosted = !typedEvent.organizer_id;
  let organizerUserRole: string | null = null;

  if (typedEvent.organizer_id) {
    const { data: organizerUser, error: organizerUserError } = await supabase
      .from("organizer_users")
      .select("role")
      .eq("organizer_id", typedEvent.organizer_id)
      .eq("user_id", user.id)
      .eq("active", true)
      .maybeSingle();

    if (organizerUserError) {
      return new NextResponse(`Could not verify organizer role: ${organizerUserError.message}`, {
        status: 500,
      });
    }

    organizerUserRole = organizerUser?.role ?? null;
  }

  const effectiveRole = isStudioHosted
    ? context.studioRole ?? null
    : organizerUserRole;
  const canExport = canExportOrganizerFinancials(
    effectiveRole,
    Boolean(context.isPlatformAdmin),
  );

  if (!canExport) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  const [profitabilityResult, registrationsResult, attendeesResult, settlementResult] = await Promise.all([
    (supabase as any)
      .from("v_event_profit_loss")
      .select("gross_ticket_revenue, refunds, processing_and_platform_fees, net_ticket_revenue, event_expenses, event_labor_costs, total_event_costs, event_profit_loss")
      .eq("event_id", typedEvent.id)
      .maybeSingle(),
    supabase
      .from("event_registrations")
      .select("id, payment_status, status, quantity, checked_in_at")
      .eq("event_id", typedEvent.id)
      .limit(10000),
    supabase
      .from("event_registration_attendees")
      .select("id, checked_in_at")
      .eq("event_id", typedEvent.id)
      .limit(10000),
    (supabase as any)
      .from("event_settlements")
      .select("status, notes, gross_ticket_revenue, refunds, processing_and_platform_fees, net_ticket_revenue, event_expenses, event_labor_costs, total_event_costs, event_profit_loss, margin, paid_registrations, tickets_issued, tickets_checked_in, unpaid_registrations, pending_registrations, refunded_registrations, settled_at, settled_by, updated_at")
      .eq("event_id", typedEvent.id)
      .maybeSingle(),
  ]);

  if (profitabilityResult.error) {
    return new NextResponse(`Failed to load profitability: ${profitabilityResult.error.message}`, {
      status: 500,
    });
  }

  if (registrationsResult.error) {
    return new NextResponse(`Failed to load registrations: ${registrationsResult.error.message}`, {
      status: 500,
    });
  }

  if (settlementResult.error) {
    return new NextResponse(`Failed to load settlement: ${settlementResult.error.message}`, {
      status: 500,
    });
  }

  const profitability = profitabilityResult.data as EventProfitLossRow | null;
  const settlement = settlementResult.data as SettlementRow | null;
  const registrations = (registrationsResult.data ?? []) as RegistrationRow[];
  const attendees = attendeesResult.error ? [] : ((attendeesResult.data ?? []) as AttendeeRow[]);

  const grossTicketRevenue = safeNumber(profitability?.gross_ticket_revenue);
  const refunds = safeNumber(profitability?.refunds);
  const processingAndPlatformFees = safeNumber(profitability?.processing_and_platform_fees);
  const netTicketRevenue = safeNumber(profitability?.net_ticket_revenue);
  const eventExpenses = safeNumber(profitability?.event_expenses);
  const eventLaborCosts = safeNumber(profitability?.event_labor_costs);
  const totalEventCosts = safeNumber(profitability?.total_event_costs) || eventExpenses + eventLaborCosts;
  const eventProfitLoss = safeNumber(profitability?.event_profit_loss);
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
  const checkInRate = ticketsIssued > 0 ? ticketsCheckedIn / ticketsIssued : null;

  const rows: Array<Array<unknown>> = [
    ["Event", "Event ID", typedEvent.id],
    ["Event", "Event Name", typedEvent.name ?? "Untitled event"],
    ["Event", "Event Type", typedEvent.event_type ?? "event"],
    ["Event", "Event Date", typedEvent.start_date ?? ""],
    ["Event", "Event Status", typedEvent.status ?? ""],
    ["Settlement", "Settlement Status", settlement?.status ?? "open"],
    ["Settlement", "Settlement Notes", settlement?.notes ?? ""],
    ["Settlement", "Settled At", settlement?.settled_at ?? ""],
    ["Settlement", "Settled By", settlement?.settled_by ?? ""],
    ["Settlement", "Last Updated", settlement?.updated_at ?? ""],
    ["Revenue", "Gross Ticket Revenue", formatMoney(grossTicketRevenue)],
    ["Revenue", "Refunds", formatMoney(refunds)],
    ["Revenue", "Processing and Platform Fees", formatMoney(processingAndPlatformFees)],
    ["Revenue", "Net Ticket Revenue", formatMoney(netTicketRevenue)],
    ["Costs", "Event Expenses", formatMoney(eventExpenses)],
    ["Costs", "Labor / Staff Costs", formatMoney(eventLaborCosts)],
    ["Costs", "Total Event Costs", formatMoney(totalEventCosts)],
    ["Profit", "Final Profit / Loss", formatMoney(eventProfitLoss)],
    ["Profit", "Margin %", formatPercentDecimal(margin)],
    ["Registrations", "Paid Registrations", settlement?.paid_registrations ?? paidRegistrations],
    ["Registrations", "Unpaid Registrations", settlement?.unpaid_registrations ?? unpaidRegistrations],
    ["Registrations", "Pending Registrations", settlement?.pending_registrations ?? pendingRegistrations],
    ["Registrations", "Refunded Registrations", settlement?.refunded_registrations ?? refundedRegistrations],
    ["Tickets", "Tickets Issued", settlement?.tickets_issued ?? ticketsIssued],
    ["Tickets", "Tickets Checked In", settlement?.tickets_checked_in ?? ticketsCheckedIn],
    ["Tickets", "Check-In Rate %", formatPercentDecimal(checkInRate)],
  ];

  if (settlement) {
    rows.push(
      ["Saved Snapshot", "Gross Ticket Revenue", formatMoney(safeNumber(settlement.gross_ticket_revenue))],
      ["Saved Snapshot", "Refunds", formatMoney(safeNumber(settlement.refunds))],
      ["Saved Snapshot", "Processing and Platform Fees", formatMoney(safeNumber(settlement.processing_and_platform_fees))],
      ["Saved Snapshot", "Net Ticket Revenue", formatMoney(safeNumber(settlement.net_ticket_revenue))],
      ["Saved Snapshot", "Event Expenses", formatMoney(safeNumber(settlement.event_expenses))],
      ["Saved Snapshot", "Labor / Staff Costs", formatMoney(safeNumber(settlement.event_labor_costs))],
      ["Saved Snapshot", "Total Event Costs", formatMoney(safeNumber(settlement.total_event_costs))],
      ["Saved Snapshot", "Final Profit / Loss", formatMoney(safeNumber(settlement.event_profit_loss))],
      ["Saved Snapshot", "Margin %", formatPercentDecimal(safeNumber(settlement.margin))],
    );
  }

  const csv = toCsv(["Section", "Metric", "Value"], rows);
  const filename = `danceflow-event-settlement-${slugifyFilename(typedEvent.name ?? typedEvent.slug ?? typedEvent.id)}.csv`;

  return csvResponse(csv, filename);
}
