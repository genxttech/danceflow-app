import { randomUUID } from "node:crypto";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { canEditGroupClassSeries } from "@/lib/auth/permissions";
import { seriesOccurrenceLabel } from "@/lib/schedule/groupClassOccurrenceEdit";
import { localTimeOfDay, minutesBetween } from "@/lib/schedule/groupClassSeriesEdit";
import SeriesEditFollowingForm from "./SeriesEditFollowingForm";

type Params = Promise<{ id: string }>;

function hasEnded(endsAtIso: string) {
  return new Date(endsAtIso).getTime() <= Date.now();
}

/**
 * GC-S1C-5: "This and following classes" editor for a series occurrence. Broad staff only (the assigned instructor
 * keeps the single-class editor). This page only prefills the form from the class being edited; the server action and
 * the database RPC beneath it derive and authorize everything again.
 */
export default async function EditFollowingClassesPage({ params }: { params: Params }) {
  const { id } = await params;
  const { studioId, studioRole } = await getCurrentStudioContext();

  if (!canEditGroupClassSeries(studioRole ?? "")) {
    redirect(`/app/schedule/${id}`);
  }

  const supabase = await createClient();

  const { data: appointment } = await supabase
    .from("appointments")
    .select(
      "id, appointment_type, status, title, instructor_id, room_id, location_name, roster_capacity, starts_at, ends_at, group_class_series_id, series_occurrence_index",
    )
    .eq("id", id)
    .eq("studio_id", studioId)
    .maybeSingle();

  if (!appointment || appointment.appointment_type !== "group_class") notFound();
  if (!appointment.group_class_series_id) redirect(`/app/schedule/${id}/edit`);

  const backHref = `/app/schedule/${id}/edit`;

  const [{ data: series }, { count: terminalCount }, { data: instructors }, { data: rooms }] = await Promise.all([
    supabase
      .from("group_class_series")
      .select("timezone, status")
      .eq("id", appointment.group_class_series_id)
      .eq("studio_id", studioId)
      .maybeSingle(),
    supabase
      .from("attendance_records")
      .select("id", { count: "exact", head: true })
      .eq("studio_id", studioId)
      .eq("appointment_id", id)
      .in("status", ["attended", "no_show"]),
    supabase
      .from("instructors")
      .select("id, first_name, last_name")
      .eq("studio_id", studioId)
      .eq("active", true)
      .order("first_name", { ascending: true }),
    supabase
      .from("rooms")
      .select("id, name")
      .eq("studio_id", studioId)
      .eq("active", true)
      .order("name", { ascending: true }),
  ]);

  const startTime = localTimeOfDay(appointment.starts_at, series?.timezone);
  const durationMinutes = minutesBetween(appointment.starts_at, appointment.ends_at);
  const ended = hasEnded(appointment.ends_at);
  const editable =
    !!series &&
    series.status === "active" &&
    !!startTime &&
    !!durationMinutes &&
    ["scheduled", "confirmed", "rescheduled"].includes(appointment.status) &&
    !ended &&
    (terminalCount ?? 0) === 0;

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-4 sm:p-6">
      <div>
        <Link href={backHref} className="text-sm font-medium text-indigo-700 hover:text-indigo-900">
          &larr; Back to this class
        </Link>
        <h1 className="mt-2 text-2xl font-semibold text-slate-900">Edit this and following classes</h1>
      </div>

      {editable && startTime && durationMinutes ? (
        <SeriesEditFollowingForm
          appointmentId={appointment.id}
          requestId={randomUUID()}
          occurrenceLabel={seriesOccurrenceLabel(appointment.series_occurrence_index)}
          defaults={{
            title: appointment.title ?? "",
            instructorId: appointment.instructor_id ?? "",
            roomId: appointment.room_id ?? "",
            locationName: appointment.location_name ?? "",
            rosterCapacity: appointment.roster_capacity == null ? "" : String(appointment.roster_capacity),
            startTime,
            durationMinutes: String(durationMinutes),
          }}
          instructors={(instructors ?? []).map((i) => ({ id: i.id, label: `${i.first_name} ${i.last_name}`.trim() }))}
          rooms={(rooms ?? []).map((r) => ({ id: r.id, label: r.name }))}
          cancelHref={backHref}
        />
      ) : (
        <p className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
          This class can no longer be edited together with the classes that follow it (it is cancelled, already held, has
          attendance recorded, or its series is cancelled). Open a later class that is still upcoming to edit from there.
        </p>
      )}
    </div>
  );
}
