import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type { ManageableDancer } from "@/lib/public/classRegistration";

/*
  GC-3.4B-1 server-side reads for the class identity step. Service role, with
  every filter derived from the session user and the class's authoritative
  studio, never from the browser.
*/

type ManageableLinkRow = {
  client_id: string;
  studio_id: string;
  relationship_type: string | null;
  is_primary: boolean | null;
  created_at: string | null;
  clients:
    | { id: string; studio_id: string; first_name: string | null; last_name: string | null }
    | { id: string; studio_id: string; first_name: string | null; last_name: string | null }[]
    | null;
};

/**
 * The dancers this account may act for at this studio: its own `linked`
 * relationships with `can_manage_bookings = true` whose client record belongs
 * to the same studio. Primary relationship first, then oldest (the portal's
 * order).
 */
export async function listManageableDancers(params: {
  userId: string;
  studioId: string;
}): Promise<ManageableDancer[]> {
  if (!params.userId || !params.studioId) return [];

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("client_account_links")
    .select(`
      client_id,
      studio_id,
      relationship_type,
      is_primary,
      created_at,
      clients (
        id,
        studio_id,
        first_name,
        last_name
      )
    `)
    .eq("user_id", params.userId)
    .eq("studio_id", params.studioId)
    .eq("status", "linked")
    .eq("can_manage_bookings", true);

  if (error) {
    throw new Error("Studio relationship lookup failed.");
  }

  const seen = new Set<string>();
  return ((data ?? []) as ManageableLinkRow[])
    .slice()
    .sort((a, b) => {
      if ((a.is_primary === true) !== (b.is_primary === true)) return a.is_primary === true ? -1 : 1;
      return new Date(a.created_at ?? 0).getTime() - new Date(b.created_at ?? 0).getTime();
    })
    .flatMap((row) => {
      const client = Array.isArray(row.clients) ? row.clients[0] ?? null : row.clients;
      // Studio isolation: the link and its client must both belong to this studio.
      if (!client || row.studio_id !== params.studioId || client.studio_id !== params.studioId) return [];
      if (client.id !== row.client_id || seen.has(client.id)) return [];
      seen.add(client.id);
      const displayName =
        [client.first_name, client.last_name].filter(Boolean).join(" ").trim() || "Your student record";
      return [{ clientId: client.id, displayName, isSelf: row.relationship_type === "self" }];
    });
}

/** The studio id behind a public class's canonical slug (the public read model exposes only the slug). */
export async function getStudioIdForPublicSlug(studioSlug: string): Promise<string | null> {
  const admin = createAdminClient();
  const { data, error } = await admin.from("studios").select("id").eq("slug", studioSlug).maybeSingle();
  if (error || !data?.id) return null;
  return String(data.id);
}
