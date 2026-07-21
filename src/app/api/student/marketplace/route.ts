import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getStudentApiUser } from "@/lib/auth/studentApiAuth";
import { resolveCommerceThumbnails } from "@/lib/commerce/thumbnail";

function jsonError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

function one<T>(value: T | T[] | null | undefined) {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

export async function GET(request: NextRequest) {
  const admin = createAdminClient();
  const user = await getStudentApiUser(request);

  const { data, error } = await admin
    .from("commerce_catalog_items")
    .select(`
      id,
      studio_id,
      name,
      description,
      item_type,
      price,
      currency,
      image_url,
      metadata,
      studios:studio_id (
        name,
        public_name,
        subscription_status,
        stripe_connect_charges_enabled
      ),
      commerce_digital_content (
        title,
        summary,
        instructor_name,
        skill_level,
        dance_style,
        duration_seconds,
        content_kind,
        status,
        release_at,
        mux_upload_status,
        mux_playback_id
      )
    `)
    .eq("active", true)
    .eq("published", true)
    .eq("marketplace_visible", true)
    .in("item_type", ["digital_video", "video_series"])
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) return jsonError("Marketplace could not be loaded.", 500);

  const rows = (data ?? []).filter((row: any) => {
    const studio = one(row.studios);
    const content = one(row.commerce_digital_content);
    return (
      ["active", "trialing"].includes(studio?.subscription_status ?? "") &&
      studio?.stripe_connect_charges_enabled === true &&
      content?.status === "published" &&
      (!content.release_at || new Date(content.release_at).getTime() <= Date.now()) &&
      (row.item_type === "video_series" || content.mux_upload_status === "ready")
    );
  });

  const thumbnails = await resolveCommerceThumbnails({
    supabase: admin,
    items: rows.map((row: any) => ({
      id: row.id,
      item_type: row.item_type,
      image_url: row.image_url,
      commerce_digital_content: one(row.commerce_digital_content),
    })),
  });

  let ownedIds = new Set<string>();
  if (user?.id && rows.length) {
    const { data: entitlements } = await admin
      .from("commerce_entitlements")
      .select("catalog_item_id")
      .eq("user_id", user.id)
      .in("status", ["active", "refunded_access_retained"])
      .in("catalog_item_id", rows.map((row: any) => row.id));

    ownedIds = new Set((entitlements ?? []).map((row) => row.catalog_item_id));
  }

  return NextResponse.json({
    items: rows.map((row: any) => {
      const studio = one(row.studios);
      const content = one(row.commerce_digital_content);
      return {
        id: row.id,
        studioId: row.studio_id,
        studioName: studio?.public_name?.trim() || studio?.name || "Dance studio",
        name: row.name,
        description: row.description,
        itemType: row.item_type,
        price: Number(row.price ?? 0),
        currency: String(row.currency ?? "usd").toUpperCase(),
        imageUrl: thumbnails.get(row.id)?.imageUrl ?? null,
        instructorName: content?.instructor_name ?? null,
        skillLevel: content?.skill_level ?? null,
        danceStyle: content?.dance_style ?? null,
        durationSeconds: content?.duration_seconds ?? null,
        owned: ownedIds.has(row.id),
      };
    }),
  });
}
