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

  const canExportPayouts =
    workspace.isPlatformAdmin ||
    canExportWithOverride({
      role: workspace.studioRole,
      permission: "export_financials",
      overrideAllowed: exportOverrideAllowed,
    });

  if (!canExportPayouts) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { data: payouts, error } = await supabase
    .from("stripe_payouts")
    .select(
      `
      stripe_payout_id,
      stripe_account_id,
      stripe_balance_transaction_id,
      amount,
      currency,
      status,
      arrival_date,
      payout_created_at,
      method,
      type,
      description,
      statement_descriptor,
      failure_code,
      failure_message,
      created_at,
      updated_at
    `,
    )
    .eq("studio_id", workspace.studioId)
    .gte("arrival_date", rangeStart)
    .lte("arrival_date", rangeEnd)
    .order("arrival_date", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const csv = toCsv(
    [
      "Payout ID",
      "Stripe Account ID",
      "Balance Transaction ID",
      "Amount",
      "Currency",
      "Status",
      "Arrival Date",
      "Payout Created At",
      "Method",
      "Type",
      "Description",
      "Statement Descriptor",
      "Failure Code",
      "Failure Message",
      "Captured At",
      "Updated At",
    ],
    (payouts ?? []).map((payout) => [
      payout.stripe_payout_id,
      payout.stripe_account_id,
      payout.stripe_balance_transaction_id,
      payout.amount,
      payout.currency,
      payout.status,
      payout.arrival_date,
      payout.payout_created_at,
      payout.method,
      payout.type,
      payout.description,
      payout.statement_descriptor,
      payout.failure_code,
      payout.failure_message,
      payout.created_at,
      payout.updated_at,
    ]),
  );

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="danceflow-stripe-payouts-${range}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
