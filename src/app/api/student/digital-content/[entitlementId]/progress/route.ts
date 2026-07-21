import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  getStudentApiUser,
  normalizeStudentApiUuid,
} from "@/lib/auth/studentApiAuth";
import {
  loadActiveStudentEntitlement,
  loadEntitledCatalogIds,
} from "@/lib/commerce/studentDigitalAccess";
import {
  checkRateLimit,
  getIpFromRequest,
  rateLimitKey,
  rateLimitedJson,
} from "@/lib/security/rate-limit";

type Params = {
  params: Promise<{ entitlementId: string }>;
};

type ProgressBody = {
  catalogItemId?: string;
  positionSeconds?: number;
  durationSeconds?: number;
  completed?: boolean;
};

function jsonError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

function safeSeconds(value: unknown, maximum: number) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.max(0, Math.min(maximum, Math.round(number)));
}

export async function POST(request: NextRequest, { params }: Params) {
  const rateLimit = checkRateLimit(
    rateLimitKey("student-digital-progress", getIpFromRequest(request)),
    { limit: 90, windowMs: 15 * 60 * 1000 },
  );

  if (!rateLimit.allowed) {
    return rateLimitedJson(rateLimit);
  }

  const user = await getStudentApiUser(request);
  if (!user) return jsonError("Sign in to save video progress.", 401);

  const { entitlementId } = await params;
  const normalizedEntitlementId = normalizeStudentApiUuid(entitlementId);
  const body = (await request.json().catch(() => null)) as ProgressBody | null;
  const catalogItemId = normalizeStudentApiUuid(body?.catalogItemId);

  if (!normalizedEntitlementId || !catalogItemId || !body) {
    return jsonError("Video progress request was invalid.");
  }

  const positionSeconds = safeSeconds(body.positionSeconds, 60 * 60 * 24);
  const durationSeconds = safeSeconds(body.durationSeconds, 60 * 60 * 24);

  if (positionSeconds === null || durationSeconds === null) {
    return jsonError("Video progress values were invalid.");
  }

  const admin = createAdminClient();
  const access = await loadActiveStudentEntitlement({
    admin,
    entitlementId: normalizedEntitlementId,
    userId: user.id,
  });

  if (!access.entitlement) {
    return jsonError(
      access.reason === "inactive"
        ? "Your access to this content is no longer active."
        : "Digital access was not found.",
      access.reason === "inactive" ? 403 : 404,
    );
  }

  const entitledCatalogIds = await loadEntitledCatalogIds({
    admin,
    entitlement: access.entitlement,
  });

  if (!entitledCatalogIds?.includes(catalogItemId)) {
    return jsonError("That video is not included with this purchase.", 403);
  }

  const { data: content, error: contentError } = await admin
    .from("commerce_digital_content")
    .select("catalog_item_id, duration_seconds, status, mux_upload_status")
    .eq("catalog_item_id", catalogItemId)
    .eq("content_kind", "video")
    .maybeSingle();

  if (
    contentError ||
    !content ||
    content.status !== "published" ||
    content.mux_upload_status !== "ready"
  ) {
    return jsonError("This video is not available.", 404);
  }

  const trustedDuration = Math.max(
    0,
    Math.round(Number(content.duration_seconds ?? durationSeconds ?? 0)),
  );
  const finalDuration = trustedDuration || durationSeconds;
  const finalPosition = finalDuration
    ? Math.min(positionSeconds, finalDuration)
    : positionSeconds;
  const calculatedPercent =
    finalDuration > 0
      ? Math.min(100, Math.max(0, (finalPosition / finalDuration) * 100))
      : 0;
  const completed =
    body.completed === true ||
    (finalDuration > 0 &&
      (calculatedPercent >= 90 || finalDuration - finalPosition <= 15));
  const now = new Date().toISOString();

  const { data: existing, error: existingError } = await admin
    .from("commerce_playback_progress")
    .select("id, completed, completed_at, first_watched_at")
    .eq("entitlement_id", access.entitlement.id)
    .eq("catalog_item_id", catalogItemId)
    .maybeSingle();

  if (existingError) {
    return jsonError("Video progress could not be saved.", 500);
  }

  const payload = {
    entitlement_id: access.entitlement.id,
    catalog_item_id: catalogItemId,
    user_id: user.id,
    studio_id: access.entitlement.studio_id,
    position_seconds: completed ? finalDuration : finalPosition,
    duration_seconds: finalDuration,
    percent_complete: completed ? 100 : Number(calculatedPercent.toFixed(2)),
    completed: completed || existing?.completed === true,
    completed_at:
      completed || existing?.completed === true
        ? existing?.completed_at ?? now
        : null,
    first_watched_at: existing?.first_watched_at ?? now,
    last_watched_at: now,
    metadata: {
      source: "student_app",
      completion_threshold_percent: 90,
    },
  };

  const { data: progress, error: saveError } = existing?.id
    ? await admin
        .from("commerce_playback_progress")
        .update(payload)
        .eq("id", existing.id)
        .select(
          "catalog_item_id, position_seconds, duration_seconds, percent_complete, completed, completed_at, last_watched_at",
        )
        .single()
    : await admin
        .from("commerce_playback_progress")
        .insert(payload)
        .select(
          "catalog_item_id, position_seconds, duration_seconds, percent_complete, completed, completed_at, last_watched_at",
        )
        .single();

  if (saveError || !progress) {
    return jsonError("Video progress could not be saved.", 500);
  }

  return NextResponse.json({
    catalogItemId: progress.catalog_item_id,
    positionSeconds: progress.position_seconds,
    durationSeconds: progress.duration_seconds,
    percentComplete: Number(progress.percent_complete ?? 0),
    completed: progress.completed,
    completedAt: progress.completed_at,
    lastWatchedAt: progress.last_watched_at,
  });
}
