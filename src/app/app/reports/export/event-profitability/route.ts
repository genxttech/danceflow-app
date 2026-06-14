import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { canViewReports } from "@/lib/auth/permissions";
import { getCurrentStudioContext } from "@/lib/auth/studio";

type EventLookupRow = {
  id: string;
  name: string | null;
  event_type: string | null;
  start_date: string | null;
};

type EventAccountingRow = {
  event_id: string | null;
  source_table: string | null;
  category: string | null;
  gross_amount: number | string | null;
  fee_amount: number | string | null;
  refund_amount: number | string | null;
  net_amount: number | string | null;
};

type EventExportSummary = {
  eventId: string;
  grossTicketRevenue: number;
  refunds: number;
  processingAndPlatformFees: number;
  netTicketRevenue: number;
  eventExpenses: number;
  eventLaborCosts: number;
  totalEventCosts: number;
  eventProfitLoss: number;
};

function startOfTodayLocal() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function startOfMonthLocal() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

function startOfLast30DaysLocal() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - 30);
}

function startOfQuarterLocal() {
  const now = new Date();
  const quarterStartMonth = Math.floor(now.getMonth() / 3) * 3;
  return new Date(now.getFullYear(), quarterStartMonth, 1);
}

function startOfYearLocal() {
  const now = new Date();
  return new Date(now.getFullYear(), 0, 1);
}

function getRangeStart(range: string) {
  if (range === "today") return startOfTodayLocal();
  if (range === "last30") return startOfLast30DaysLocal();
  if (range === "quarter") return startOfQuarterLocal();
  if (range === "year") return startOfYearLocal();
  return startOfMonthLocal();
}

function getRangeEndExclusive() {
  const tomorrow = startOfTodayLocal();
  tomorrow.setDate(tomorrow.getDate() + 1);
  return tomorrow;
}

function dateOnly(value: Date) {
  return value.toISOString().slice(0, 10);
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

function marginPercent(profitLoss: number, netTicketRevenue: number) {
  if (!netTicketRevenue) return "";
  return ((profitLoss / netTicketRevenue) * 100).toFixed(2);
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const range = url.searchParams.get("range") ?? "month";
  const rangeStart = getRangeStart(range);
  const rangeEndExclusive = getRangeEndExclusive();
  const rangeStartDateOnly = dateOnly(rangeStart);
  const rangeEndDateOnly = dateOnly(rangeEndExclusive);

  const supabase = await createClient();
  const context = await getCurrentStudioContext();

  if (!canViewReports(context.studioRole ?? "") || !context.studioId) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  // Match the Reports page basis: event revenue and event costs come from accounting_entries
  // for the selected report range, not from the event's start_date. This includes future events
  // with tickets sold or labor/expenses recorded during the range.
  const { data: accountingRows, error: accountingError } = await supabase
    .from("accounting_entries")
    .select("event_id, source_table, category, gross_amount, fee_amount, refund_amount, net_amount")
    .eq("studio_id", context.studioId)
    .not("event_id", "is", null)
    .gte("entry_date", rangeStartDateOnly)
    .lt("entry_date", rangeEndDateOnly)
    .in("source_table", ["event_payments", "expenses", "event_labor_costs"])
    .limit(10000);

  if (accountingError) {
    return new NextResponse(
      `Failed to load event profitability accounting export data: ${accountingError.message}`,
      { status: 500 },
    );
  }

  const summariesByEventId = new Map<string, EventExportSummary>();

  function ensureSummary(eventId: string) {
    const existing = summariesByEventId.get(eventId);
    if (existing) return existing;

    const created: EventExportSummary = {
      eventId,
      grossTicketRevenue: 0,
      refunds: 0,
      processingAndPlatformFees: 0,
      netTicketRevenue: 0,
      eventExpenses: 0,
      eventLaborCosts: 0,
      totalEventCosts: 0,
      eventProfitLoss: 0,
    };

    summariesByEventId.set(eventId, created);
    return created;
  }

  for (const row of (accountingRows ?? []) as EventAccountingRow[]) {
    if (!row.event_id) continue;

    const summary = ensureSummary(row.event_id);
    const sourceTable = row.source_table ?? "";
    const category = row.category ?? "";

    if (sourceTable === "event_payments" && category === "event_ticket_revenue") {
      summary.grossTicketRevenue += safeNumber(row.gross_amount);
      summary.refunds += Math.abs(safeNumber(row.refund_amount));
      summary.processingAndPlatformFees += Math.abs(safeNumber(row.fee_amount));
      summary.netTicketRevenue += safeNumber(row.net_amount);
    } else if (sourceTable === "event_labor_costs" && category === "event_labor_expense") {
      summary.eventLaborCosts += Math.abs(safeNumber(row.net_amount));
    } else if (sourceTable === "expenses") {
      summary.eventExpenses += Math.abs(safeNumber(row.net_amount));
    }
  }

  for (const summary of summariesByEventId.values()) {
    summary.totalEventCosts = summary.eventExpenses + summary.eventLaborCosts;
    summary.eventProfitLoss = summary.netTicketRevenue - summary.totalEventCosts;
  }

  const eventIds = Array.from(summariesByEventId.keys());
  const eventById = new Map<string, EventLookupRow>();

  if (eventIds.length > 0) {
    const { data: events, error: eventsError } = await supabase
      .from("events")
      .select("id, name, event_type, start_date")
      .in("id", eventIds)
      .limit(10000);

    if (eventsError) {
      return new NextResponse(
        `Failed to load events for profitability export: ${eventsError.message}`,
        { status: 500 },
      );
    }

    for (const event of (events ?? []) as EventLookupRow[]) {
      eventById.set(event.id, event);
    }
  }

  const rows = Array.from(summariesByEventId.values())
    .sort((a, b) => b.eventProfitLoss - a.eventProfitLoss)
    .map((summary) => {
      const event = eventById.get(summary.eventId);

      return [
        event?.name ?? "Unknown event",
        event?.event_type ?? "event",
        event?.start_date ?? "",
        summary.grossTicketRevenue,
        summary.refunds,
        summary.processingAndPlatformFees,
        summary.netTicketRevenue,
        summary.eventExpenses,
        summary.eventLaborCosts,
        summary.totalEventCosts,
        summary.eventProfitLoss,
        marginPercent(summary.eventProfitLoss, summary.netTicketRevenue),
        summary.eventId,
      ];
    });

  const csv = toCsv(
    [
      "Event",
      "Event Type",
      "Event Date",
      "Gross Ticket Revenue",
      "Refunds",
      "Processing and Platform Fees",
      "Net Ticket Revenue",
      "Event Expenses",
      "Event Labor / Staff Costs",
      "Total Event Costs",
      "Event Profit / Loss",
      "Profit Margin %",
      "Event ID",
    ],
    rows,
  );

  return csvResponse(csv, `danceflow-event-profitability-${range}.csv`);
}
