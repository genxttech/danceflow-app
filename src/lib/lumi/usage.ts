import { getIncludedUsageAllowance } from "@/lib/usage/addons";
import type { LumiPortalAccess } from "@/lib/lumi/portal";

/**
 * LUMI usage accounting (dancer-initiated provider calls).
 *
 * Why this is not `record_usage_event`: that RPC requires `auth.uid()` AND an active `user_studio_roles` row for the studio, so a
 * dancer (or the service-role client the portal uses) can never satisfy it. Every LUMI usage record was silently failing, i.e. LUMI
 * was unmetered. LUMI therefore writes its own rows into `usage_events` through the service-role client the portal already uses
 * (tenant scoping is explicit in every query), under its OWN feature key.
 *
 * Why a separate feature key (`lumi_action`, not `ai_action`): `ai_action` is the studio operational AI allowance (lesson recaps,
 * follow-ups, campaign drafts). A dancer must never be able to consume it. The existing plan numbers (growth 200 / pro 500 /
 * credit-pack add-ons) are reused unchanged as the size of the LUMI pool; no allowance size or billing rule changes.
 *
 * Concurrency (no SQL): reserve-then-verify. A request first INSERTs a `reserved` row, then counts the rows that exist (its own
 * included) and only proceeds if the counts are within the caps; otherwise it marks its own row `released` and refuses. Because
 * every request inserts before it counts, parallel requests can only over-refuse, never over-admit past a cap. A failed provider
 * call releases the row; a call that reached the provider is settled (counted) even when the output could not be parsed.
 *
 * Known limit: the monthly-summary trigger fires on insert and does not un-count a released row, so `usage_monthly_summaries` for
 * `lumi_action` can read higher than the true count. Enforcement reads `usage_events` rows (state filter), never the summary.
 */

export const LUMI_USAGE_FEATURE_KEY = "lumi_action";
export const LUMI_USAGE_SOURCE = "lumi_journey_assistant";

function intFromEnv(name: string, fallback: number) {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Hard per-dancer ceilings (per studio relationship). Tunable by env; defaults are generous for legitimate use. */
export function lumiDancerCaps() {
  return {
    perDay: intFromEnv("LUMI_MAX_REQUESTS_PER_DANCER_PER_DAY", 10),
    perMonth: intFromEnv("LUMI_MAX_REQUESTS_PER_DANCER_PER_MONTH", 60),
  };
}

function periodOf(now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return {
    periodStart: start.toISOString().slice(0, 10),
    periodEnd: end.toISOString().slice(0, 10),
    dayStartIso: dayStart.toISOString(),
  };
}

const COUNTED_STATES = ["reserved", "settled"];

async function studioPoolTotal(access: LumiPortalAccess) {
  const { data: entitlements } = await access.admin
    .from("usage_addon_entitlements")
    .select("quantity_included")
    .eq("studio_id", access.studio.id)
    .eq("feature_key", "ai_action")
    .eq("status", "active");
  const addon = (entitlements ?? []).reduce((sum, row) => sum + Math.max(0, row.quantity_included ?? 0), 0);
  return getIncludedUsageAllowance({ planCode: access.planCode, featureKey: "ai_action" }) + addon;
}

async function countRows(access: LumiPortalAccess, extra: { clientId?: string; sinceIso?: string }) {
  const { periodStart } = periodOf();
  let query = access.admin
    .from("usage_events")
    .select("id", { count: "exact", head: true })
    .eq("studio_id", access.studio.id)
    .eq("feature_key", LUMI_USAGE_FEATURE_KEY)
    .eq("period_start", periodStart)
    .in("metadata->>state", COUNTED_STATES);
  if (extra.clientId) query = query.eq("related_id", extra.clientId);
  if (extra.sinceIso) query = query.gte("created_at", extra.sinceIso);
  const { count, error } = await query;
  if (error) return null;
  return count ?? 0;
}

export type LumiUsageRefusal = "pool_exhausted" | "dancer_daily" | "dancer_monthly" | "unavailable";

export type LumiUsageSnapshot = {
  allowed: boolean;
  used: number;
  total: number;
  dancerToday: number;
  dancerMonth: number;
  reason?: LumiUsageRefusal;
};

/** Read-only pre-check (early, friendly refusal). The authoritative check is `reserveLumiUsage`. */
export async function getLumiUsageSnapshot(access: LumiPortalAccess): Promise<LumiUsageSnapshot> {
  const caps = lumiDancerCaps();
  const { dayStartIso } = periodOf();
  const [total, used, dancerMonth, dancerToday] = await Promise.all([
    studioPoolTotal(access),
    countRows(access, {}),
    countRows(access, { clientId: access.client.id }),
    countRows(access, { clientId: access.client.id, sinceIso: dayStartIso }),
  ]);
  if (used === null || dancerMonth === null || dancerToday === null) {
    return { allowed: false, used: 0, total, dancerToday: 0, dancerMonth: 0, reason: "unavailable" };
  }
  const reason: LumiUsageRefusal | undefined =
    total <= 0 || used >= total
      ? "pool_exhausted"
      : dancerToday >= caps.perDay
        ? "dancer_daily"
        : dancerMonth >= caps.perMonth
          ? "dancer_monthly"
          : undefined;
  return { allowed: access.allowed && !reason, used, total, dancerToday, dancerMonth, reason };
}

export function lumiRefusalMessage(reason: LumiUsageRefusal | undefined) {
  switch (reason) {
    case "dancer_daily":
      return "You have reached today's LUMI limit. Please try again tomorrow.";
    case "dancer_monthly":
      return "You have reached this month's LUMI limit. It renews next month.";
    case "unavailable":
      return "LUMI could not check its usage right now. Please try again shortly.";
    default:
      return "Your studio's monthly AI allowance has been used. Try again after it renews.";
  }
}

export type LumiReservation = { ok: true; id: string } | { ok: false; reason: LumiUsageRefusal };

/** Reserve one LUMI request BEFORE the provider call. */
export async function reserveLumiUsage(access: LumiPortalAccess, task: string): Promise<LumiReservation> {
  if (!access.allowed) return { ok: false, reason: "unavailable" };
  const { periodStart, periodEnd, dayStartIso } = periodOf();
  const { data: inserted, error } = await access.admin
    .from("usage_events")
    .insert({
      studio_id: access.studio.id,
      organizer_id: null,
      workspace_type: "studio",
      feature_key: LUMI_USAGE_FEATURE_KEY,
      quantity: 1,
      source: LUMI_USAGE_SOURCE,
      related_table: "clients",
      related_id: access.client.id,
      metadata: { task, state: "reserved" },
      period_start: periodStart,
      period_end: periodEnd,
    })
    .select("id")
    .single();

  if (error || !inserted?.id) {
    console.error("LUMI usage reservation failed", error?.message);
    return { ok: false, reason: "unavailable" };
  }

  const caps = lumiDancerCaps();
  const [total, used, dancerMonth, dancerToday] = await Promise.all([
    studioPoolTotal(access),
    countRows(access, {}),
    countRows(access, { clientId: access.client.id }),
    countRows(access, { clientId: access.client.id, sinceIso: dayStartIso }),
  ]);

  // Counts include this request's own reserved row.
  let reason: LumiUsageRefusal | null = null;
  if (used === null || dancerMonth === null || dancerToday === null) reason = "unavailable";
  else if (total <= 0 || used > total) reason = "pool_exhausted";
  else if (dancerToday > caps.perDay) reason = "dancer_daily";
  else if (dancerMonth > caps.perMonth) reason = "dancer_monthly";

  if (reason) {
    await releaseLumiUsage(access, inserted.id, task);
    return { ok: false, reason };
  }
  return { ok: true, id: inserted.id };
}

async function setState(access: LumiPortalAccess, id: string, state: "settled" | "released", task: string, extra: Record<string, unknown>) {
  const { error } = await access.admin
    .from("usage_events")
    .update({ metadata: { task, state, ...extra } })
    .eq("id", id)
    .eq("studio_id", access.studio.id)
    .eq("related_id", access.client.id)
    .eq("feature_key", LUMI_USAGE_FEATURE_KEY);
  if (error) console.error("LUMI usage state update failed", state, error.message);
  return !error;
}

/** The provider was reached (billable): keep the row counted. */
export function settleLumiUsage(access: LumiPortalAccess, id: string, task: string, extra: Record<string, unknown> = {}) {
  return setState(access, id, "settled", task, extra);
}

/** The provider was NOT reached or rejected the call: give the capacity back. */
export function releaseLumiUsage(access: LumiPortalAccess, id: string, task: string) {
  return setState(access, id, "released", task, {});
}
