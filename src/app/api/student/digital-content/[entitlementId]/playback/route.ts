import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  getStudentApiUser,
  normalizeStudentApiUuid,
} from "@/lib/auth/studentApiAuth";
import { createSignedMuxPlaybackUrl } from "@/lib/mux/server";

export const runtime = "nodejs";

type Params = {
  params: Promise<{ entitlementId: string }>;
};

type EntitlementRow = {
  id: string;
  user_id: string;
  studio_id: string;
  catalog_item_id: string;
  status: string;
  starts_at: string;
  expires_at: string | null;
};

type CatalogRow = {
  id: string;
  name: string;
  description: string | null;
  item_type: string;
  active: boolean;
  published: boolean;
};

type ContentRow = {
  catalog_item_id: string;
  title: string;
  summary: string | null;
  instructor_name: string | null;
  skill_level: string | null;
  dance_style: string | null;
  duration_seconds: number | null;
  status: string;
  release_at: string | null;
  mux_upload_status: string | null;
  mux_playback_id: string | null;
};

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

function requestIp(request: NextRequest) {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip")?.trim() ||
    null
  );
}

async function recordAccess(input: {
  entitlementId: string | null;
  catalogItemId: string | null;
  userId: string | null;
  allowed: boolean;
  reason: string;
  request: NextRequest;
}) {
  try {
    const admin = createAdminClient();
    await admin.from("commerce_playback_access_events").insert({
      entitlement_id: input.entitlementId,
      catalog_item_id: input.catalogItemId,
      user_id: input.userId,
      allowed: input.allowed,
      reason: input.reason,
      ip_address: requestIp(input.request),
      user_agent: input.request.headers.get("user-agent"),
    });
  } catch (error) {
    console.error("Playback access audit failed:", error);
  }
}

function entitlementIsActive(entitlement: EntitlementRow) {
  const now = Date.now();
  const startsAt = new Date(entitlement.starts_at).getTime();
  const expiresAt = entitlement.expires_at
    ? new Date(entitlement.expires_at).getTime()
    : null;

  return (
    ["active", "refunded_access_retained"].includes(entitlement.status) &&
    Number.isFinite(startsAt) &&
    startsAt <= now &&
    (expiresAt === null || (Number.isFinite(expiresAt) && expiresAt > now))
  );
}

export async function GET(request: NextRequest, { params }: Params) {
  const { entitlementId } = await params;
  const normalizedEntitlementId = normalizeStudentApiUuid(entitlementId);
  const requestedCatalogItemId = normalizeStudentApiUuid(
    request.nextUrl.searchParams.get("catalogItemId"),
  );
  const user = await getStudentApiUser(request);

  if (!user) {
    await recordAccess({
      entitlementId: normalizedEntitlementId,
      catalogItemId: requestedCatalogItemId,
      userId: null,
      allowed: false,
      reason: "not_authenticated",
      request,
    });
    return jsonError("Sign in to watch this content.", 401);
  }

  if (!normalizedEntitlementId) {
    await recordAccess({
      entitlementId: null,
      catalogItemId: requestedCatalogItemId,
      userId: user.id,
      allowed: false,
      reason: "invalid_entitlement_id",
      request,
    });
    return jsonError("Digital access was not found.", 404);
  }

  const admin = createAdminClient();
  const { data: entitlement, error: entitlementError } = await admin
    .from("commerce_entitlements")
    .select(
      "id, user_id, studio_id, catalog_item_id, status, starts_at, expires_at",
    )
    .eq("id", normalizedEntitlementId)
    .eq("user_id", user.id)
    .maybeSingle();

  const typedEntitlement = entitlement as EntitlementRow | null;

  if (entitlementError || !typedEntitlement) {
    await recordAccess({
      entitlementId: normalizedEntitlementId,
      catalogItemId: requestedCatalogItemId,
      userId: user.id,
      allowed: false,
      reason: "entitlement_not_found",
      request,
    });
    return jsonError("Digital access was not found.", 404);
  }

  if (!entitlementIsActive(typedEntitlement)) {
    await recordAccess({
      entitlementId: typedEntitlement.id,
      catalogItemId: requestedCatalogItemId,
      userId: user.id,
      allowed: false,
      reason: "entitlement_inactive_or_expired",
      request,
    });
    return jsonError("Your access to this content is no longer active.", 403);
  }

  const { data: parentItem, error: parentError } = await admin
    .from("commerce_catalog_items")
    .select("id, name, description, item_type, active, published")
    .eq("id", typedEntitlement.catalog_item_id)
    .maybeSingle();

  const typedParent = parentItem as CatalogRow | null;

  if (parentError || !typedParent || !typedParent.active || !typedParent.published) {
    await recordAccess({
      entitlementId: typedEntitlement.id,
      catalogItemId: typedEntitlement.catalog_item_id,
      userId: user.id,
      allowed: false,
      reason: "catalog_item_unavailable",
      request,
    });
    return jsonError("This content is not currently available.", 404);
  }

  let availableCatalogIds: string[] = [typedParent.id];

  if (typedParent.item_type === "video_series") {
    const { data: seriesRows, error: seriesError } = await admin
      .from("commerce_series_items")
      .select("child_catalog_item_id, position")
      .eq("series_catalog_item_id", typedParent.id)
      .eq("active", true)
      .order("position", { ascending: true });

    if (seriesError) {
      return jsonError("This series could not be loaded.", 500);
    }

    availableCatalogIds = (seriesRows ?? []).map(
      (row) => row.child_catalog_item_id as string,
    );
  }

  if (typedParent.item_type === "digital_download") {
    return NextResponse.json({
      entitlementId: typedEntitlement.id,
      itemType: typedParent.item_type,
      name: typedParent.name,
      description: typedParent.description,
      videos: [],
      playback: null,
      accessExpiresAt: typedEntitlement.expires_at,
    });
  }

  const { data: catalogRows, error: catalogError } = await admin
    .from("commerce_catalog_items")
    .select("id, name, description, item_type, active, published")
    .in("id", availableCatalogIds)
    .eq("active", true)
    .eq("published", true);

  if (catalogError) {
    return jsonError("Video details could not be loaded.", 500);
  }

  const { data: contentRows, error: contentError } = await admin
    .from("commerce_digital_content")
    .select(
      "catalog_item_id, title, summary, instructor_name, skill_level, dance_style, duration_seconds, status, release_at, mux_upload_status, mux_playback_id",
    )
    .in("catalog_item_id", availableCatalogIds)
    .eq("content_kind", "video");

  if (contentError) {
    return jsonError("Video details could not be loaded.", 500);
  }

  const catalogById = new Map(
    ((catalogRows ?? []) as CatalogRow[]).map((row) => [row.id, row]),
  );
  const contentByCatalogId = new Map(
    ((contentRows ?? []) as ContentRow[]).map((row) => [
      row.catalog_item_id,
      row,
    ]),
  );

  const videos = availableCatalogIds
    .map((catalogId) => {
      const catalog = catalogById.get(catalogId);
      const content = contentByCatalogId.get(catalogId);

      if (
        !catalog ||
        !content ||
        content.status !== "published" ||
        content.mux_upload_status !== "ready" ||
        !content.mux_playback_id ||
        (content.release_at &&
          new Date(content.release_at).getTime() > Date.now())
      ) {
        return null;
      }

      return {
        catalogItemId: catalog.id,
        title: content.title || catalog.name,
        summary: content.summary || catalog.description,
        instructorName: content.instructor_name,
        skillLevel: content.skill_level,
        danceStyle: content.dance_style,
        durationSeconds: content.duration_seconds,
      };
    })
    .filter(Boolean);

  const selectedCatalogItemId =
    requestedCatalogItemId && availableCatalogIds.includes(requestedCatalogItemId)
      ? requestedCatalogItemId
      : (videos[0]?.catalogItemId ?? null);

  const selectedContent = selectedCatalogItemId
    ? contentByCatalogId.get(selectedCatalogItemId)
    : null;

  if (
    requestedCatalogItemId &&
    !availableCatalogIds.includes(requestedCatalogItemId)
  ) {
    await recordAccess({
      entitlementId: typedEntitlement.id,
      catalogItemId: requestedCatalogItemId,
      userId: user.id,
      allowed: false,
      reason: "video_not_in_entitled_series",
      request,
    });
    return jsonError("That video is not included with this purchase.", 403);
  }

  let playback: {
    catalogItemId: string;
    url: string;
    expiresAt: string;
  } | null = null;

  if (
    selectedCatalogItemId &&
    selectedContent?.mux_upload_status === "ready" &&
    selectedContent.mux_playback_id
  ) {
    const signed = createSignedMuxPlaybackUrl({
      playbackId: selectedContent.mux_playback_id,
      expiresInSeconds: 900,
    });

    playback = {
      catalogItemId: selectedCatalogItemId,
      url: signed.url,
      expiresAt: signed.expiresAt,
    };

    await recordAccess({
      entitlementId: typedEntitlement.id,
      catalogItemId: selectedCatalogItemId,
      userId: user.id,
      allowed: true,
      reason: "playback_token_issued",
      request,
    });
  }

  return NextResponse.json({
    entitlementId: typedEntitlement.id,
    itemType: typedParent.item_type,
    name: typedParent.name,
    description: typedParent.description,
    videos,
    playback,
    accessExpiresAt: typedEntitlement.expires_at,
  });
}
