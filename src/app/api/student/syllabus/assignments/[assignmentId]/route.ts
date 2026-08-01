import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getStudentApiUser } from "@/lib/auth/studentApiAuth";

function one<T>(value: T | T[] | null | undefined): T | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ assignmentId: string }> },
) {
  const user = await getStudentApiUser(request);

  if (!user) {
    return NextResponse.json(
      { error: "Sign in to view this curriculum assignment." },
      { status: 401 },
    );
  }

  const { assignmentId } = await context.params;
  const admin = createAdminClient();

  const { data: assignment, error } = await admin
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
      archived_at,
      syllabus_steps (
        id,
        name,
        alternate_name,
        summary,
        prerequisite_notes,
        timing,
        counts,
        starting_position,
        ending_position,
        technique_notes,
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
        ),
        syllabus_step_charts (
          id,
          title,
          chart_format,
          notes,
          syllabus_step_chart_rows (
            id,
            sort_order,
            count_label,
            leader_foot,
            leader_action,
            follower_foot,
            follower_action,
            direction,
            notes
          )
        ),
        syllabus_step_videos (
          id,
          display_order,
          student_visible,
          studio_video_assets (
            id,
            title,
            description,
            content_type,
            presentation_type,
            visibility,
            mux_upload_status,
            duration_seconds,
            status
          )
        )
      ),
      studios (
        name,
        public_name,
        slug
      )
    `)
    .eq("id", assignmentId)
    .eq("student_visible", true)
    .is("archived_at", null)
    .maybeSingle();

  if (error || !assignment) {
    return NextResponse.json(
      { error: "Curriculum assignment was not found." },
      { status: 404 },
    );
  }

  const { data: link } = await admin
    .from("client_account_links")
    .select("id")
    .eq("user_id", user.id)
    .eq("studio_id", assignment.studio_id)
    .eq("client_id", assignment.client_id)
    .eq("status", "linked")
    .eq("can_view_schedule", true)
    .maybeSingle();

  if (!link) {
    return NextResponse.json(
      { error: "You do not have access to this assignment." },
      { status: 403 },
    );
  }

  const step = one(assignment.syllabus_steps);
  const level = one(step?.syllabus_levels);
  const dance = one(level?.syllabus_dances);
  const style = one(dance?.syllabus_styles);
  const studio = one(assignment.studios);
  const chart = one(step?.syllabus_step_charts);

  const chartRows = [...(chart?.syllabus_step_chart_rows ?? [])].sort(
    (a, b) => Number(a.sort_order ?? 0) - Number(b.sort_order ?? 0),
  );

  const videos = [...(step?.syllabus_step_videos ?? [])]
    .filter((linkRow) => linkRow.student_visible !== false)
    .map((linkRow) => {
      const asset = one(linkRow.studio_video_assets);

      if (
        !asset ||
        asset.status !== "ready" ||
        asset.mux_upload_status !== "ready" ||
        asset.visibility === "private"
      ) {
        return null;
      }

      return {
        id: asset.id,
        title: asset.title,
        description: asset.description,
        contentType: asset.content_type,
        presentationType: asset.presentation_type,
        durationSeconds: asset.duration_seconds,
        displayOrder: linkRow.display_order,
      };
    })
    .filter(
      (video): video is Exclude<typeof video, null> => video !== null,
    )
    .sort((a, b) => a.displayOrder - b.displayOrder);

  return NextResponse.json({
    assignment: {
      id: assignment.id,
      studioId: assignment.studio_id,
      clientId: assignment.client_id,
      studioName:
        studio?.public_name?.trim() || studio?.name || "Dance studio",
      studioSlug: studio?.slug ?? null,
      assignedAt: assignment.assigned_at,
      targetDate: assignment.target_date,
      priority: assignment.priority,
      status: assignment.status,
      practiceNote: assignment.practice_note,
      completedAt: assignment.completed_at,
      step: {
        id: step?.id ?? null,
        name: step?.name ?? "Curriculum step",
        alternateName: step?.alternate_name ?? null,
        summary: step?.summary ?? null,
        prerequisiteNotes: step?.prerequisite_notes ?? null,
        timing: step?.timing ?? null,
        counts: step?.counts ?? null,
        startingPosition: step?.starting_position ?? null,
        endingPosition: step?.ending_position ?? null,
        techniqueNotes: step?.technique_notes ?? null,
        studentNotes: step?.student_notes ?? null,
        styleName: style?.name ?? null,
        danceName: dance?.name ?? null,
        levelName: level?.name ?? null,
      },
      chart: chart
        ? {
            id: chart.id,
            title: chart.title,
            format: chart.chart_format,
            notes: chart.notes,
            rows: chartRows.map((row) => ({
              id: row.id,
              countLabel: row.count_label,
              leaderFoot: row.leader_foot,
              leaderAction: row.leader_action,
              followerFoot: row.follower_foot,
              followerAction: row.follower_action,
              direction: row.direction,
              notes: row.notes,
            })),
          }
        : null,
      videos,
    },
  });
}
