import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";

type EventRow = {
  id: string;
  name: string | null;
  event_type: string | null;
  start_date: string | null;
  status: string | null;
};

type EventProfitabilityRow = {
  event_id: string | null;
  gross_ticket_revenue: number | string | null;
  refunds: number | string | null;
  processing_and_platform_fees: number | string | null;
  net_ticket_revenue: number | string | null;
  event_expenses: number | string | null;
  event_labor_costs: number | string | null;
  total_event_costs: number | string | null;
  event_profit_loss: number | string | null;
};

type EventSettlementRow = {
  event_id: string | null;
  status: string | null;
  settled_at: string | null;
};

type EventRegistrationRow = {
  event_id: string;
  status: string | null;
  payment_status: string | null;
  quantity: number | null;
};

type EventTicketCheckInRow = {
  event_id: string | null;
  checked_in_at: string | null;
};

type EventSummaryRow = {
  event: EventRow;
  grossTicketRevenue: number;
  refunds: number;
  fees: number;
  netTicketRevenue: number;
  eventExpenses: number;
  eventLaborCosts: number;
  totalEventCosts: number;
  eventProfitLoss: number;
  marginPercent: number | null;
  registrations: number;
  paidRegistrations: number;
  unpaidRegistrations: number;
  pendingRegistrations: number;
  refundedRegistrations: number;
  ticketsIssued: number;
  ticketsCheckedIn: number;
  checkInRate: number | null;
  settlementStatus: string;
  settledAt: string | null;
  hasSettlementRecord: boolean;
  isCompletedOrPast: boolean;
};

function canViewOrganizerEventExports(
  role: string | null | undefined,
  isPlatformAdmin: boolean,
) {
  if (isPlatformAdmin) return true;

  return (
    role === "studio_owner" ||
    role === "studio_admin" ||
    role === "organizer_owner" ||
    role === "organizer_admin"
  );
}

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

function percent(value: number | null) {
  if (value === null || !Number.isFinite(value)) return "";
  return value.toFixed(2);
}

function settlementStatusLabel(value: string | null | undefined) {
  const normalized = (value ?? "open").trim().toLowerCase();
  if (normalized === "ready_to_settle") return "Ready to Settle";
  if (normalized === "settled") return "Settled";
  if (normalized === "reopened") return "Reopened";
  return "Open";
}

async function loadEventSummaryRows() {
  const supabase = await createClient();
  const context = await getCurrentStudioContext();

  if (!context.studioId || !canViewOrganizerEventExports(context.studioRole, context.isPlatformAdmin)) {
    return {
      errorResponse: new NextResponse("Unauthorized", { status: 401 }),
      rows: [] as EventSummaryRow[],
    };
  }

  const { data: eventRows, error: eventsError } = await supabase
    .from("events")
    .select("id,name,event_type,start_date,status")
    .eq("studio_id", context.studioId)
    .order("start_date", { ascending: true })
    .limit(10000);

  if (eventsError) {
    return {
      errorResponse: new NextResponse(
        `Failed to load organizer events: ${eventsError.message}`,
        { status: 500 },
      ),
      rows: [] as EventSummaryRow[],
    };
  }

  const events = (eventRows ?? []) as EventRow[];
  const eventIds = events.map((event) => event.id);

  if (eventIds.length === 0) {
    return { errorResponse: null, rows: [] as EventSummaryRow[] };
  }

  const [
    { data: profitabilityRows, error: profitabilityError },
    { data: settlementRows, error: settlementsError },
    { data: registrationRows, error: registrationsError },
    { data: ticketRows, error: ticketRowsError },
  ] = await Promise.all([
    supabase
      .from("v_event_profit_loss")
      .select(
        "event_id,gross_ticket_revenue,refunds,processing_and_platform_fees,net_ticket_revenue,event_expenses,event_labor_costs,total_event_costs,event_profit_loss",
      )
      .in("event_id", eventIds)
      .limit(10000),

    supabase
      .from("event_settlements")
      .select("event_id,status,settled_at")
      .in("event_id", eventIds)
      .limit(10000),

    supabase
      .from("event_registrations")
      .select("event_id,status,payment_status,quantity")
      .in("event_id", eventIds)
      .limit(20000),

    supabase
      .from("event_registration_attendees")
      .select("event_id,checked_in_at")
      .in("event_id", eventIds)
      .limit(20000),
  ]);

  if (profitabilityError) {
    return {
      errorResponse: new NextResponse(
        `Failed to load organizer event profitability: ${profitabilityError.message}`,
        { status: 500 },
      ),
      rows: [] as EventSummaryRow[],
    };
  }

  if (settlementsError) {
    return {
      errorResponse: new NextResponse(
        `Failed to load organizer event settlements: ${settlementsError.message}`,
        { status: 500 },
      ),
      rows: [] as EventSummaryRow[],
    };
  }

  if (registrationsError) {
    return {
      errorResponse: new NextResponse(
        `Failed to load organizer event registrations: ${registrationsError.message}`,
        { status: 500 },
      ),
      rows: [] as EventSummaryRow[],
    };
  }

  if (ticketRowsError) {
    return {
      errorResponse: new NextResponse(
        `Failed to load organizer event check-ins: ${ticketRowsError.message}`,
        { status: 500 },
      ),
      rows: [] as EventSummaryRow[],
    };
  }

  const profitabilityByEventId = new Map<string, EventProfitabilityRow>();
  for (const row of (profitabilityRows ?? []) as EventProfitabilityRow[]) {
    if (row.event_id) profitabilityByEventId.set(row.event_id, row);
  }

  const settlementByEventId = new Map<string, EventSettlementRow>();
  for (const row of (settlementRows ?? []) as EventSettlementRow[]) {
    if (row.event_id) settlementByEventId.set(row.event_id, row);
  }

  const registrationsByEventId = new Map<string, EventRegistrationRow[]>();
  for (const row of (registrationRows ?? []) as EventRegistrationRow[]) {
    const current = registrationsByEventId.get(row.event_id) ?? [];
    current.push(row);
    registrationsByEventId.set(row.event_id, current);
  }

  const ticketsByEventId = new Map<string, EventTicketCheckInRow[]>();
  for (const row of (ticketRows ?? []) as EventTicketCheckInRow[]) {
    if (!row.event_id) continue;
    const current = ticketsByEventId.get(row.event_id) ?? [];
    current.push(row);
    ticketsByEventId.set(row.event_id, current);
  }

  const todayStart = new Date(new Date().toDateString());

  const rows = events.map((event) => {
    const profitability = profitabilityByEventId.get(event.id);
    const settlement = settlementByEventId.get(event.id);
    const registrations = registrationsByEventId.get(event.id) ?? [];
    const ticketRowsForEvent = ticketsByEventId.get(event.id) ?? [];

    const netTicketRevenue = safeNumber(profitability?.net_ticket_revenue);
    const eventProfitLoss = safeNumber(profitability?.event_profit_loss);
    const ticketsIssued =
      ticketRowsForEvent.length > 0
        ? ticketRowsForEvent.length
        : registrations.reduce((sum, row) => sum + Number(row.quantity ?? 1), 0);
    const ticketsCheckedIn = ticketRowsForEvent.filter((row) => row.checked_in_at).length;
    const eventStartDate = event.start_date ? new Date(`${event.start_date}T00:00:00`) : null;
    const isPastEvent =
      Boolean(eventStartDate) &&
      !Number.isNaN(eventStartDate?.getTime()) &&
      eventStartDate! < todayStart;

    return {
      event,
      grossTicketRevenue: safeNumber(profitability?.gross_ticket_revenue),
      refunds: safeNumber(profitability?.refunds),
      fees: safeNumber(profitability?.processing_and_platform_fees),
      netTicketRevenue,
      eventExpenses: safeNumber(profitability?.event_expenses),
      eventLaborCosts: safeNumber(profitability?.event_labor_costs),
      totalEventCosts: safeNumber(profitability?.total_event_costs),
      eventProfitLoss,
      marginPercent: netTicketRevenue ? (eventProfitLoss / netTicketRevenue) * 100 : null,
      registrations: registrations.length,
      paidRegistrations: registrations.filter((row) => row.payment_status === "paid").length,
      unpaidRegistrations: registrations.filter((row) => row.payment_status === "unpaid").length,
      pendingRegistrations: registrations.filter((row) => row.payment_status === "pending").length,
      refundedRegistrations: registrations.filter(
        (row) =>
          row.payment_status === "refunded" ||
          row.status === "refunded" ||
          row.status === "cancelled",
      ).length,
      ticketsIssued,
      ticketsCheckedIn,
      checkInRate: ticketsIssued ? (ticketsCheckedIn / ticketsIssued) * 100 : null,
      settlementStatus: settlement?.status ?? "open",
      settledAt: settlement?.settled_at ?? null,
      hasSettlementRecord: Boolean(settlement),
      isCompletedOrPast: event.status === "completed" || isPastEvent,
    };
  });

  return { errorResponse: null, rows };
}

type AttentionIssue = {
  label: string;
  severity: "critical" | "warning";
};

function getAttentionIssues(row: EventSummaryRow) {
  const issues: AttentionIssue[] = [];
  const settlementStatus = row.settlementStatus.trim().toLowerCase();
  const isSettled = settlementStatus === "settled";
  const lowMarginThreshold = 15;

  if (row.isCompletedOrPast && !isSettled) {
    issues.push({
      label: "Completed/past event is not settled",
      severity: "critical",
    });
  }

  if (!row.hasSettlementRecord) {
    issues.push({ label: "No settlement record yet", severity: "warning" });
  }

  if (row.eventProfitLoss < 0) {
    issues.push({ label: "Event is losing money", severity: "critical" });
  } else if (
    row.marginPercent !== null &&
    row.marginPercent < lowMarginThreshold
  ) {
    issues.push({
      label: `Margin below ${lowMarginThreshold}%`,
      severity: "warning",
    });
  }

  if (row.unpaidRegistrations > 0) {
    issues.push({
      label: `${row.unpaidRegistrations} unpaid registration${row.unpaidRegistrations === 1 ? "" : "s"}`,
      severity: "critical",
    });
  }

  if (row.pendingRegistrations > 0) {
    issues.push({
      label: `${row.pendingRegistrations} pending registration${row.pendingRegistrations === 1 ? "" : "s"}`,
      severity: "warning",
    });
  }

  if (row.refunds > 0 || row.refundedRegistrations > 0) {
    issues.push({ label: "Refund activity to review", severity: "warning" });
  }

  if (row.netTicketRevenue > 0 && row.eventLaborCosts <= 0) {
    issues.push({ label: "No labor/staff costs linked", severity: "warning" });
  }

  if (row.netTicketRevenue > 0 && row.eventExpenses <= 0) {
    issues.push({ label: "No event expenses linked", severity: "warning" });
  }

  if (
    row.isCompletedOrPast &&
    row.ticketsIssued > 0 &&
    row.checkInRate !== null &&
    row.checkInRate < 75
  ) {
    issues.push({ label: "Low check-in rate", severity: "warning" });
  }

  return issues;
}

export async function GET() {
  const { errorResponse, rows } = await loadEventSummaryRows();

  if (errorResponse) return errorResponse;

  const csvRows = rows
    .map((row) => {
      const issues = getAttentionIssues(row);
      const hasCritical = issues.some((issue) => issue.severity === "critical");

      return {
        row,
        issues,
        severity: hasCritical ? "Needs review" : "Check",
      };
    })
    .filter((item) => item.issues.length > 0)
    .sort((a, b) => {
      if (a.severity !== b.severity) {
        return a.severity === "Needs review" ? -1 : 1;
      }

      return (a.row.event.start_date ?? "").localeCompare(b.row.event.start_date ?? "");
    })
    .map((item) => [
      item.row.event.name ?? "Untitled event",
      item.row.event.event_type ?? "event",
      item.row.event.start_date ?? "",
      item.row.event.status ?? "",
      settlementStatusLabel(item.row.settlementStatus),
      item.severity,
      item.issues.map((issue) => issue.label).join("; "),
      item.issues.filter((issue) => issue.severity === "critical").length,
      item.issues.filter((issue) => issue.severity === "warning").length,
      item.row.netTicketRevenue,
      item.row.totalEventCosts,
      item.row.eventProfitLoss,
      percent(item.row.marginPercent),
      item.row.unpaidRegistrations,
      item.row.pendingRegistrations,
      item.row.refundedRegistrations,
      item.row.ticketsIssued,
      item.row.ticketsCheckedIn,
      percent(item.row.checkInRate),
      item.row.settledAt ?? "",
      item.row.event.id,
    ]);

  const csv = toCsv(
    [
      "Event",
      "Event Type",
      "Event Date",
      "Event Status",
      "Settlement Status",
      "Attention Severity",
      "Issues",
      "Critical Issue Count",
      "Warning Issue Count",
      "Net Ticket Revenue",
      "Total Event Costs",
      "Event Profit / Loss",
      "Profit Margin %",
      "Unpaid Registrations",
      "Pending Registrations",
      "Refunded Registrations",
      "Tickets Issued",
      "Tickets Checked In",
      "Check-In Rate %",
      "Settled At",
      "Event ID",
    ],
    csvRows,
  );

  return csvResponse(csv, "danceflow-organizer-events-needing-attention.csv");
}
