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
      .eq("permission_key", "export_schedule")
      .maybeSingle();

    if (overrideError) {
      return NextResponse.json({ error: overrideError.message }, { status: 500 });
    }

    exportOverrideAllowed =
      typeof overrideRow?.allowed === "boolean" ? overrideRow.allowed : undefined;
  }

  const canExportAppointments =
    workspace.isPlatformAdmin ||
    canExportWithOverride({
      role: workspace.studioRole,
      permission: "export_schedule",
      overrideAllowed: exportOverrideAllowed,
    });

  if (!canExportAppointments) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { data, error } = await supabase
    .from("appointments")
    .select(`
      title,
      appointment_type,
      status,
      starts_at,
      ends_at,
      notes,
      clients ( first_name, last_name ),
      instructors ( first_name, last_name ),
      rooms ( name )
    `)
    .eq("studio_id", workspace.studioId)
    .order("starts_at", { ascending: false });

  if (error) {
    return NextResponse.json(
      { error: `Appointments export failed: ${error.message}` },
      { status: 500 }
    );
  }

  const csv = toCsv(
    [
      "Client",
      "Title",
      "Appointment Type",
      "Status",
      "Start",
      "End",
      "Instructor",
      "Room",
      "Notes",
    ],
    (data ?? []).map((row) => {
      const client = Array.isArray(row.clients) ? row.clients[0] : row.clients;
      const instructor = Array.isArray(row.instructors)
        ? row.instructors[0]
        : row.instructors;
      const room = Array.isArray(row.rooms) ? row.rooms[0] : row.rooms;

      return [
        client ? `${client.first_name} ${client.last_name}` : "",
        row.title,
        row.appointment_type,
        row.status,
        row.starts_at,
        row.ends_at,
        instructor ? `${instructor.first_name} ${instructor.last_name}` : "",
        room?.name ?? "",
        row.notes,
      ];
    })
  );

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="appointments.csv"',
      "Cache-Control": "no-store",
    },
  });
}