"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { canManageCommerce } from "@/lib/auth/permissions";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const DIGITAL_TYPES = new Set([
  "digital_video",
  "video_series",
  "digital_download",
]);

const SKILL_LEVELS = new Set([
  "",
  "all_levels",
  "beginner",
  "intermediate",
  "advanced",
  "professional",
]);

const CONTENT_STATUSES = new Set(["draft", "published", "archived"]);

const EXTERNAL_PROVIDERS = new Set([
  "",
  "mux",
  "vimeo",
  "youtube",
  "wistia",
  "other",
]);

function clean(value: FormDataEntryValue | null, max = 1000) {
  return typeof value === "string"
    ? value
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "")
        .replace(/[\u200B-\u200D\uFEFF]/g, "")
        .trim()
        .slice(0, max)
    : "";
}

function parseOptionalInteger(value: string, max: number) {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= max
    ? parsed
    : null;
}

function parseOptionalDateTime(value: string) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

async function requireDigitalManager(itemId: string) {
  const supabase = await createClient();
  const context = await getCurrentStudioContext();

  if (
    !context.studioId ||
    (!context.isPlatformAdmin && !canManageCommerce(context.studioRole))
  ) {
    redirect("/app");
  }

  if (!UUID_PATTERN.test(itemId)) {
    redirect("/app/catalog?error=invalid_catalog_item");
  }

  const { data: item, error } = await supabase
    .from("commerce_catalog_items")
    .select("id, item_type")
    .eq("id", itemId)
    .eq("studio_id", context.studioId)
    .maybeSingle();

  if (error || !item || !DIGITAL_TYPES.has(item.item_type)) {
    redirect("/app/catalog?error=digital_item_not_found");
  }

  return { supabase, context, item };
}

function contentPath(itemId: string, suffix = "") {
  return `/app/catalog/${itemId}/digital${suffix}`;
}

export async function saveDigitalContentAction(formData: FormData) {
  const itemId = clean(formData.get("catalogItemId"), 60);
  const { supabase, context, item } = await requireDigitalManager(itemId);

  const title = clean(formData.get("title"), 160);
  const summary = clean(formData.get("summary"), 3000);
  const skillLevel = clean(formData.get("skillLevel"), 40);
  const danceStyle = clean(formData.get("danceStyle"), 120);
  const instructorName = clean(formData.get("instructorName"), 160);
  const durationSeconds = parseOptionalInteger(
    clean(formData.get("durationSeconds"), 20),
    86400,
  );
  const thumbnailBucket = clean(formData.get("thumbnailBucket"), 100);
  const thumbnailPath = clean(formData.get("thumbnailPath"), 500);
  const mediaBucket = clean(formData.get("mediaBucket"), 100);
  const mediaPath = clean(formData.get("mediaPath"), 500);
  const downloadBucket = clean(formData.get("downloadBucket"), 100);
  const downloadPath = clean(formData.get("downloadPath"), 500);
  const externalProvider = clean(formData.get("externalProvider"), 40);
  const externalAssetId = clean(formData.get("externalAssetId"), 240);
  const externalPlaybackId = clean(formData.get("externalPlaybackId"), 240);
  const releaseAtRaw = clean(formData.get("releaseAt"), 80);
  const releaseAt = parseOptionalDateTime(releaseAtRaw);

  if (
    !title ||
    !SKILL_LEVELS.has(skillLevel) ||
    !EXTERNAL_PROVIDERS.has(externalProvider) ||
    (releaseAtRaw && !releaseAt)
  ) {
    redirect(contentPath(itemId, "?error=invalid_content_metadata"));
  }

  if (
    (thumbnailBucket && !thumbnailPath) ||
    (!thumbnailBucket && thumbnailPath) ||
    (mediaBucket && !mediaPath) ||
    (!mediaBucket && mediaPath) ||
    (downloadBucket && !downloadPath) ||
    (!downloadBucket && downloadPath)
  ) {
    redirect(contentPath(itemId, "?error=incomplete_storage_reference"));
  }

  const contentKind =
    item.item_type === "digital_video"
      ? "video"
      : item.item_type === "video_series"
        ? "series"
        : "download";

  const payload = {
    studio_id: context.studioId,
    catalog_item_id: itemId,
    content_kind: contentKind,
    title,
    summary: summary || null,
    skill_level: skillLevel || null,
    dance_style: danceStyle || null,
    instructor_name: instructorName || null,
    duration_seconds: durationSeconds,
    thumbnail_bucket: thumbnailBucket || null,
    thumbnail_path: thumbnailPath || null,
    media_bucket: mediaBucket || null,
    media_path: mediaPath || null,
    download_bucket: downloadBucket || null,
    download_path: downloadPath || null,
    ...(externalProvider || externalAssetId || externalPlaybackId
      ? {
          external_provider: externalProvider || null,
          external_asset_id: externalAssetId || null,
          external_playback_id: externalPlaybackId || null,
        }
      : {}),
    release_at: releaseAt,
    updated_by: context.userId,
    updated_at: new Date().toISOString(),
  };

  const { error } = await supabase
    .from("commerce_digital_content")
    .upsert(
      {
        ...payload,
        created_by: context.userId,
      },
      {
        onConflict: "catalog_item_id",
      },
    );

  if (error) {
    redirect(contentPath(itemId, `?error=${encodeURIComponent(error.message)}`));
  }

  await supabase
    .from("commerce_catalog_items")
    .update({
      name: title,
      updated_by: context.userId,
      updated_at: new Date().toISOString(),
    })
    .eq("id", itemId)
    .eq("studio_id", context.studioId);

  revalidatePath("/app/catalog");
  revalidatePath(contentPath(itemId));
  redirect(contentPath(itemId, "?success=content_saved"));
}

export async function setDigitalContentStatusAction(formData: FormData) {
  const itemId = clean(formData.get("catalogItemId"), 60);
  const status = clean(formData.get("status"), 40);
  const marketplaceVisible = formData.get("marketplaceVisible") === "true";
  const { supabase, context } = await requireDigitalManager(itemId);

  if (!CONTENT_STATUSES.has(status)) {
    redirect(contentPath(itemId, "?error=invalid_content_status"));
  }

  const now = new Date().toISOString();
  const published = status === "published";

  const [{ error: contentError }, { error: itemError }] = await Promise.all([
    supabase
      .from("commerce_digital_content")
      .update({
        status,
        published_at: published ? now : null,
        archived_at: status === "archived" ? now : null,
        updated_by: context.userId,
        updated_at: now,
      })
      .eq("catalog_item_id", itemId)
      .eq("studio_id", context.studioId),
    supabase
      .from("commerce_catalog_items")
      .update({
        published,
        marketplace_visible: published && marketplaceVisible,
        active: status !== "archived",
        updated_by: context.userId,
        updated_at: now,
      })
      .eq("id", itemId)
      .eq("studio_id", context.studioId),
  ]);

  if (contentError || itemError) {
    redirect(
      contentPath(
        itemId,
        `?error=${encodeURIComponent(
          contentError?.message ?? itemError?.message ?? "Status update failed.",
        )}`,
      ),
    );
  }

  revalidatePath("/app/catalog");
  revalidatePath(contentPath(itemId));
  redirect(contentPath(itemId, "?success=status_updated"));
}

export async function addSeriesItemAction(formData: FormData) {
  const seriesItemId = clean(formData.get("catalogItemId"), 60);
  const childCatalogItemId = clean(formData.get("childCatalogItemId"), 60);
  const titleOverride = clean(formData.get("titleOverride"), 160);
  const position = parseOptionalInteger(
    clean(formData.get("position"), 20),
    10000,
  );
  const { supabase, context, item } =
    await requireDigitalManager(seriesItemId);

  if (
    item.item_type !== "video_series" ||
    !UUID_PATTERN.test(childCatalogItemId) ||
    childCatalogItemId === seriesItemId ||
    position == null
  ) {
    redirect(contentPath(seriesItemId, "?error=invalid_series_item"));
  }

  const { data: child, error: childError } = await supabase
    .from("commerce_catalog_items")
    .select("id, item_type")
    .eq("id", childCatalogItemId)
    .eq("studio_id", context.studioId)
    .maybeSingle();

  if (childError || !child || child.item_type !== "digital_video") {
    redirect(contentPath(seriesItemId, "?error=video_not_found"));
  }

  const { error } = await supabase.from("commerce_series_items").upsert(
    {
      studio_id: context.studioId,
      series_catalog_item_id: seriesItemId,
      child_catalog_item_id: childCatalogItemId,
      position,
      title_override: titleOverride || null,
      active: true,
      created_by: context.userId,
      updated_by: context.userId,
      updated_at: new Date().toISOString(),
    },
    {
      onConflict: "series_catalog_item_id,child_catalog_item_id",
    },
  );

  if (error) {
    redirect(
      contentPath(seriesItemId, `?error=${encodeURIComponent(error.message)}`),
    );
  }

  revalidatePath(contentPath(seriesItemId));
  redirect(contentPath(seriesItemId, "?success=series_item_added"));
}

export async function removeSeriesItemAction(formData: FormData) {
  const seriesItemId = clean(formData.get("catalogItemId"), 60);
  const seriesLinkId = clean(formData.get("seriesLinkId"), 60);
  const { supabase, context, item } =
    await requireDigitalManager(seriesItemId);

  if (
    item.item_type !== "video_series" ||
    !UUID_PATTERN.test(seriesLinkId)
  ) {
    redirect(contentPath(seriesItemId, "?error=invalid_series_item"));
  }

  const { error } = await supabase
    .from("commerce_series_items")
    .delete()
    .eq("id", seriesLinkId)
    .eq("series_catalog_item_id", seriesItemId)
    .eq("studio_id", context.studioId);

  if (error) {
    redirect(
      contentPath(seriesItemId, `?error=${encodeURIComponent(error.message)}`),
    );
  }

  revalidatePath(contentPath(seriesItemId));
  redirect(contentPath(seriesItemId, "?success=series_item_removed"));
}
