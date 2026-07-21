import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getStudentApiUser } from "@/lib/auth/studentApiAuth";
import { resolveCommerceThumbnails } from "@/lib/commerce/thumbnail";

function one<T>(value: T | T[] | null | undefined) {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

export async function GET(request: NextRequest) {
  const user = await getStudentApiUser(request);
  if (!user) {
    return NextResponse.json({ error: "Sign in to view digital learning." }, { status: 401 });
  }

  const admin = createAdminClient();
  const now = new Date().toISOString();

  const { data, error } = await admin
    .from("commerce_entitlements")
    .select(`
      id,
      studio_id,
      catalog_item_id,
      status,
      granted_at,
      starts_at,
      expires_at,
      commerce_catalog_items:catalog_item_id (
        name,
        description,
        item_type,
        image_url,
        active,
        published,
        commerce_digital_content (
          mux_playback_id
        )
      ),
      studios:studio_id (
        name,
        public_name
      )
    `)
    .eq("user_id", user.id)
    .in("status", ["active", "refunded_access_retained"])
    .lte("starts_at", now)
    .or(`expires_at.is.null,expires_at.gt.${now}`)
    .order("granted_at", { ascending: false });

  if (error) {
    return NextResponse.json(
      { error: "Digital learning could not be loaded." },
      { status: 500 },
    );
  }

  const entitlementIds = (data ?? []).map((row) => row.id);
  const { data: progressRows, error: progressError } = entitlementIds.length
    ? await admin
        .from("commerce_playback_progress")
        .select(
          "entitlement_id, catalog_item_id, position_seconds, duration_seconds, percent_complete, completed, completed_at, last_watched_at",
        )
        .in("entitlement_id", entitlementIds)
    : { data: [], error: null };

  if (progressError) {
    return NextResponse.json(
      { error: "Digital learning progress could not be loaded." },
      { status: 500 },
    );
  }

  const progressByEntitlement = new Map<string, any[]>();
  for (const progress of progressRows ?? []) {
    const current = progressByEntitlement.get(progress.entitlement_id) ?? [];
    current.push(progress);
    progressByEntitlement.set(progress.entitlement_id, current);
  }

  const thumbnailItems = (data ?? [])
    .map((row: any) => {
      const catalog = one(row.commerce_catalog_items);
      return catalog
        ? {
            id: row.catalog_item_id,
            item_type: catalog.item_type,
            image_url: catalog.image_url,
            commerce_digital_content: one(catalog.commerce_digital_content),
          }
        : null;
    })
    .filter(Boolean);

  const thumbnails = await resolveCommerceThumbnails({
    supabase: admin,
    items: thumbnailItems as any[],
  });

  const items = (data ?? [])
    .map((row: any) => {
      const catalog = one(row.commerce_catalog_items);
      const studio = one(row.studios);
      if (
        !catalog ||
        catalog.active !== true ||
        catalog.published !== true ||
        !["digital_video", "video_series"].includes(catalog.item_type)
      ) {
        return null;
      }

      const progress = progressByEntitlement.get(row.id) ?? [];
      const mostRecent = [...progress].sort(
        (a, b) =>
          new Date(b.last_watched_at ?? 0).getTime() -
          new Date(a.last_watched_at ?? 0).getTime(),
      )[0];
      const completedCount = progress.filter((entry) => entry.completed).length;
      const averagePercent = progress.length
        ? progress.reduce(
            (sum, entry) => sum + Number(entry.percent_complete ?? 0),
            0,
          ) / progress.length
        : 0;

      return {
        entitlementId: row.id,
        catalogItemId: row.catalog_item_id,
        studioId: row.studio_id,
        studioName: studio?.public_name?.trim() || studio?.name || "Dance studio",
        name: catalog.name,
        description: catalog.description,
        itemType: catalog.item_type,
        imageUrl: thumbnails.get(row.catalog_item_id)?.imageUrl ?? null,
        percentComplete: Number(averagePercent.toFixed(2)),
        completed: progress.length > 0 && completedCount === progress.length,
        lastWatchedAt: mostRecent?.last_watched_at ?? null,
        resumeCatalogItemId: mostRecent?.catalog_item_id ?? null,
        resumePositionSeconds: Number(mostRecent?.position_seconds ?? 0),
      };
    })
    .filter(Boolean)
    .sort((a: any, b: any) => {
      const recentA = new Date(a.lastWatchedAt ?? 0).getTime();
      const recentB = new Date(b.lastWatchedAt ?? 0).getTime();
      if (recentA !== recentB) return recentB - recentA;
      return a.name.localeCompare(b.name);
    });

  return NextResponse.json({ items });
}
