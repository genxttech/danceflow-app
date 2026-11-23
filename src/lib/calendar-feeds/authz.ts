/* eslint-disable @typescript-eslint/no-explicit-any -- loose PostgREST client shape */
import type { SupabaseLike } from "./events";

export type LinkedProfile = { id: string; name: string };

/** Profiles a signed-in dancer account may put in a feed: linked and allowed to view the schedule, in this studio only. */
export async function resolveDancerProfiles(admin: SupabaseLike, studioId: string, userId: string): Promise<LinkedProfile[]> {
  const { data: links, error } = await admin
    .from("client_account_links")
    .select("client_id")
    .eq("studio_id", studioId)
    .eq("user_id", userId)
    .eq("status", "linked")
    .eq("can_view_schedule", true);
  if (error || !links?.length) return [];
  const ids = links.map((l: any) => l.client_id).filter(Boolean);
  const { data: clients } = await admin.from("clients").select("id, first_name, last_name").eq("studio_id", studioId).in("id", ids);
  return (clients ?? []).map((c: any) => ({ id: c.id, name: [c.first_name, c.last_name].filter(Boolean).join(" ").trim() || "Profile" }));
}

/** null = all profiles (no restriction). Anything requested outside the allowed set is dropped; an empty result means "all". */
export function pickIncludedProfiles(requested: string[], allowed: string[]): string[] | null {
  const allowedSet = new Set(allowed);
  const chosen = [...new Set(requested)].filter((id) => allowedSet.has(id));
  if (!chosen.length || chosen.length === allowed.length) return null;
  return chosen;
}

export function parseDetail(value: unknown): "minimal" | "standard" {
  return value === "standard" ? "standard" : "minimal";
}

/**
 * Resolve the profile selection from a form. With more than one profile the person must choose at least one (an empty choice is an
 * error, never "everybody"). Choosing every profile stores null = "all profiles", including any linked later.
 */
export function resolveSelection(requested: string[], allowed: string[]): { ok: true; includeClientIds: string[] | null } | { ok: false } {
  if (allowed.length <= 1) return { ok: true, includeClientIds: null };
  const allowedSet = new Set(allowed);
  const chosen = [...new Set(requested)].filter((id) => allowedSet.has(id));
  if (!chosen.length) return { ok: false };
  return { ok: true, includeClientIds: chosen.length === allowed.length ? null : chosen };
}
