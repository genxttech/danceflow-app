import { NextResponse } from "next/server";
import { requireReportsAccess } from "@/lib/auth/serverRoleGuard";
import { toCsv } from "@/lib/utils/csv";

export async function GET() {
  const { supabase, studioId } = await requireReportsAccess();

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
    .eq("studio_id", studioId)
    .order("created_at", { ascending: false });

  if (error) {
    throw new Error(`Ledger export failed: ${error.message}`);
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
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="ledger.csv"',
    },
  });
}