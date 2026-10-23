import type { SupabaseClient } from "@supabase/supabase-js";
import { eventEndDateLowerBound, filterNotPastEvents } from "@/lib/events/eventTiming";

/**
 * Public Discover counts and the studio preview list, shared by the Discover hub and the homepage
 * so both show the same numbers from the same visibility rules.
 */

export type DiscoverStudioPreview = {
  id: string;
  slug: string | null;
  public_name: string | null;
  name: string;
  city: string | null;
  state: string | null;
  public_short_description: string | null;
  public_logo_url: string | null;
  public_hero_image_url: string | null;
  beginner_friendly: boolean;
};

export type DiscoverCounts = {
  studios: number;
  events: number;
  partners: number;
  jobs: number;
  marketplace: number;
};

export async function fetchDiscoverCounts(supabase: SupabaseClient, now = new Date()): Promise<DiscoverCounts> {
  const [studioCountResult, eventCountResult, partnerCountResult, jobCountResult, marketplaceCountResult] =
    await Promise.all([
      supabase
        .from("studios")
        .select("*", { count: "exact", head: true })
        .eq("public_directory_enabled", true),

      // Current and upcoming only: the date prefilter bounds the rows; the exact end-moment rule is applied below.
      supabase
        .from("events")
        .select("id, start_date, end_date, end_time, timezone")
        .eq("visibility", "public")
        .eq("public_directory_enabled", true)
        .in("status", ["published", "open"])
        .gte("end_date", eventEndDateLowerBound(now)),

      supabase
        .from("dancer_partner_profiles")
        .select("*", { count: "exact", head: true })
        .eq("visibility", "published")
        .eq("moderation_status", "approved"),

      supabase
        .from("studio_job_postings")
        .select("*", { count: "exact", head: true })
        .eq("status", "published"),

      supabase
        .from("commerce_catalog_items")
        .select("*", { count: "exact", head: true })
        .eq("active", true)
        .eq("published", true)
        .eq("marketplace_visible", true)
        .in("item_type", ["digital_video", "video_series"]),
    ]);

  return {
    studios: studioCountResult.count ?? 0,
    events: filterNotPastEvents(
      (eventCountResult.data ?? []) as Array<{ end_date: string | null; end_time: string | null; timezone: string | null }>,
      now,
    ).length,
    partners: partnerCountResult.count ?? 0,
    jobs: jobCountResult.count ?? 0,
    marketplace: marketplaceCountResult.count ?? 0,
  };
}

/** Directory-enabled studios, beginner-friendly first. */
export async function fetchDiscoverStudioPreviews(
  supabase: SupabaseClient,
  limit: number,
): Promise<DiscoverStudioPreview[]> {
  const { data, error } = await supabase
    .from("studios")
    .select(`
      id,
      slug,
      public_name,
      name,
      city,
      state,
      public_short_description,
      public_logo_url,
      public_hero_image_url,
      beginner_friendly
    `)
    .eq("public_directory_enabled", true)
    .order("beginner_friendly", { ascending: false })
    .order("public_name", { ascending: true })
    .limit(limit);

  if (error) {
    throw new Error(`Failed to load featured studios: ${error.message}`);
  }

  return (data ?? []) as DiscoverStudioPreview[];
}
