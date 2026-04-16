import { NextResponse } from "next/server";
import { requireReportsAccess } from "@/lib/auth/serverRoleGuard";
import { toCsv } from "@/lib/utils/csv";

export async function GET() {
  const { supabase, studioId } = await requireReportsAccess();

  const { data, error } = await supabase
    .from("clients")
    .select(`
      first_name,
      last_name,
      email,
      phone,
      status,
      skill_level,
      dance_interests,
      referral_source,
      notes,
      created_at
    `)
    .eq("studio_id", studioId)
    .order("created_at", { ascending: false });

  if (error) {
    throw new Error(`Clients export failed: ${error.message}`);
  }

  const csv = toCsv(
    [
      "First Name",
      "Last Name",
      "Email",
      "Phone",
      "Status",
      "Skill Level",
      "Dance Interests",
      "Referral Source",
      "Notes",
      "Created At",
    ],
    (data ?? []).map((row) => [
      row.first_name,
      row.last_name,
      row.email,
      row.phone,
      row.status,
      row.skill_level,
      row.dance_interests,
      row.referral_source,
      row.notes,
      row.created_at,
    ])
  );

  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="clients.csv"',
    },
  });
}