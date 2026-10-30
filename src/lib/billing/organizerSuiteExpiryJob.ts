import type { SupabaseClient } from "@supabase/supabase-js";
import { ORGANIZER_SUITE_FEATURE_KEY, entitlementEndInstant } from "@/lib/billing/organizerSuiteEntitlement";

/**
 * D7: dated expiry of complimentary Organizer Suite grants (source 'manual_grant').
 *
 * Owner policy: a complimentary grant ends on its period_end; afterwards access needs a separately purchased paid add-on
 * (a Stripe-sourced row). This job only flips due grants to status 'expired' through the service-role-only RPC
 * public.expire_due_usage_addon_entitlements (migration 20270203090000). It never purchases, charges, extends, creates or
 * deletes anything, and it never touches Stripe-sourced rows. The audit trigger records one status_change event per expired
 * row with the function's reason/actor.
 *
 * DARK BY DEFAULT: the route answers 404 unless ORGANIZER_SUITE_EXPIRY_ENABLED is exactly "true", and it is NOT registered in
 * vercel.json. See docs/billing/ORGANIZER-SUITE-EXPIRY-JOB.md.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = SupabaseClient<any, any, any>;

export const ORGANIZER_SUITE_EXPIRY_RPC = "expire_due_usage_addon_entitlements";
export const ORGANIZER_SUITE_EXPIRY_ROUTE = "/api/cron/organizer-suite-entitlement-expiry";

/**
 * SUGGESTED cadence (documentation only, nothing registers it): hourly at minute 7. The exact end instant is local midnight
 * of period_end in the studio's timezone, which falls on a different UTC hour per timezone (and shifts with DST), so a daily
 * run at a fixed UTC hour would leave a grant usable for up to ~24 hours past its end. Hourly bounds that lag to under an
 * hour; readers already apply the same boundary rule at request time, so the job only reconciles the stored status.
 */
export const ORGANIZER_SUITE_EXPIRY_SUGGESTED_SCHEDULE = "7 * * * *";

/** The feature switch: anything other than the exact string "true" keeps the job dark. */
export function isOrganizerSuiteExpiryEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.ORGANIZER_SUITE_EXPIRY_ENABLED === "true";
}

/** Dry-run is on when the env forces it (exactly "true") or the caller asks with ?dry_run=1|true. A caller can never turn an env-forced dry-run off. */
export function isOrganizerSuiteExpiryDryRun(url: string, env: Record<string, string | undefined> = process.env): boolean {
  if (env.ORGANIZER_SUITE_EXPIRY_DRY_RUN === "true") return true;
  let value: string | null = null;
  try {
    value = new URL(url).searchParams.get("dry_run");
  } catch {
    return true; // unparseable URL: fail safe, change nothing
  }
  return value === "1" || value === "true";
}

const CRON_FIELD_RANGES: Array<[number, number]> = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];

/**
 * Sanity check for a 5-field cron schedule meant for this job (numbers, '*', ranges, steps and lists only; no names or
 * macros). It also refuses schedules that run more often than hourly (a '*' or step in the minute field) or less often than
 * daily (a restricted day-of-month, month or day-of-week), because the end instant is a local midnight in any timezone.
 */
export function validateOrganizerSuiteExpirySchedule(schedule: string | null | undefined): { ok: true } | { ok: false; reason: string } {
  const fields = String(schedule ?? "").trim().split(/\s+/);
  if (fields.length !== 5 || fields[0] === "") return { ok: false, reason: "expected 5 cron fields" };
  for (let i = 0; i < 5; i += 1) {
    const [min, max] = CRON_FIELD_RANGES[i];
    for (const part of fields[i].split(",")) {
      const match = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
      if (!match) return { ok: false, reason: `field ${i + 1} is not a numeric cron field` };
      const [lo, hi, step] = [match[2], match[3], match[4]].map((n) => (n === undefined ? undefined : Number(n)));
      if (lo !== undefined && (lo < min || lo > max)) return { ok: false, reason: `field ${i + 1} out of range` };
      if (hi !== undefined && (hi < min || hi > max || hi < (lo ?? min))) return { ok: false, reason: `field ${i + 1} out of range` };
      if (step !== undefined && step < 1) return { ok: false, reason: `field ${i + 1} has a zero step` };
    }
  }
  if (!/^\d+$/.test(fields[0])) return { ok: false, reason: "minute must be a single fixed minute (at most hourly)" };
  if (fields[2] !== "*" || fields[3] !== "*" || fields[4] !== "*") return { ok: false, reason: "must run at least daily (day, month and weekday must be '*')" };
  return { ok: true };
}

export type ExpiryErrorKind = "migration_not_applied" | "expiry_failed";

export type OrganizerSuiteExpiryOutcome =
  | { ok: true; dryRun: false; asOf: string; expiredCount: number }
  | { ok: true; dryRun: true; asOf: string; wouldExpireCount: number }
  | { ok: false; dryRun: boolean; asOf: string; error: ExpiryErrorKind };

type DbError = { code?: string | null; message?: string | null } | null | undefined;

/** PostgREST answers PGRST202 for an RPC missing from its schema cache; Postgres answers 42883 for an undefined function. */
export function isMissingFunctionError(error: DbError): boolean {
  const code = String(error?.code ?? "");
  if (code === "PGRST202" || code === "42883") return true;
  return /function .*expire_due_usage_addon_entitlements.* does not exist|Could not find the function/i.test(String(error?.message ?? ""));
}

/** Calls the mutating RPC exactly once. Success is claimed only when the RPC returned without error. */
export async function runOrganizerSuiteExpiry(client: Db, asOf: Date): Promise<OrganizerSuiteExpiryOutcome> {
  const asOfIso = asOf.toISOString();
  const { data, error } = await client.rpc(ORGANIZER_SUITE_EXPIRY_RPC, { p_as_of: asOfIso, p_feature_key: ORGANIZER_SUITE_FEATURE_KEY });
  if (error) {
    return { ok: false, dryRun: false, asOf: asOfIso, error: isMissingFunctionError(error) ? "migration_not_applied" : "expiry_failed" };
  }
  if (data !== null && data !== undefined && !Array.isArray(data)) return { ok: false, dryRun: false, asOf: asOfIso, error: "expiry_failed" };
  return { ok: true, dryRun: false, asOf: asOfIso, expiredCount: Array.isArray(data) ? data.length : 0 };
}

const PAGE_SIZE = 1000;

type CandidateRow = { id: string; studio_id: string | null; organizer_id: string | null; period_end: string | null };

/**
 * Read-only twin of the RPC's selection, for dry-run: active manual grants of the feature whose end instant (the shared TS
 * boundary rule, entitlementEndInstant) is <= asOf. Timezone comes from the studio (directly, or via organizers.studio_id).
 * Only SELECTs; never calls the mutating RPC.
 */
export async function countDueOrganizerSuiteGrants(client: Db, asOf: Date): Promise<OrganizerSuiteExpiryOutcome> {
  const asOfIso = asOf.toISOString();
  const fail = (): OrganizerSuiteExpiryOutcome => ({ ok: false, dryRun: true, asOf: asOfIso, error: "expiry_failed" });
  // Pre-filter: no timezone puts local midnight of a date more than 14h before that date's UTC midnight, so any due row has
  // period_end <= asOf's UTC date + 1 day. Two days keeps a margin; the exact rule runs below.
  const cutoff = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate() + 2)).toISOString().slice(0, 10);

  const rows: CandidateRow[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await client
      .from("usage_addon_entitlements")
      .select("id, studio_id, organizer_id, period_end")
      .eq("source", "manual_grant")
      .eq("status", "active")
      .eq("feature_key", ORGANIZER_SUITE_FEATURE_KEY)
      .not("period_end", "is", null)
      .lte("period_end", cutoff)
      .order("id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) return fail();
    const page = (data ?? []) as CandidateRow[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  if (!rows.length) return { ok: true, dryRun: true, asOf: asOfIso, wouldExpireCount: 0 };

  const organizerIds = [...new Set(rows.map((r) => r.organizer_id).filter((v): v is string => Boolean(v)))];
  const organizerStudio = new Map<string, string | null>();
  if (organizerIds.length) {
    const { data, error } = await client.from("organizers").select("id, studio_id").in("id", organizerIds);
    if (error) return fail();
    for (const o of (data ?? []) as Array<{ id: string; studio_id: string | null }>) organizerStudio.set(o.id, o.studio_id);
  }

  const studioIdOf = (r: CandidateRow) => r.studio_id ?? (r.organizer_id ? organizerStudio.get(r.organizer_id) ?? null : null);
  const studioIds = [...new Set(rows.map(studioIdOf).filter((v): v is string => Boolean(v)))];
  const studioTz = new Map<string, string | null>();
  if (studioIds.length) {
    const { data, error } = await client.from("studios").select("id, timezone").in("id", studioIds);
    if (error) return fail();
    for (const s of (data ?? []) as Array<{ id: string; timezone: string | null }>) studioTz.set(s.id, s.timezone);
  }

  const asOfMs = asOf.getTime();
  let wouldExpireCount = 0;
  for (const row of rows) {
    if (!row.period_end) continue;
    const studioId = studioIdOf(row);
    const end = entitlementEndInstant(row.period_end, studioId ? studioTz.get(studioId) ?? null : null);
    if (end && end.getTime() <= asOfMs) wouldExpireCount += 1;
  }
  return { ok: true, dryRun: true, asOf: asOfIso, wouldExpireCount };
}
