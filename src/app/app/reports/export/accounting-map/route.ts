import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { canExportWithOverride } from "@/lib/auth/permissions";
import { toCsv } from "@/lib/utils/csv";
import {
  type AccountingEntry,
  getStudioAccountingEntries,
} from "@/lib/accounting/entries";

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

function accountingTypeForEntry(entry: AccountingEntry) {
  if (entry.entryType === "refund") return "contra_revenue";
  if (entry.entryType === "processing_fee") return "payment_processing_fee";
  if (entry.entryType === "platform_fee") return "platform_fee";
  if (entry.entryType === "expense") return "expense";
  if (entry.entryType === "credit_applied") return "client_credit_applied";
  if (entry.entryType === "adjustment") return "manual_adjustment";
  return "revenue";
}

function statementSectionForEntry(entry: AccountingEntry) {
  if (entry.entryType === "revenue") return "income";
  if (entry.entryType === "refund") return "contra_income";
  if (
    entry.entryType === "processing_fee" ||
    entry.entryType === "platform_fee" ||
    entry.entryType === "expense"
  ) {
    return "expense";
  }
  return "other";
}

function accountNameForEntry(entry: AccountingEntry) {
  const category = entry.category;

  if (entry.entryType === "refund") return "Refunds / Contra-Revenue";
  if (entry.entryType === "processing_fee") return "Stripe Processing Fees";
  if (entry.entryType === "platform_fee") return "DanceFlow Platform Fees";
  if (entry.entryType === "expense") {
    if (category.includes("floor")) return "Floor Fee Expense";
    if (category.includes("event")) return "Event Expense";
    return "Operating Expense";
  }

  if (category.includes("membership")) return "Membership Revenue";
  if (category.includes("package")) return "Package Revenue";
  if (category.includes("event_ticket")) return "Event Ticket Revenue";
  if (category.includes("coach_private")) return "Coach Private Lesson Revenue";
  if (category.includes("private_lesson")) return "Private Lesson Revenue";
  if (category.includes("group_class")) return "Group Class Revenue";
  if (category.includes("practice_party")) return "Practice Party Revenue";
  if (category.includes("floor_rental")) return "Floor Rental Revenue";
  if (category.includes("manual")) return "Manual Payment Revenue";

  return entry.categoryLabel || "Other Revenue";
}

function sourceGroupForEntry(entry: AccountingEntry) {
  if (entry.sourceTable === "event_payments") return "events";
  if (entry.sourceTable === "payments" && entry.category.includes("membership")) {
    return "memberships";
  }
  if (entry.sourceTable === "payments" && entry.category.includes("package")) {
    return "packages";
  }
  if (entry.sourceTable === "expenses") return "expenses";
  if (entry.appointmentId) return "appointments";
  return entry.sourceTable;
}

function signedAmountForEntry(entry: AccountingEntry) {
  if (entry.entryType === "revenue") return entry.grossAmount;
  if (entry.entryType === "refund") {
    return -Math.abs(entry.refundAmount || entry.netAmount);
  }
  if (
    entry.entryType === "processing_fee" ||
    entry.entryType === "platform_fee" ||
    entry.entryType === "expense"
  ) {
    return -Math.abs(entry.netAmount || entry.feeAmount);
  }

  return entry.netAmount;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const range = url.searchParams.get("range") ?? "month";
  const rangeStart = getRangeStart(range).toISOString();
  const rangeEnd = new Date().toISOString();

  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const workspace = await getCurrentStudioContext();

  if (!workspace?.studioId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let exportOverrideAllowed: boolean | undefined = undefined;

  if (!workspace.isPlatformAdmin) {
    const { data: overrideRow, error: overrideError } = await supabase
      .from("role_permission_overrides")
      .select("allowed")
      .eq("studio_id", workspace.studioId)
      .eq("user_id", user.id)
      .eq("permission_key", "export_financials")
      .maybeSingle();

    if (overrideError) {
      return NextResponse.json({ error: overrideError.message }, { status: 500 });
    }

    exportOverrideAllowed =
      typeof overrideRow?.allowed === "boolean" ? overrideRow.allowed : undefined;
  }

  const canExportAccountingMap =
    workspace.isPlatformAdmin ||
    canExportWithOverride({
      role: workspace.studioRole,
      permission: "export_financials",
      overrideAllowed: exportOverrideAllowed,
    });

  if (!canExportAccountingMap) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const entries = await getStudioAccountingEntries({
      supabase,
      studioId: workspace.studioId,
      startDate: rangeStart,
      endDate: rangeEnd,
    });

    const csv = toCsv(
      [
        "Date",
        "Statement Section",
        "Accounting Type",
        "Suggested Account",
        "DanceFlow Category",
        "DanceFlow Category Label",
        "Source Group",
        "Source Table",
        "Source ID",
        "Description",
        "Client ID",
        "Event ID",
        "Event Accounting Basis",
        "Appointment ID",
        "Gross Amount",
        "Refund Amount",
        "Fee Amount",
        "Net Amount",
        "Signed Amount",
        "Currency",
        "Payment Method",
        "Status",
        "External Reference",
        "Stripe Payment Intent ID",
        "Stripe Charge ID",
        "Stripe Invoice ID",
        "Created At",
      ],
      entries.map((entry) => [
        entry.entryDate,
        statementSectionForEntry(entry),
        accountingTypeForEntry(entry),
        accountNameForEntry(entry),
        entry.category,
        entry.categoryLabel,
        sourceGroupForEntry(entry),
        entry.sourceTable,
        entry.sourceId,
        entry.description,
        entry.clientId,
        entry.eventId,
        entry.sourceTable === "event_payments" && entry.category === "event_ticket_revenue"
          ? "ledger_event_ticket_revenue"
          : entry.sourceTable === "expenses" && entry.eventId
            ? "event_expense"
            : "standard_entry",
        entry.appointmentId,
        entry.grossAmount,
        entry.refundAmount,
        entry.feeAmount,
        entry.netAmount,
        signedAmountForEntry(entry),
        entry.currency,
        entry.paymentMethod,
        entry.status,
        entry.externalReference,
        entry.stripePaymentIntentId,
        entry.stripeChargeId,
        entry.stripeInvoiceId,
        entry.createdAt,
      ]),
    );

    return new NextResponse(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="danceflow-accounting-map-${range}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Accounting export mapping failed.",
      },
      { status: 500 },
    );
  }
}
