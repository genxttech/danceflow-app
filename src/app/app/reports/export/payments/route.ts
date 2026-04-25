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

  const canExportPayments =
    workspace.isPlatformAdmin ||
    canExportWithOverride({
      role: workspace.studioRole,
      permission: "export_financials",
      overrideAllowed: exportOverrideAllowed,
    });

  if (!canExportPayments) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { data, error } = await supabase
    .from("payments")
    .select(`
      amount,
      payment_method,
      status,
      created_at,
      notes,
      clients ( first_name, last_name ),
      client_packages ( name_snapshot )
    `)
    .eq("studio_id", workspace.studioId)
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json(
      { error: `Payments export failed: ${error.message}` },
      { status: 500 }
    );
  }

  const csv = toCsv(
    [
      "Client",
      "Package",
      "Amount",
      "Payment Method",
      "Status",
      "Created At",
      "Notes",
    ],
    (data ?? []).map((row) => {
      const client = Array.isArray(row.clients) ? row.clients[0] : row.clients;
      const pkg = Array.isArray(row.client_packages)
        ? row.client_packages[0]
        : row.client_packages;

      return [
        client ? `${client.first_name} ${client.last_name}` : "",
        pkg?.name_snapshot ?? "",
        row.amount,
        row.payment_method,
        row.status,
        row.created_at,
        row.notes,
      ];
    })
  );

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="payments.csv"',
      "Cache-Control": "no-store",
    },
  });
}