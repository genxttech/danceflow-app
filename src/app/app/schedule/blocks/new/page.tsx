import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import InstructorScheduleBlockForm from "../InstructorScheduleBlockForm";

type SearchParams = Promise<{
  date?: string;
  startTime?: string;
  endTime?: string;
  instructorId?: string;
}>;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validDate(value?: string) {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : "";
}

function validTime(value?: string) {
  return value && /^([01]\d|2[0-3]):[0-5]\d$/.test(value) ? value : "";
}

export default async function NewBlockPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const { studioId } = await getCurrentStudioContext();
  const supabase = await createClient();
  const params = await searchParams;

  const [{ data: instructors }, { data: rooms }] = await Promise.all([
    supabase
      .from("instructors")
      .select("id, first_name, last_name")
      .eq("studio_id", studioId)
      .eq("active", true)
      .order("first_name"),
    supabase
      .from("rooms")
      .select("id, name")
      .eq("studio_id", studioId)
      .eq("active", true)
      .order("name"),
  ]);

  const initialInstructorId =
    params.instructorId && UUID_PATTERN.test(params.instructorId)
      ? params.instructorId
      : "";

  return (
    <InstructorScheduleBlockForm
      initialDate={validDate(params.date)}
      initialStartTime={validTime(params.startTime)}
      initialEndTime={validTime(params.endTime)}
      initialInstructorId={initialInstructorId}
      instructors={(instructors ?? []).map((instructor) => ({
        id: instructor.id,
        name: `${instructor.first_name} ${instructor.last_name}`.trim(),
      }))}
      rooms={(rooms ?? []).map((room) => ({
        id: room.id,
        name: room.name,
      }))}
    />
  );
}
