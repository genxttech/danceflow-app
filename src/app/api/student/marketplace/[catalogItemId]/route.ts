import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getStudentApiUser, normalizeStudentApiUuid } from "@/lib/auth/studentApiAuth";
import { resolveCommerceThumbnail } from "@/lib/commerce/thumbnail";

function jsonError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

function one<T>(value: T | T[] | null | undefined) {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

type Params = { params: Promise<{ catalogItemId: string }> };

export async function GET(request: NextRequest, { params }: Params) {
  const { catalogItemId } = await params;
  const id = normalizeStudentApiUuid(catalogItemId);
  if (!id) return jsonError("Marketplace item was not found.", 404);

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
      active,
      published,
      marketplace_visible,
      studios:studio_id (
        name,
        public_name,
        subscription_status,
        stripe_connect_charges_enabled,
        stripe_connect_payouts_enabled,
        stripe_connect_onboarding_complete
      ),
      commerce_digital_content (
        title,
        summary,
        instructor_name,
        skill_level,
        dance_style,
        duration_seconds,
        status,
        release_at,
        mux_upload_status,
        mux_playback_id
      )
    `)
    .eq("id", id)
    .maybeSingle();

  const studio = one((data as any)?.studios);
  const content = one((data as any)?.commerce_digital_content);
  const available =
    data?.active === true &&
    data?.published === true &&
    data?.marketplace_visible === true &&
    ["digital_video", "video_series"].includes(data?.item_type ?? "") &&
    ["active", "trialing"].includes(studio?.subscription_status ?? "") &&
    studio?.stripe_connect_charges_enabled === true &&
    studio?.stripe_connect_payouts_enabled === true &&
    studio?.stripe_connect_onboarding_complete === true &&
    content?.status === "published" &&
    (!content.release_at || new Date(content.release_at).getTime() <= Date.now()) &&
    (data?.item_type === "video_series" || content?.mux_upload_status === "ready");

  if (error || !data || !available) {
    return jsonError("Marketplace item was not found.", 404);
  }

  const thumbnail = await resolveCommerceThumbnail({
    supabase: admin,
    item: {
      id: data.id,
      item_type: data.item_type,
      image_url: data.image_url,
      commerce_digital_content: content,
    },
  });

  let owned = false;
  if (user?.id) {
    const { data: entitlement } = await admin
      .from("commerce_entitlements")
      .select("id")
      .eq("user_id", user.id)
      .eq("catalog_item_id", id)
      .in("status", ["active", "refunded_access_retained"])
      .maybeSingle();
    owned = Boolean(entitlement);
  }

  return NextResponse.json({
    id: data.id,
    studioId: data.studio_id,
    studioName: studio?.public_name?.trim() || studio?.name || "Dance studio",
    name: data.name,
    description: data.description,
    itemType: data.item_type,
    price: Number(data.price ?? 0),
    currency: String(data.currency ?? "usd").toUpperCase(),
    imageUrl: thumbnail.imageUrl,
    instructorName: content?.instructor_name ?? null,
    skillLevel: content?.skill_level ?? null,
    danceStyle: content?.dance_style ?? null,
    durationSeconds: content?.duration_seconds ?? null,
    owned,
  });
}
