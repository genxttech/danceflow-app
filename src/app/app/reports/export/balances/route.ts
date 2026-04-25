import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { canExportWithOverride } from "@/lib/auth/permissions";
import { toCsv } from "@/lib/utils/csv";

export async function GET() {
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

  const canExportBalances =
    workspace.isPlatformAdmin ||
    canExportWithOverride({
      role: workspace.studioRole,
      permission: "export_financials",
      overrideAllowed: exportOverrideAllowed,
    });

  if (!canExportBalances) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { data, error } = await supabase
    .from("client_packages")
    .select(`
      name_snapshot,
      expiration_date,
      active,
      clients ( first_name, last_name ),
      client_package_items (
        usage_type,
        quantity_total,
        quantity_used,
        quantity_remaining,
        is_unlimited
      )
    `)
    .eq("studio_id", workspace.studioId)
    .order("purchase_date", { ascending: false });

  if (error) {
    return NextResponse.json(
      { error: `Balances export failed: ${error.message}` },
      { status: 500 }
    );
  }

  const rows: Array<Array<unknown>> = [];

  for (const pkg of data ?? []) {
    const client = Array.isArray(pkg.clients) ? pkg.clients[0] : pkg.clients;

    for (const item of pkg.client_package_items ?? []) {
      rows.push([
        client ? `${client.first_name} ${client.last_name}` : "",
        pkg.name_snapshot,
        item.usage_type,
        item.quantity_total,
        item.quantity_used,
        item.quantity_remaining,
        item.is_unlimited,
        pkg.expiration_date,
        pkg.active,
      ]);
    }
  }

  const csv = toCsv(
    [
      "Client",
      "Package",
      "Usage Type",
      "Quantity Total",
      "Quantity Used",
      "Quantity Remaining",
      "Unlimited",
      "Expiration Date",
      "Package Active",
    ],
    rows
  );

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="balances.csv"',
      "Cache-Control": "no-store",
    },
  });
}