import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveViewerInstructorId } from "@/lib/auth/instructorIdentity";
import { loadStudioClientNames } from "@/lib/staff/instructorToday";
import { canViewStudioWideSchedule } from "@/lib/staff/studioSchedule";

/**
 * Pulse command-center cards (read only). `GET /pulse?include=cards` adds `cards` to the v1 payload; without the query the response is byte-identical to v1.
 *
 * Every card:
 *  - is `null` when the viewer's role may not see it (the app shows nothing, not an error);
 *  - is `{ state: "unavailable" }` when its own query failed (one card never blanks the others);
 *  - is bounded (counts use head requests, lists are capped) and carries `truncated` where a cap applied;
 *  - names a person only for the broad roles (owner, admin, front desk), through the studio-scoped client lookup; instructors never receive client names here.
 * Tenancy: every query filters by `studio_id`, and instructor scope additionally by the viewer's resolved instructor id (never RLS alone). No card runs an action,
 * starts intake, sends anything or touches the database beyond reads.
 */

export const PULSE_LIST_LIMIT = 5;
const REQUEST_SCAN_LIMIT = 200;
const LEAD_SCAN_LIMIT = 200;
const NEW_LEAD_WINDOW_DAYS = 7;
const LOW_PACKAGE_THRESHOLD = 1;
const PACKAGE_SCAN_LIMIT = 150;

const BOOKING_REQUEST_OPEN = ["pending", "new", "in_review"];
const SELF_SERVICE_OPEN = ["pending"];
const ARIA_OPEN = ["suggested", "drafted"];

const BROAD_ROLES = new Set(["studio_owner", "studio_admin", "front_desk"]);
const ARIA_ROLES = new Set(["studio_owner", "studio_admin"]);

export type PulseCardAccess = {
  requests: "all" | "own" | null;
  leads: boolean;
  aria: boolean;
  exceptions: "all" | "own" | null;
  health: "studio" | "own" | null;
};

/** The role matrix of the audit (section 4). Anything not listed gets nothing, including roles added later. */
export function pulseCardAccess(role: string | null | undefined): PulseCardAccess {
  const broad = BROAD_ROLES.has(role ?? "");
  if (broad) {
    return { requests: "all", leads: true, aria: ARIA_ROLES.has(role ?? ""), exceptions: "all", health: "studio" };
  }
  if (role === "instructor") return { requests: "own", leads: false, aria: false, exceptions: "own", health: "own" };
  return { requests: null, leads: false, aria: false, exceptions: null, health: null };
}

export type CardEnvelope = { asOf: string; truncated: boolean };
export type Unavailable = { state: "unavailable" };

export type PulseRequestItem = {
  id: string;
  source: "booking_request" | "self_service";
  kind: "book" | "reschedule" | "cancel" | null;
  createdAt: string;
  requestedStartsAt: string | null;
  clientName: string | null;
};
export type RequestsCard = CardEnvelope & {
  state: "ok";
  bookingRequests: number;
  selfService: number;
  total: number;
  oldestCreatedAt: string | null;
  recent: PulseRequestItem[];
};

export type PulseLeadItem = { id: string; name: string; createdAt: string; sourceLabel: string; uncontacted: boolean; followUpDueAt: string | null };
export type LeadsCard = CardEnvelope & {
  state: "ok";
  newLast7Days: number;
  uncontacted: number;
  followUpsOverdue: number;
  recent: PulseLeadItem[];
};

export type PulseAriaItem = { id: string; title: string; priority: string | null; createdAt: string; ruleKey: string | null; status: string };
export type AriaCard = CardEnvelope & { state: "ok"; open: number; recent: PulseAriaItem[] };

export type ExceptionsCard = CardEnvelope & {
  state: "ok";
  cancelledToday: number;
  /** Packages with a finite item at or under the threshold. Broad roles only; null for instructors. */
  lowPackages: number | null;
};

export type HealthCard = CardEnvelope & {
  state: "ok";
  scope: "studio" | "own";
  sessionsToday: number;
  sessionsDone: number;
  sessionsAhead: number;
};

export type PulseCards = {
  requests: RequestsCard | Unavailable | null;
  leads: LeadsCard | Unavailable | null;
  aria: AriaCard | Unavailable | null;
  exceptions: ExceptionsCard | Unavailable | null;
  health: HealthCard | Unavailable | null;
};

type ClientName = { firstName: string; lastName: string };

const unavailable: Unavailable = { state: "unavailable" };

// ---------------------------------------------------------------- pure projections (unit tested)

type BookingRequestRow = { id: string; client_id: string | null; created_at: string; requested_starts_at: string | null };
type SelfServiceRow = { id: string; client_id: string | null; action_type: string | null; created_at: string; requested_starts_at: string | null };

function toKind(value: string | null | undefined): PulseRequestItem["kind"] {
  if (value === "reschedule" || value === "cancel" || value === "book") return value;
  return null;
}

/** Both queues merged oldest first for the "oldest waiting", newest first for the recent list. Names are filled in by the caller. */
export function summarizeRequests(booking: BookingRequestRow[], selfService: SelfServiceRow[]) {
  const all = [
    ...booking.map((row) => ({ id: row.id, source: "booking_request" as const, kind: "book" as const, createdAt: row.created_at, requestedStartsAt: row.requested_starts_at, clientId: row.client_id })),
    ...selfService.map((row) => ({ id: row.id, source: "self_service" as const, kind: toKind(row.action_type), createdAt: row.created_at, requestedStartsAt: row.requested_starts_at, clientId: row.client_id })),
  ];
  const byTime = [...all].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  return {
    oldestCreatedAt: byTime[0]?.createdAt ?? null,
    recent: [...byTime].reverse().slice(0, PULSE_LIST_LIMIT),
  };
}

type LeadRow = { id: string; first_name: string | null; last_name: string | null; created_at: string; referral_source: string | null; is_independent_instructor: boolean | null };
type FollowUpRow = { client_id: string; follow_up_due_at: string | null; completed_at: string | null };

const LEAD_SOURCE_LABELS: Record<string, string> = {
  public_intro_booking: "Intro booking",
  public_directory: "Directory",
  public_directory_inquiry: "Directory inquiry",
  website: "Website",
  referral: "Referral",
  walk_in: "Walk-in",
};

export function leadSourceLabel(source: string | null | undefined) {
  if (!source) return "Studio";
  return LEAD_SOURCE_LABELS[source] ?? "Other";
}

/**
 * Lead eligibility (audit decision O3, interim): `status = 'lead'` excluding event-registration origins and independent instructors. When the lead-integrity rule
 * (PR 576) lands, this single predicate is where it plugs in, so the app and the web agree.
 */
export function isPulseLead(row: Pick<LeadRow, "referral_source" | "is_independent_instructor">) {
  return row.referral_source !== "event_registration" && row.is_independent_instructor !== true;
}

export function summarizeLeads(rows: LeadRow[], activityClientIds: Set<string>, followUps: FollowUpRow[], now: Date) {
  const leads = rows.filter(isPulseLead);
  const since = now.getTime() - NEW_LEAD_WINDOW_DAYS * 86_400_000;
  const leadIds = new Set(leads.map((row) => row.id));
  const overdueClients = new Set(
    followUps
      .filter((row) => leadIds.has(row.client_id) && row.completed_at === null && row.follow_up_due_at !== null && new Date(row.follow_up_due_at).getTime() <= now.getTime())
      .map((row) => row.client_id),
  );
  const dueByClient = new Map<string, string>();
  for (const row of followUps) {
    if (!leadIds.has(row.client_id) || row.completed_at !== null || !row.follow_up_due_at) continue;
    const previous = dueByClient.get(row.client_id);
    if (!previous || new Date(row.follow_up_due_at) < new Date(previous)) dueByClient.set(row.client_id, row.follow_up_due_at);
  }
  return {
    newLast7Days: leads.filter((row) => new Date(row.created_at).getTime() >= since).length,
    uncontacted: leads.filter((row) => !activityClientIds.has(row.id)).length,
    followUpsOverdue: overdueClients.size,
    recent: leads.slice(0, PULSE_LIST_LIMIT).map(
      (row): PulseLeadItem => ({
        id: row.id,
        name: [row.first_name, row.last_name].filter(Boolean).join(" ") || "Unnamed lead",
        createdAt: row.created_at,
        sourceLabel: leadSourceLabel(row.referral_source),
        uncontacted: !activityClientIds.has(row.id),
        followUpDueAt: dueByClient.get(row.id) ?? null,
      }),
    ),
  };
}

type PackageRow = { id: string; client_package_items: { quantity_remaining: number | string | null; is_unlimited: boolean | null }[] | null };

/** A package is "low" when its finite items are all at or under the threshold (the web warns on the lowest remaining; unlimited items never count). */
export function countLowPackages(rows: PackageRow[]) {
  let low = 0;
  for (const row of rows) {
    const finite = (row.client_package_items ?? [])
      .filter((item) => item.is_unlimited !== true)
      .map((item) => (item.quantity_remaining === null ? null : Number(item.quantity_remaining)))
      .filter((value): value is number => value !== null && Number.isFinite(value));
    if (finite.length > 0 && Math.min(...finite) <= LOW_PACKAGE_THRESHOLD) low += 1;
  }
  return low;
}

export function summarizeHealth(today: { total: number; upcoming: number; cancelled: number }) {
  return { sessionsToday: today.total, sessionsAhead: today.upcoming, sessionsDone: Math.max(0, today.total - today.upcoming) };
}

// ---------------------------------------------------------------- loaders

type Ctx = { supabase: SupabaseClient; studioId: string; now: Date; instructorId: string | null };

async function namesFor(ctx: Ctx, ids: (string | null)[]): Promise<Map<string, ClientName>> {
  const clean = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  return loadStudioClientNames(ctx.supabase, ctx.studioId, clean);
}

function displayName(map: Map<string, ClientName>, id: string | null) {
  if (!id) return null;
  const name = map.get(id);
  if (!name) return null;
  const text = [name.firstName, name.lastName].filter(Boolean).join(" ");
  return text || null;
}

async function loadRequests(ctx: Ctx, scope: "all" | "own"): Promise<RequestsCard> {
  const asOf = ctx.now.toISOString();
  if (scope === "own" && !ctx.instructorId) {
    return { state: "ok", asOf, truncated: false, bookingRequests: 0, selfService: 0, total: 0, oldestCreatedAt: null, recent: [] };
  }
  let booking = ctx.supabase
    .from("booking_requests")
    .select("id, client_id, created_at, requested_starts_at")
    .eq("studio_id", ctx.studioId)
    .in("status", BOOKING_REQUEST_OPEN);
  let selfService = ctx.supabase
    .from("student_booking_action_requests")
    .select("id, client_id, action_type, created_at, requested_starts_at")
    .eq("studio_id", ctx.studioId)
    .in("status", SELF_SERVICE_OPEN);
  if (scope === "own" && ctx.instructorId) {
    booking = booking.eq("instructor_id", ctx.instructorId);
    selfService = selfService.eq("instructor_id", ctx.instructorId);
  }
  const [b, s] = await Promise.all([
    booking.order("created_at", { ascending: true }).limit(REQUEST_SCAN_LIMIT + 1),
    selfService.order("created_at", { ascending: true }).limit(REQUEST_SCAN_LIMIT + 1),
  ]);
  if (b.error) throw new Error(`Pulse requests lookup failed: ${b.error.message}`);
  if (s.error) throw new Error(`Pulse self-service lookup failed: ${s.error.message}`);
  const bRows = (b.data ?? []) as BookingRequestRow[];
  const sRows = (s.data ?? []) as SelfServiceRow[];
  const truncated = bRows.length > REQUEST_SCAN_LIMIT || sRows.length > REQUEST_SCAN_LIMIT;
  const bookingRows = bRows.slice(0, REQUEST_SCAN_LIMIT);
  const selfRows = sRows.slice(0, REQUEST_SCAN_LIMIT);
  const summary = summarizeRequests(bookingRows, selfRows);
  const names = scope === "all" ? await namesFor(ctx, summary.recent.map((item) => item.clientId)) : new Map<string, ClientName>();
  return {
    state: "ok",
    asOf,
    truncated,
    bookingRequests: bookingRows.length,
    selfService: selfRows.length,
    total: bookingRows.length + selfRows.length,
    oldestCreatedAt: summary.oldestCreatedAt,
    recent: summary.recent.map(({ clientId, ...item }) => ({ ...item, clientName: scope === "all" ? displayName(names, clientId) : null })),
  };
}

async function loadLeads(ctx: Ctx): Promise<LeadsCard> {
  const nowIso = ctx.now.toISOString();
  const { data, error } = await ctx.supabase
    .from("clients")
    .select("id, first_name, last_name, created_at, referral_source, is_independent_instructor")
    .eq("studio_id", ctx.studioId)
    .eq("status", "lead")
    .order("created_at", { ascending: false })
    .limit(LEAD_SCAN_LIMIT + 1);
  if (error) throw new Error(`Pulse leads lookup failed: ${error.message}`);
  const all = (data ?? []) as LeadRow[];
  const rows = all.slice(0, LEAD_SCAN_LIMIT);
  const ids = rows.map((row) => row.id);
  let activityClientIds = new Set<string>();
  let followUps: FollowUpRow[] = [];
  if (ids.length > 0) {
    const [activities, due] = await Promise.all([
      ctx.supabase.from("lead_activities").select("client_id").eq("studio_id", ctx.studioId).in("client_id", ids).limit(1000),
      ctx.supabase
        .from("lead_activities")
        .select("client_id, follow_up_due_at, completed_at")
        .eq("studio_id", ctx.studioId)
        .in("client_id", ids)
        .not("follow_up_due_at", "is", null)
        .is("completed_at", null)
        .limit(500),
    ]);
    if (activities.error) throw new Error(`Pulse lead activity lookup failed: ${activities.error.message}`);
    if (due.error) throw new Error(`Pulse lead follow-up lookup failed: ${due.error.message}`);
    activityClientIds = new Set(((activities.data ?? []) as { client_id: string }[]).map((row) => row.client_id));
    followUps = (due.data ?? []) as FollowUpRow[];
  }
  const summary = summarizeLeads(rows, activityClientIds, followUps, ctx.now);
  return { state: "ok", asOf: nowIso, truncated: all.length > LEAD_SCAN_LIMIT, ...summary };
}

async function loadAria(ctx: Ctx): Promise<AriaCard> {
  const [count, list] = await Promise.all([
    ctx.supabase.from("automation_actions").select("id", { count: "exact", head: true }).eq("studio_id", ctx.studioId).in("status", ARIA_OPEN),
    ctx.supabase
      .from("automation_actions")
      .select("id, rule_key, title, status, priority, created_at")
      .eq("studio_id", ctx.studioId)
      .in("status", ARIA_OPEN)
      .order("created_at", { ascending: false })
      .limit(PULSE_LIST_LIMIT),
  ]);
  if (count.error) throw new Error(`Pulse ARIA count failed: ${count.error.message}`);
  if (list.error) throw new Error(`Pulse ARIA list failed: ${list.error.message}`);
  const open = count.count ?? 0;
  return {
    state: "ok",
    asOf: ctx.now.toISOString(),
    truncated: open > PULSE_LIST_LIMIT,
    open,
    recent: ((list.data ?? []) as { id: string; rule_key: string | null; title: string | null; status: string; priority: string | null; created_at: string }[]).map((row) => ({
      id: row.id,
      title: row.title ?? "Suggestion",
      priority: row.priority,
      createdAt: row.created_at,
      ruleKey: row.rule_key,
      status: row.status,
    })),
  };
}

async function loadLowPackages(ctx: Ctx): Promise<{ count: number; truncated: boolean }> {
  const { data, error } = await ctx.supabase
    .from("client_packages")
    .select("id, client_package_items ( quantity_remaining, is_unlimited )")
    .eq("studio_id", ctx.studioId)
    .eq("active", true)
    .limit(PACKAGE_SCAN_LIMIT + 1);
  if (error) throw new Error(`Pulse packages lookup failed: ${error.message}`);
  const all = (data ?? []) as unknown as PackageRow[];
  return { count: countLowPackages(all.slice(0, PACKAGE_SCAN_LIMIT)), truncated: all.length > PACKAGE_SCAN_LIMIT };
}

/** Runs one card; a failure becomes that card's `unavailable` state and is logged without the error body (it can carry row text). */
async function guarded<T>(name: string, run: () => Promise<T>): Promise<T | Unavailable> {
  try {
    return await run();
  } catch {
    console.error(`[staff-api] pulse card "${name}" failed`);
    return unavailable;
  }
}

export async function loadPulseCards(params: {
  supabase: SupabaseClient;
  studioId: string;
  userId: string;
  studioRole: string;
  now: Date;
  /** The v1 day summary already computed for the same request (same viewer scope): health and the cancelled count come from it, so the numbers cannot disagree. */
  today: { total: number; upcoming: number; cancelled: number; truncated: boolean };
}): Promise<PulseCards> {
  const { supabase, studioId, userId, studioRole, now, today } = params;
  const access = pulseCardAccess(studioRole);
  const studioWide = canViewStudioWideSchedule(studioRole);
  let instructorId: string | null = null;
  if (!studioWide && (access.requests || access.exceptions || access.health)) {
    try {
      instructorId = await resolveViewerInstructorId(supabase, studioId, userId);
    } catch {
      instructorId = null;
    }
  }
  const ctx: Ctx = { supabase, studioId, now, instructorId };
  const asOf = now.toISOString();

  const [requests, leads, aria, exceptions] = await Promise.all([
    access.requests ? guarded("requests", () => loadRequests(ctx, access.requests as "all" | "own")) : Promise.resolve(null),
    access.leads ? guarded("leads", () => loadLeads(ctx)) : Promise.resolve(null),
    access.aria ? guarded("aria", () => loadAria(ctx)) : Promise.resolve(null),
    access.exceptions
      ? guarded("exceptions", async (): Promise<ExceptionsCard> => {
          const low = access.exceptions === "all" ? await loadLowPackages(ctx) : null;
          return {
            state: "ok",
            asOf,
            truncated: today.truncated || (low?.truncated ?? false),
            cancelledToday: today.cancelled,
            lowPackages: low ? low.count : null,
          };
        })
      : Promise.resolve(null),
  ]);

  const health: HealthCard | null = access.health
    ? { state: "ok", asOf, truncated: today.truncated, scope: access.health, ...summarizeHealth(today) }
    : null;

  return { requests, leads, aria, exceptions, health };
}
