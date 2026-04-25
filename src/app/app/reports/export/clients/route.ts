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
      .eq("permission_key", "export_clients")
      .maybeSingle();

    if (overrideError) {
      return NextResponse.json({ error: overrideError.message }, { status: 500 });
    }

    exportOverrideAllowed =
      typeof overrideRow?.allowed === "boolean" ? overrideRow.allowed : undefined;
  }

  const canExportClients =
    workspace.isPlatformAdmin ||
    canExportWithOverride({
      role: workspace.studioRole,
      permission: "export_clients",
      overrideAllowed: exportOverrideAllowed,
    });

  if (!canExportClients) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

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
    .eq("studio_id", workspace.studioId)
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json(
      { error: `Clients export failed: ${error.message}` },
      { status: 500 }
    );
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
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="clients.csv"',
      "Cache-Control": "no-store",
    },
  });
}