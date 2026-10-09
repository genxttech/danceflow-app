import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isUuid } from "@/lib/competition/registrationCheckout";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = SupabaseClient<any, any, any>;

/** Resolves the buyer's cart token to its order for THIS event only (token + slug must agree). */
export async function resolveCompetitionOrderByToken(admin: Db, params: { token: string | null; eventSlug: string }) {
  if (!isUuid(params.token)) return null;
  const { data } = await admin
    .from("event_competition_registration_carts")
    .select("order_id, public_token, events:event_id(slug, name)")
    .eq("public_token", params.token)
    .maybeSingle();
  const event = Array.isArray(data?.events) ? data?.events[0] : data?.events;
  if (!data?.order_id || !event || event.slug !== params.eventSlug) return null;
  return { orderId: data.order_id as string, token: data.public_token as string, eventName: event.name as string, eventSlug: event.slug as string };
}
