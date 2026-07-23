import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { canManageCommerce } from "@/lib/auth/permissions";
import { createMuxDirectUpload } from "@/lib/mux/server";
import {
  checkRateLimit,
  getIpFromRequest,
  rateLimitKey,
  rateLimitedJson,
} from "@/lib/security/rate-limit";

export const runtime = "nodejs";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function appOrigin(request: Request) {
  const configured =
    process.env.NEXT_PUBLIC_APP_URL?.trim() ||
    process.env.NEXT_PUBLIC_SITE_URL?.trim();

  if (configured) return new URL(configured).origin;

  if (process.env.NODE_ENV === "production") {
    throw new Error("A configured DanceFlow application URL is required.");
  }

  return new URL(request.url).origin;
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;

    const ipRateLimit = checkRateLimit(
      rateLimitKey("commerce-mux-upload:ip", getIpFromRequest(request), id),
      { limit: 20, windowMs: 15 * 60 * 1000 },
    );
    if (!ipRateLimit.allowed) return rateLimitedJson(ipRateLimit);

    if (!UUID_PATTERN.test(id)) {
      return NextResponse.json(
        { ok: false, error: "Invalid catalog item." },
        { status: 400 },
      );
    }

    const supabase = await createClient();
    const studioContext = await getCurrentStudioContext();

    if (
      !studioContext.studioId ||
      (!studioContext.isPlatformAdmin &&
        !canManageCommerce(studioContext.studioRole))
    ) {
      return NextResponse.json(
        { ok: false, error: "You do not have permission to upload video." },
        { status: 403 },
      );
    }

    const { data: item, error: itemError } = await supabase
      .from("commerce_catalog_items")
      .select("id, item_type")
      .eq("id", id)
      .eq("studio_id", studioContext.studioId)
      .maybeSingle();

    if (
      itemError ||
      !item ||
      item.item_type !== "digital_video"
    ) {
      return NextResponse.json(
        { ok: false, error: "Digital video was not found." },
        { status: 404 },
      );
    }

    const { data: content, error: contentError } = await supabase
      .from("commerce_digital_content")
      .select("id, mux_upload_status, mux_asset_id")
      .eq("catalog_item_id", id)
      .eq("studio_id", studioContext.studioId)
      .maybeSingle();

    if (contentError) {
      throw new Error(contentError.message);
    }

    if (!content) {
      return NextResponse.json(
        {
          ok: false,
          error: "Save the content details before uploading a video.",
        },
        { status: 409 },
      );
    }

    if (
      ["asset_created", "processing"].includes(
        content.mux_upload_status ?? "",
      ) ||
      Boolean(content.mux_asset_id)
    ) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "Mux is already processing a video for this item. Check its status before starting another upload.",
        },
        { status: 409 },
      );
    }

    const userRateLimit = checkRateLimit(
      rateLimitKey(
        "commerce-mux-upload:user",
        studioContext.userId,
        studioContext.studioId,
        id,
      ),
      { limit: 6, windowMs: 30 * 60 * 1000 },
    );
    if (!userRateLimit.allowed) return rateLimitedJson(userRateLimit);

    const passthrough = JSON.stringify({
      catalogItemId: id,
      digitalContentId: content.id,
      studioId: studioContext.studioId,
    });

    const upload = await createMuxDirectUpload({
      corsOrigin: appOrigin(request),
      passthrough,
    });

    const now = new Date().toISOString();
    const { error: updateError } = await supabase
      .from("commerce_digital_content")
      .update({
        mux_upload_id: upload.id,
        mux_upload_status: "waiting",
        mux_asset_id: null,
        mux_playback_id: null,
        mux_asset_status: null,
        mux_error_message: null,
        external_provider: "mux",
        external_asset_id: null,
        external_playback_id: null,
        updated_by: studioContext.userId,
        updated_at: now,
      })
      .eq("id", content.id)
      .eq("studio_id", studioContext.studioId);

    if (updateError) {
      throw new Error(updateError.message);
    }

    return NextResponse.json({
      ok: true,
      uploadId: upload.id,
      uploadUrl: upload.url,
    });
  } catch (error) {
    console.error("Mux direct upload creation failed:", error);
    return NextResponse.json(
      {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Video upload could not be prepared.",
      },
      { status: 500 },
    );
  }
}


export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;

    const ipRateLimit = checkRateLimit(
      rateLimitKey("commerce-mux-reset:ip", getIpFromRequest(_request), id),
      { limit: 10, windowMs: 15 * 60 * 1000 },
    );
    if (!ipRateLimit.allowed) return rateLimitedJson(ipRateLimit);

    if (!UUID_PATTERN.test(id)) {
      return NextResponse.json(
        { ok: false, error: "Invalid catalog item." },
        { status: 400 },
      );
    }

    const supabase = await createClient();
    const studioContext = await getCurrentStudioContext();

    if (
      !studioContext.studioId ||
      (!studioContext.isPlatformAdmin &&
        !canManageCommerce(studioContext.studioRole))
    ) {
      return NextResponse.json(
        { ok: false, error: "You do not have permission to reset this upload." },
        { status: 403 },
      );
    }

    const { data: content, error: contentError } = await supabase
      .from("commerce_digital_content")
      .select("id, mux_upload_status, mux_asset_id")
      .eq("catalog_item_id", id)
      .eq("studio_id", studioContext.studioId)
      .maybeSingle();

    if (contentError || !content) {
      return NextResponse.json(
        { ok: false, error: "Digital video was not found." },
        { status: 404 },
      );
    }

    if (
      Boolean(content.mux_asset_id) ||
      ["asset_created", "processing", "ready"].includes(
        content.mux_upload_status ?? "",
      )
    ) {
      return NextResponse.json(
        {
          ok: false,
          error: "This upload can no longer be reset because Mux has already created the video asset.",
        },
        { status: 409 },
      );
    }

    const { error: updateError } = await supabase
      .from("commerce_digital_content")
      .update({
        mux_upload_id: null,
        mux_upload_status: "errored",
        mux_error_message:
          "The browser upload did not complete. Choose the file and try again.",
        updated_by: studioContext.userId,
        updated_at: new Date().toISOString(),
      })
      .eq("id", content.id)
      .eq("studio_id", studioContext.studioId);

    if (updateError) {
      throw new Error(updateError.message);
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Mux upload reset failed:", error);
    return NextResponse.json(
      {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "The upload state could not be reset.",
      },
      { status: 500 },
    );
  }
}


export async function PATCH(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;

    const ipRateLimit = checkRateLimit(
      rateLimitKey("commerce-mux-status:ip", getIpFromRequest(_request), id),
      { limit: 30, windowMs: 15 * 60 * 1000 },
    );
    if (!ipRateLimit.allowed) return rateLimitedJson(ipRateLimit);

    if (!UUID_PATTERN.test(id)) {
      return NextResponse.json(
        { ok: false, error: "Invalid catalog item." },
        { status: 400 },
      );
    }

    const supabase = await createClient();
    const studioContext = await getCurrentStudioContext();

    if (
      !studioContext.studioId ||
      (!studioContext.isPlatformAdmin &&
        !canManageCommerce(studioContext.studioRole))
    ) {
      return NextResponse.json(
        { ok: false, error: "You do not have permission to update this upload." },
        { status: 403 },
      );
    }

    const { data: content, error: contentError } = await supabase
      .from("commerce_digital_content")
      .select("id, mux_upload_status")
      .eq("catalog_item_id", id)
      .eq("studio_id", studioContext.studioId)
      .maybeSingle();

    if (contentError || !content) {
      return NextResponse.json(
        { ok: false, error: "Digital video was not found." },
        { status: 404 },
      );
    }

    const { error: updateError } = await supabase
      .from("commerce_digital_content")
      .update({
        mux_upload_status: "processing",
        mux_error_message: null,
        updated_by: studioContext.userId,
        updated_at: new Date().toISOString(),
      })
      .eq("id", content.id)
      .eq("studio_id", studioContext.studioId);

    if (updateError) {
      throw new Error(updateError.message);
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Mux upload completion update failed:", error);
    return NextResponse.json(
      {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "The upload status could not be updated.",
      },
      { status: 500 },
    );
  }
}
