import { NextResponse } from "next/server";
import { requireReportsAccess } from "@/lib/auth/serverRoleGuard";
import { toCsv } from "@/lib/utils/csv";

export async function GET() {
  const { supabase, studioId } = await requireReportsAccess();

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
    .eq("studio_id", studioId)
    .order("purchase_date", { ascending: false });

  if (error) {
    throw new Error(`Balances export failed: ${error.message}`);
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
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="balances.csv"',
    },
  });
}