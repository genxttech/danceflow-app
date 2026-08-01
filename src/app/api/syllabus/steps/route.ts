import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";

export async function GET() {
  const supabase = await createClient();
  const context = await getCurrentStudioContext();
  const studioId = context.studioId;

  if (!studioId) {
    return NextResponse.json({ error: "Studio access is required." }, { status: 403 });
  }

  const { data, error } = await supabase
    .from("syllabus_steps")
    .select(`
      id,
      name,
      alternate_name,
      status,
      syllabus_levels (
        id,
        name,
        syllabus_dances (
          id,
          name,
          syllabus_styles (
            id,
            name
          )
        )
      )
    `)
    .eq("studio_id", studioId)
    .eq("status", "active")
    .order("name", { ascending: true });

  if (error) {
    return NextResponse.json(
      { error: "Curriculum steps could not be loaded." },
      { status: 500 },
    );
  }

  return NextResponse.json({ steps: data ?? [] });
}
