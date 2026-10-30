import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * D7: the ONE place that decides whether an Organizer Suite add-on entitlement row
 * (public.usage_addon_entitlements, feature_key 'organizer_suite') currently grants access.
 *
 * Every reader (billing capabilities, event platform-fee tiers, event checkouts, event policy) goes
 * through `studioHasCurrentOrganizerSuiteEntitlement` / `readOrganizerSuiteEntitlement` below; do not
 * re-derive the query or the date rule elsewhere.
 *
 * Owner policy: a complimentary grant (source 'manual_grant') ends at its period_end; after that,
 * access requires a separately purchased Stripe add-on row (source 'stripe_subscription_item').
 * Nothing here extends, renews, purchases or writes anything: it only reads.
 *
 * DEFAULT BOUNDARY RULE (the exact end instant is an open owner decision; change it ONLY in
 * `entitlementEndInstant` / `entitlementStartInstant`, and keep the SQL twin
 * public.usage_addon_entitlement_is_current in step, sharing the truth table in
 * __tests__/organizerSuiteEntitlement.d7.test.ts):
 *   - status must be 'active';
 *   - period_start (a DATE), when set, is INCLUSIVE from the start (00:00) of that calendar day in the
 *     studio's timezone;
 *   - period_end (a DATE), when set, is EXCLUSIVE: the row is current while
 *     now < the start (00:00) of the period_end calendar day in the studio's timezone;
 *   - the timezone is studios.timezone; NULL, empty or an invalid IANA name falls back to UTC;
 *   - a local midnight that does not exist (DST gap) or exists twice (DST overlap) resolves to the
 *     LATER of the candidate instants, which is what PostgreSQL's `timestamp AT TIME ZONE` does;
 *   - a bound that is not a parseable YYYY-MM-DD date fails closed (row not current).
 */

export const ORGANIZER_SUITE_FEATURE_KEY = "organizer_suite";
export const ORGANIZER_SUITE_ACCESS_SOURCES = ["stripe_subscription_item", "manual_grant"] as const;
export const ENTITLEMENT_FALLBACK_TIME_ZONE = "UTC";

export type EntitlementPeriodRow = {
  status: string | null;
  period_start: string | null;
  period_end: string | null;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = SupabaseClient<any, any, any>;

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})/;
const formatterCache = new Map<string, Intl.DateTimeFormat>();

/** A usable IANA timezone, or the UTC fallback for NULL / empty / invalid values. */
export function resolveEntitlementTimeZone(timeZone: string | null | undefined): string {
  const candidate = typeof timeZone === "string" ? timeZone.trim() : "";
  if (!candidate) return ENTITLEMENT_FALLBACK_TIME_ZONE;
  try {
    getFormatter(candidate);
    return candidate;
  } catch {
    return ENTITLEMENT_FALLBACK_TIME_ZONE;
  }
}

function getFormatter(timeZone: string) {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

/** Offset (local wall clock minus UTC) in milliseconds for `timeZone` at the instant `utcMs`. */
function offsetAt(utcMs: number, timeZone: string) {
  const parts: Record<string, number> = {};
  for (const part of getFormatter(timeZone).formatToParts(new Date(utcMs))) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  const wallAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour % 24, parts.minute, parts.second);
  const flooredInstant = utcMs - (((utcMs % 1000) + 1000) % 1000);
  return wallAsUtc - flooredInstant;
}

function parseDateOnly(value: string): [number, number, number] | null {
  const match = DATE_PATTERN.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  return [year, month, day];
}

/** The instant of local 00:00 on `date` (YYYY-MM-DD) in `timeZone` (already resolved), or null if unparseable. */
export function startOfLocalDayInstant(date: string, timeZone: string): Date | null {
  const parsed = parseDateOnly(date);
  if (!parsed) return null;
  const tz = resolveEntitlementTimeZone(timeZone);
  const wallMs = Date.UTC(parsed[0], parsed[1] - 1, parsed[2]);
  // At most one offset transition lies within a day of local midnight in any real zone.
  const offsets = new Set([offsetAt(wallMs - 86_400_000, tz), offsetAt(wallMs, tz), offsetAt(wallMs + 86_400_000, tz)]);
  const candidates = [...offsets].map((offset) => wallMs - offset);
  const valid = candidates.filter((instant) => wallMs - offsetAt(instant, tz) === instant);
  return new Date(Math.max(...(valid.length ? valid : candidates)));
}

/** First instant at which a row with this period_end is NO LONGER current (exclusive end). */
export function entitlementEndInstant(periodEnd: string, timeZone: string | null | undefined): Date | null {
  return startOfLocalDayInstant(periodEnd, resolveEntitlementTimeZone(timeZone));
}

/** First instant at which a row with this period_start IS current (inclusive start). */
export function entitlementStartInstant(periodStart: string, timeZone: string | null | undefined): Date | null {
  return startOfLocalDayInstant(periodStart, resolveEntitlementTimeZone(timeZone));
}

/**
 * The boundary rule. Pure: no I/O. `timeZone` is studios.timezone (NULL / invalid -> UTC).
 * Fails closed (false) on an unparseable bound.
 */
export function isEntitlementCurrent(
  row: EntitlementPeriodRow,
  timeZone: string | null | undefined,
  now: Date = new Date(),
): boolean {
  if (row.status !== "active") return false;
  const nowMs = now.getTime();

  if (row.period_start) {
    const start = entitlementStartInstant(row.period_start, timeZone);
    if (!start || nowMs < start.getTime()) return false;
  }

  if (row.period_end) {
    const end = entitlementEndInstant(row.period_end, timeZone);
    if (!end || nowMs >= end.getTime()) return false;
  }

  return true;
}

export type StudioEntitlementRow = {
  studio_id: string | null;
  status: string | null;
  period_start?: string | null;
  period_end?: string | null;
};

/**
 * Display/count helper for readers that load many studios' add-on rows at once (platform analytics and
 * accounting). Pure: no I/O. Keeps only rows that are current under `isEntitlementCurrent`, using each
 * row's studio timezone from `timezoneByStudioId` (a studio missing from the map, or a NULL / invalid
 * value, falls back to UTC exactly like the shared reader).
 *
 * Status is compared trimmed and lower-cased, as those pages always did, so a row with no period bound
 * counts exactly as before: active means active, regardless of source.
 */
export function filterCurrentEntitlements<T extends StudioEntitlementRow>(
  rows: readonly T[],
  timezoneByStudioId: ReadonlyMap<string, string | null | undefined>,
  now: Date = new Date(),
): T[] {
  return rows.filter((row) => {
    if ((row.status ?? "").trim().toLowerCase() !== "active") return false;
    const periodStart = row.period_start ?? null;
    const periodEnd = row.period_end ?? null;
    if (!periodStart && !periodEnd) return true;
    const timeZone = row.studio_id ? timezoneByStudioId.get(row.studio_id) : null;
    return isEntitlementCurrent({ status: "active", period_start: periodStart, period_end: periodEnd }, timeZone, now);
  });
}

export type OrganizerSuiteEntitlementRead =
  | { ok: true; current: boolean }
  | { ok: false; current: false; error: { message: string } };

/**
 * Reads the studio's active Organizer Suite rows (Stripe add-on item or manual grant) through the
 * caller's own client (session or service role: the caller decides) and applies the boundary rule.
 * studios.timezone is read only when a candidate row has a period bound. A failed timezone read
 * falls back to UTC (logged); a failed entitlement read is returned as `ok: false`.
 */
export async function readOrganizerSuiteEntitlement(
  client: Db,
  studioId: string,
  now: Date = new Date(),
): Promise<OrganizerSuiteEntitlementRead> {
  const { data, error } = await client
    .from("usage_addon_entitlements")
    .select("id, status, period_start, period_end")
    .eq("studio_id", studioId)
    .eq("feature_key", ORGANIZER_SUITE_FEATURE_KEY)
    .in("source", [...ORGANIZER_SUITE_ACCESS_SOURCES])
    .eq("status", "active")
    .limit(50);

  if (error) {
    return { ok: false, current: false, error: { message: String((error as { message?: unknown }).message ?? "unknown") } };
  }

  const rows = ((data ?? []) as Array<Partial<EntitlementPeriodRow>>).map((row) => ({
    status: row.status ?? "active",
    period_start: row.period_start ?? null,
    period_end: row.period_end ?? null,
  }));
  if (!rows.length) return { ok: true, current: false };

  if (rows.some((row) => row.status === "active" && !row.period_start && !row.period_end)) {
    return { ok: true, current: true };
  }

  let timeZone: string | null = null;
  const { data: studio, error: studioError } = await client
    .from("studios")
    .select("timezone")
    .eq("id", studioId)
    .maybeSingle();

  if (studioError) {
    console.error("Organizer Suite entitlement: studio timezone read failed; using UTC");
  } else {
    timeZone = (studio as { timezone?: string | null } | null)?.timezone ?? null;
  }

  return { ok: true, current: rows.some((row) => isEntitlementCurrent(row, timeZone, now)) };
}

/**
 * Boolean form for callers that fail closed: a read error logs and returns false (no access, no
 * discounted fee tier), exactly like the inline queries this replaces.
 */
export async function studioHasCurrentOrganizerSuiteEntitlement(
  client: Db,
  studioId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const result = await readOrganizerSuiteEntitlement(client, studioId, now);
  if (!result.ok) {
    console.error("Failed to read Organizer Suite add-on entitlement", result.error);
    return false;
  }
  return result.current;
}
