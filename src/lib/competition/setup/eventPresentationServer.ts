import "server-only";
import type { createClient } from "@/lib/supabase/server";
import { EMPTY_PRESENTATION, type EventPresentation } from "./draft";

type Client = Awaited<ReturnType<typeof createClient>>;

const PRESENTATION_COLUMNS =
  "name, short_description, public_summary, description, public_description, cover_image_url, public_cover_image_url, public_highlights, public_registration_info";

/**
 * The event page content as the public event page shows it today (short_description, description and
 * cover_image_url, falling back to their public_* copies). It is the wizard's starting point and the baseline
 * create_competition_draft diffs against, so only fields the organizer changed are ever written.
 */
export async function readEventPresentation(supabase: Client, eventId: string): Promise<EventPresentation | null> {
  const { data } = await supabase.from("events").select(PRESENTATION_COLUMNS).eq("id", eventId).maybeSingle();
  if (!data) return null;
  const row = data as Record<string, unknown>;
  const textOf = (...keys: string[]) => keys.map((key) => row[key]).find((value): value is string => typeof value === "string" && value.trim() !== "") ?? "";
  return {
    ...EMPTY_PRESENTATION,
    name: textOf("name"),
    summary: textOf("short_description", "public_summary"),
    description: textOf("description", "public_description"),
    coverImageUrl: textOf("cover_image_url", "public_cover_image_url"),
    highlights: Array.isArray(row.public_highlights) ? row.public_highlights.filter((item): item is string => typeof item === "string") : [],
    registrationInfo: textOf("public_registration_info"),
  };
}
