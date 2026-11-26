import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import type { createClient } from "@/lib/supabase/server";

/**
 * Server-side reads of private-lesson slots and guest coaches for visitors who have no table access of their own: the public
 * event page and the guest-coach schedule link. These use the service-role client, so every query here must name its columns
 * and be scoped to one event or one coach.
 */
type SessionClient = Awaited<ReturnType<typeof createClient>>;
type AdminClient = ReturnType<typeof createAdminClient>;

/** What a visitor may see about an open slot. Never add buyer, client, payment-reference, hold or link columns. */
export const VISITOR_SLOT_COLUMNS =
  "id, starts_at, ends_at, price, location_label, status, payment_status, event_guest_coaches:coach_id ( id, event_id, name, bio, photo_url, active )";

export const GUEST_COACH_COLUMNS =
  "id, event_id, studio_id, organizer_id, name, bio, photo_url, schedule_token_enabled, active";

export type GuestCoachAccessRow = {
  id: string;
  event_id: string;
  studio_id: string | null;
  organizer_id: string | null;
  name: string;
  bio: string | null;
  photo_url: string | null;
  schedule_token_enabled: boolean | null;
  active: boolean;
};

type ListingRow = {
  status: string | null;
  visibility: string | null;
  public_directory_enabled: boolean | null;
  studio_id: string | null;
};

type VisitorCoach = { id: string; event_id?: string; name: string; bio: string | null; photo_url: string | null; active?: boolean };
type VisitorSlot = { event_guest_coaches: VisitorCoach | VisitorCoach[] | null } & Record<string, unknown>;

/** A published, publicly listed event of a studio with an active or trial subscription. */
export async function isEventPubliclyListed(admin: AdminClient, eventId: string) {
  const { data: event, error } = await admin
    .from("events")
    .select("status, visibility, public_directory_enabled, studio_id")
    .eq("id", eventId)
    .maybeSingle<ListingRow>();
  if (error) throw new Error(`Failed to check event listing: ${error.message}`);
  if (!event?.studio_id || event.status !== "published") return false;
  if (event.visibility !== "public" && event.public_directory_enabled !== true) return false;

  const { data: studio, error: studioError } = await admin
    .from("studios")
    .select("subscription_status")
    .eq("id", event.studio_id)
    .maybeSingle<{ subscription_status: string | null }>();
  if (studioError) throw new Error(`Failed to check event host: ${studioError.message}`);
  return studio?.subscription_status === "active" || studio?.subscription_status === "trialing";
}

/** An inactive coach, or one belonging to another event, is not shown; the slot keeps no coach and the page skips it. */
function onlyThisEventsActiveCoach(slot: VisitorSlot, eventId: string) {
  const coach = Array.isArray(slot.event_guest_coaches) ? slot.event_guest_coaches[0] : slot.event_guest_coaches;
  if (!coach || coach.event_id !== eventId || (coach.active !== true)) return { ...slot, event_guest_coaches: null };
  return { ...slot, event_guest_coaches: { id: coach.id, name: coach.name, bio: coach.bio, photo_url: coach.photo_url } };
}

/**
 * Open slots for the public event page. A publicly listed event is read server-side; anything else (a preview by the event's own
 * staff) is read with the caller's session, so row-level security decides.
 */
export async function loadVisitorPrivateLessonSlots(eventId: string, session: SessionClient) {
  const admin = createAdminClient();
  const listed = await isEventPubliclyListed(admin, eventId);
  const { data, error } = await (listed ? admin : session)
    .from("event_private_lesson_slots")
    .select(VISITOR_SLOT_COLUMNS)
    .eq("event_id", eventId)
    .eq("status", "available")
    .eq("payment_status", "unpaid")
    .order("starts_at", { ascending: true });

  return { data: data ? (data as unknown as VisitorSlot[]).map((slot) => onlyThisEventsActiveCoach(slot, eventId)) : null, error };
}

/**
 * Resolves a guest-coach schedule link. Returns the coach and the client to read that coach's slots with: the service-role client
 * for a publicly listed event, otherwise the caller's session (which only the event's own staff can read through).
 */
export async function resolveGuestCoachAccess(token: string, session: SessionClient) {
  const find = (db: AdminClient | SessionClient) =>
    db
      .from("event_guest_coaches")
      .select(GUEST_COACH_COLUMNS)
      .eq("schedule_token", token)
      .eq("active", true)
      .eq("schedule_token_enabled", true)
      .maybeSingle<GuestCoachAccessRow>();

  const admin = createAdminClient();
  const { data: coach, error } = await find(admin);
  if (error || !coach) return null;
  if (await isEventPubliclyListed(admin, coach.event_id)) return { coach, db: admin };

  const own = await find(session);
  return own.data ? { coach: own.data, db: session } : null;
}
