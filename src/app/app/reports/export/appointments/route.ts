import { NextResponse } from "next/server";
import { requireReportsAccess } from "@/lib/auth/serverRoleGuard";
import { toCsv } from "@/lib/utils/csv";

export async function GET() {
  const { supabase, studioId } = await requireReportsAccess();

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
    .eq("studio_id", studioId)
    .order("starts_at", { ascending: false });

  if (error) {
    throw new Error(`Appointments export failed: ${error.message}`);
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
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="appointments.csv"',
    },
  });
}