import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { createSignedMuxThumbnailUrl } from "@/lib/mux/server";

type DigitalContentRelation = {
  mux_playback_id?: string | null;
};

type CatalogThumbnailRow = {
  id: string;
  item_type: string;
  image_url?: string | null;
  commerce_digital_content?:
    | DigitalContentRelation
    | DigitalContentRelation[]
    | null;
};

function one<T>(value: T | T[] | null | undefined) {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function muxThumbnail(playbackId: string | null | undefined) {
  if (!playbackId) return null;
  return createSignedMuxThumbnailUrl({
    playbackId,
    expiresInSeconds: 3600,
    timeSeconds: 4,
    width: 1280,
  }).url;
}

export async function resolveCommerceThumbnail(input: {
  supabase: SupabaseClient;
  item: CatalogThumbnailRow;
}) {
  const customCover = input.item.image_url?.trim();
  if (customCover) {
    return {
      imageUrl: customCover,
      source: "custom" as const,
    };
  }

  const directContent = one(input.item.commerce_digital_content);
  const directMux = muxThumbnail(directContent?.mux_playback_id);
  if (directMux) {
    return {
      imageUrl: directMux,
      source: "mux" as const,
    };
  }

  if (input.item.item_type === "video_series") {
    const { data } = await input.supabase
      .from("commerce_series_items")
      .select(`
        position,
        child_catalog_item_id,
        commerce_catalog_items!commerce_series_items_child_catalog_item_id_fkey (
          image_url,
          commerce_digital_content (
            mux_playback_id
          )
        )
      `)
      .eq("series_catalog_item_id", input.item.id)
      .eq("active", true)
      .order("position", { ascending: true })
      .limit(25);

    for (const row of data ?? []) {
      const child = one((row as any).commerce_catalog_items);
      if (child?.image_url?.trim()) {
        return {
          imageUrl: child.image_url.trim(),
          source: "series_child_custom" as const,
        };
      }

      const childContent = one(child?.commerce_digital_content);
      const childMux = muxThumbnail(childContent?.mux_playback_id);
      if (childMux) {
        return {
          imageUrl: childMux,
          source: "series_child_mux" as const,
        };
      }
    }
  }

  return {
    imageUrl: null,
    source: "fallback" as const,
  };
}

export async function resolveCommerceThumbnails(input: {
  supabase: SupabaseClient;
  items: CatalogThumbnailRow[];
}) {
  const resolved = await Promise.all(
    input.items.map(async (item) => [
      item.id,
      await resolveCommerceThumbnail({
        supabase: input.supabase,
        item,
      }),
    ] as const),
  );

  return new Map(resolved);
}
