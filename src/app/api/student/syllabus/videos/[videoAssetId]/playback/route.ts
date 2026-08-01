import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getStudentApiUser } from "@/lib/auth/studentApiAuth";
import { createSignedMuxPlaybackUrl } from "@/lib/mux/server";

export const runtime = "nodejs";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ videoAssetId: string }> },
) {
  const user = await getStudentApiUser(request);

  if (!user) {
    return NextResponse.json(
      { error: "Sign in to watch this curriculum video." },
      { status: 401 },
    );
  }

  const { videoAssetId } = await context.params;
  const assignmentId = request.nextUrl.searchParams.get("assignmentId");

  if (!assignmentId) {
    return NextResponse.json(
      { error: "A curriculum assignment is required." },
      { status: 400 },
    );
  }

  const admin = createAdminClient();

  const { data: assignment } = await admin
    .from("client_syllabus_step_assignments")
    .select("id, studio_id, client_id, syllabus_step_id, student_visible, archived_at")
    .eq("id", assignmentId)
    .eq("student_visible", true)
    .is("archived_at", null)
    .maybeSingle();

  if (!assignment) {
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
      { error: "You do not have access to this curriculum video." },
      { status: 403 },
    );
  }

  const { data: videoLink } = await admin
    .from("syllabus_step_videos")
    .select(`
      id,
      student_visible,
      studio_video_assets (
        id,
        title,
        description,
        mux_playback_id,
        mux_upload_status,
        duration_seconds,
        status,
        visibility
      )
    `)
    .eq("syllabus_step_id", assignment.syllabus_step_id)
    .eq("video_asset_id", videoAssetId)
    .eq("student_visible", true)
    .maybeSingle();

  const asset = Array.isArray(videoLink?.studio_video_assets)
    ? videoLink?.studio_video_assets[0] ?? null
    : videoLink?.studio_video_assets ?? null;

  if (
    !asset ||
    asset.status !== "ready" ||
    asset.mux_upload_status !== "ready" ||
    asset.visibility === "private" ||
    !asset.mux_playback_id
  ) {
    return NextResponse.json(
      { error: "This curriculum video is not available." },
      { status: 404 },
    );
  }

  const signed = createSignedMuxPlaybackUrl({
    playbackId: asset.mux_playback_id,
    expiresInSeconds: 900,
  });

  return NextResponse.json({
    video: {
      id: asset.id,
      title: asset.title,
      description: asset.description,
      durationSeconds: asset.duration_seconds,
      url: signed.url,
      expiresAt: signed.expiresAt,
    },
  });
}
