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

  const canExportLedger =
    workspace.isPlatformAdmin ||
    canExportWithOverride({
      role: workspace.studioRole,
      permission: "export_financials",
      overrideAllowed: exportOverrideAllowed,
    });

  if (!canExportLedger) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { data, error } = await supabase
    .from("lesson_transactions")
    .select(`
      transaction_type,
      lessons_delta,
      balance_after,
      notes,
      created_at,
      clients ( first_name, last_name ),
      client_packages ( name_snapshot )
    `)
    .eq("studio_id", workspace.studioId)
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json(
      { error: `Ledger export failed: ${error.message}` },
      { status: 500 }
    );
  }

  const csv = toCsv(
    [
      "Client",
      "Package",
      "Transaction Type",
      "Lessons Delta",
      "Balance After",
      "Notes",
      "Created At",
    ],
    (data ?? []).map((row) => {
      const client = Array.isArray(row.clients) ? row.clients[0] : row.clients;
      const pkg = Array.isArray(row.client_packages)
        ? row.client_packages[0]
        : row.client_packages;

      return [
        client ? `${client.first_name} ${client.last_name}` : "",
        pkg?.name_snapshot ?? "",
        row.transaction_type,
        row.lessons_delta,
        row.balance_after,
        row.notes,
        row.created_at,
      ];
    })
  );

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="ledger.csv"',
      "Cache-Control": "no-store",
    },
  });
}