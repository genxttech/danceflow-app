import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getStudentApiUser } from "@/lib/auth/studentApiAuth";

function one<T>(value: T | T[] | null | undefined): T | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

export async function GET(request: NextRequest) {
  const user = await getStudentApiUser(request);

  if (!user) {
    return NextResponse.json(
      { error: "Sign in to view curriculum assignments." },
      { status: 401 },
    );
  }

  const admin = createAdminClient();

  const { data: links, error: linkError } = await admin
    .from("client_account_links")
    .select("studio_id, client_id")
    .eq("user_id", user.id)
    .eq("status", "linked")
    .eq("can_view_schedule", true);

  if (linkError) {
    return NextResponse.json(
      { error: "Studio access could not be verified." },
      { status: 500 },
    );
  }

  const linkedPairs = (links ?? []).map((link) => ({
    studioId: link.studio_id,
    clientId: link.client_id,
  }));

  if (!linkedPairs.length) {
    return NextResponse.json({ assignments: [] });
  }

  const clientIds = linkedPairs.map((link) => link.clientId);
  const studioIds = linkedPairs.map((link) => link.studioId);

  const { data, error } = await admin
    .from("client_syllabus_step_assignments")
    .select(`
      id,
      studio_id,
      client_id,
      assigned_at,
      target_date,
      priority,
      status,
      practice_note,
      student_visible,
      completed_at,
      syllabus_steps (
        id,
        name,
        alternate_name,
        summary,
        timing,
        counts,
        student_notes,
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
      ),
      studios (
        name,
        public_name,
        slug
      )
    `)
    .in("studio_id", studioIds)
    .in("client_id", clientIds)
    .eq("student_visible", true)
    .is("archived_at", null)
    .order("assigned_at", { ascending: false });

  if (error) {
    return NextResponse.json(
      { error: "Curriculum assignments could not be loaded." },
      { status: 500 },
    );
  }

  const validPairs = new Set(
    linkedPairs.map((link) => `${link.studioId}:${link.clientId}`),
  );

  const assignments = (data ?? [])
    .filter((row) => validPairs.has(`${row.studio_id}:${row.client_id}`))
    .map((row) => {
      const step = one(row.syllabus_steps);
      const level = one(step?.syllabus_levels);
      const dance = one(level?.syllabus_dances);
      const style = one(dance?.syllabus_styles);
      const studio = one(row.studios);

      return {
        id: row.id,
        studioId: row.studio_id,
        clientId: row.client_id,
        studioName:
          studio?.public_name?.trim() || studio?.name || "Dance studio",
        studioSlug: studio?.slug ?? null,
        stepId: step?.id ?? null,
        stepName: step?.name ?? "Curriculum step",
        alternateName: step?.alternate_name ?? null,
        summary: step?.summary ?? null,
        timing: step?.timing ?? null,
        counts: step?.counts ?? null,
        studentNotes: step?.student_notes ?? null,
        styleName: style?.name ?? null,
        danceName: dance?.name ?? null,
        levelName: level?.name ?? null,
        assignedAt: row.assigned_at,
        targetDate: row.target_date,
        priority: row.priority,
        status: row.status,
        practiceNote: row.practice_note,
        completedAt: row.completed_at,
      };
    })
    .filter((row) => row.stepId);

  return NextResponse.json({ assignments });
}
