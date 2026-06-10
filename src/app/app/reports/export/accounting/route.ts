import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { canExportWithOverride } from "@/lib/auth/permissions";
import { toCsv } from "@/lib/utils/csv";
import { getStudioAccountingEntries } from "@/lib/accounting/entries";

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

  const canExportAccounting =
    workspace.isPlatformAdmin ||
    canExportWithOverride({
      role: workspace.studioRole,
      permission: "export_financials",
      overrideAllowed: exportOverrideAllowed,
    });

  if (!canExportAccounting) {
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
        "Entry Date",
        "Entry Type",
        "Category",
        "Category Label",
        "Direction",
        "Gross Amount",
        "Fee Amount",
        "Refund Amount",
        "Net Amount",
        "Currency",
        "Payment Method",
        "Source Table",
        "Source ID",
        "Client ID",
        "Event ID",
        "Appointment ID",
        "External Reference",
        "Stripe Payment Intent ID",
        "Stripe Charge ID",
        "Stripe Invoice ID",
        "Status",
        "Description",
        "Created At",
      ],
      entries.map((entry) => [
        entry.entryDate,
        entry.entryType,
        entry.category,
        entry.categoryLabel,
        entry.direction,
        entry.grossAmount,
        entry.feeAmount,
        entry.refundAmount,
        entry.netAmount,
        entry.currency,
        entry.paymentMethod,
        entry.sourceTable,
        entry.sourceId,
        entry.clientId,
        entry.eventId,
        entry.appointmentId,
        entry.externalReference,
        entry.stripePaymentIntentId,
        entry.stripeChargeId,
        entry.stripeInvoiceId,
        entry.status,
        entry.description,
        entry.createdAt,
      ]),
    );

    return new NextResponse(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="danceflow-accounting-entries-${range}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Accounting export failed.",
      },
      { status: 500 },
    );
  }
}
