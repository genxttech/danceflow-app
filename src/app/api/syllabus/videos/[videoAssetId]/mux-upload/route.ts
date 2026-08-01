import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { createMuxDirectUpload } from "@/lib/mux/server";

export const runtime = "nodejs";

function originFromRequest(request: Request) {
  const configured =
    process.env.NEXT_PUBLIC_SITE_URL?.trim() ||
    process.env.NEXT_PUBLIC_APP_URL?.trim();

  if (configured) return configured.replace(/\/$/, "");

  return new URL(request.url).origin;
}

async function getAuthorizedAsset(videoAssetId: string) {
  const supabase = await createClient();
  const context = await getCurrentStudioContext();
  const studioId = context.studioId;
  const role = context.studioRole ?? "";

  if (
    !studioId ||
    ![
      "studio_owner",
      "studio_admin",
      "front_desk",
      "instructor",
      "independent_instructor",
    ].includes(role)
  ) {
    return { error: "You do not have permission to manage curriculum videos.", status: 403 as const };
  }

  const { data: asset, error } = await supabase
    .from("studio_video_assets")
    .select(
      "id, studio_id, mux_upload_id, mux_upload_status, mux_asset_id, status",
    )
    .eq("id", videoAssetId)
    .eq("studio_id", studioId)
    .neq("status", "archived")
    .maybeSingle();

  if (error || !asset) {
    return { error: "Curriculum video was not found.", status: 404 as const };
  }

  return { supabase, studioId, asset };
}

export async function POST(
  request: Request,
  context: { params: Promise<{ videoAssetId: string }> },
) {
  const { videoAssetId } = await context.params;
  const access = await getAuthorizedAsset(videoAssetId);

  if ("error" in access) {
    return NextResponse.json({ ok: false, error: access.error }, { status: access.status });
  }

  if (access.asset.mux_asset_id) {
    return NextResponse.json(
      { ok: false, error: "This curriculum video already has a Mux asset." },
      { status: 409 },
    );
  }

  if (
    access.asset.mux_upload_id &&
    ["asset_created", "processing", "ready"].includes(
      access.asset.mux_upload_status ?? "",
    )
  ) {
    return NextResponse.json(
      { ok: false, error: "This curriculum video is already processing." },
      { status: 409 },
    );
  }

  const upload = await createMuxDirectUpload({
    corsOrigin: originFromRequest(request),
    passthrough: JSON.stringify({
      domain: "syllabus",
      videoAssetId,
      studioId: access.studioId,
    }),
  });

  const { error } = await access.supabase
    .from("studio_video_assets")
    .update({
      mux_upload_id: upload.id,
      mux_upload_status: upload.status || "waiting",
      mux_error_message: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", videoAssetId)
    .eq("studio_id", access.studioId);

  if (error) {
    return NextResponse.json(
      { ok: false, error: "The Mux upload could not be recorded." },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true, uploadUrl: upload.url });
}

export async function PATCH(
  _request: Request,
  context: { params: Promise<{ videoAssetId: string }> },
) {
  const { videoAssetId } = await context.params;
  const access = await getAuthorizedAsset(videoAssetId);

  if ("error" in access) {
    return NextResponse.json({ ok: false, error: access.error }, { status: access.status });
  }

  const { error } = await access.supabase
    .from("studio_video_assets")
    .update({
      mux_upload_status: "uploading",
      updated_at: new Date().toISOString(),
    })
    .eq("id", videoAssetId)
    .eq("studio_id", access.studioId);

  if (error) {
    return NextResponse.json(
      { ok: false, error: "The upload status could not be updated." },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true });
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ videoAssetId: string }> },
) {
  const { videoAssetId } = await context.params;
  const access = await getAuthorizedAsset(videoAssetId);

  if ("error" in access) {
    return NextResponse.json({ ok: false, error: access.error }, { status: access.status });
  }

  if (access.asset.mux_asset_id) {
    return NextResponse.json(
      { ok: false, error: "A created Mux asset cannot be cleared from this action." },
      { status: 409 },
    );
  }

  const { error } = await access.supabase
    .from("studio_video_assets")
    .update({
      mux_upload_id: null,
      mux_upload_status: null,
      mux_error_message: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", videoAssetId)
    .eq("studio_id", access.studioId);

  if (error) {
    return NextResponse.json(
      { ok: false, error: "The incomplete upload could not be cleared." },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true });
}
