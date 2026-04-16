import { NextResponse } from "next/server";
import { requireReportsAccess } from "@/lib/auth/serverRoleGuard";
import { toCsv } from "@/lib/utils/csv";

export async function GET() {
  const { supabase, studioId } = await requireReportsAccess();

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
    .eq("studio_id", studioId)
    .order("created_at", { ascending: false });

  if (error) {
    throw new Error(`Payments export failed: ${error.message}`);
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
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="payments.csv"',
    },
  });
}