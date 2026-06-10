import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { canExportWithOverride } from "@/lib/auth/permissions";
import { toCsv } from "@/lib/utils/csv";

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
  const payoutId = url.searchParams.get("payoutId");
  const rangeStart = getRangeStart(range).toISOString().slice(0, 10);
  const rangeEnd = new Date().toISOString().slice(0, 10);

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

  const canExportPayoutItems =
    workspace.isPlatformAdmin ||
    canExportWithOverride({
      role: workspace.studioRole,
      permission: "export_financials",
      overrideAllowed: exportOverrideAllowed,
    });

  if (!canExportPayoutItems) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let query = supabase
    .from("stripe_payout_items")
    .select(
      `
      stripe_payout_id,
      stripe_account_id,
      stripe_balance_transaction_id,
      stripe_source_id,
      stripe_source_type,
      payment_id,
      event_payment_id,
      amount,
      fee,
      net,
      currency,
      type,
      reporting_category,
      description,
      available_on,
      balance_transaction_created_at,
      created_at,
      updated_at
    `,
    )
    .eq("studio_id", workspace.studioId)
    .gte("available_on", rangeStart)
    .lte("available_on", rangeEnd)
    .order("available_on", { ascending: false });

  if (payoutId) {
    query = query.eq("stripe_payout_id", payoutId);
  }

  const { data: payoutItems, error } = await query;

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const csv = toCsv(
    [
      "Payout ID",
      "Stripe Account ID",
      "Balance Transaction ID",
      "Source ID",
      "Source Type",
      "Payment ID",
      "Event Payment ID",
      "Amount",
      "Fee",
      "Net",
      "Currency",
      "Type",
      "Reporting Category",
      "Description",
      "Available On",
      "Balance Transaction Created At",
      "Captured At",
      "Updated At",
    ],
    (payoutItems ?? []).map((item) => [
      item.stripe_payout_id,
      item.stripe_account_id,
      item.stripe_balance_transaction_id,
      item.stripe_source_id,
      item.stripe_source_type,
      item.payment_id,
      item.event_payment_id,
      item.amount,
      item.fee,
      item.net,
      item.currency,
      item.type,
      item.reporting_category,
      item.description,
      item.available_on,
      item.balance_transaction_created_at,
      item.created_at,
      item.updated_at,
    ]),
  );

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="danceflow-stripe-payout-items-${range}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
