import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Recurring SMS service charges (phone-number rent, campaign monthly fee): owner authorization, the read side for the screens, and the scheduler core.
 * Authorization and funding are decided by the database; nothing in this module can charge a card, top up credit, or release a phone number.
 */
type Client = Pick<SupabaseClient, "rpc">;

export const RECURRING_KINDS = ["number", "monthly"] as const;
export type RecurringKind = (typeof RECURRING_KINDS)[number];
export const RECURRING_TERMS = [1, 3, 6, 12] as const;

export const RECURRING_KIND_LABEL: Record<RecurringKind, string> = { number: "texting phone number rent", monthly: "monthly texting service" };

export function smsRecurringAuthorizationEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return String(env.SMS_RECURRING_AUTHORIZATION ?? "").trim().toLowerCase() === "on";
}

export const isRecurringKind = (value: unknown): value is RecurringKind => typeof value === "string" && (RECURRING_KINDS as readonly string[]).includes(value);

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/**
 * The acknowledgement shown to the owner before they agree. The database builds the identical text itself when it records the authorization (a caller can
 * never supply it), and a test pins the two together.
 */
export function buildAuthorizationStatement(input: { kind: RecurringKind; priceCents: number; termMonths: number; totalLimitCents: number }): string {
  const { kind, priceCents, termMonths, totalLimitCents } = input;
  return [
    `I authorize DanceFlow to deduct ${usd(priceCents)} per month for ${RECURRING_KIND_LABEL[kind]} from my legal business's prepaid texting credit,`,
    `for up to ${termMonths} month${termMonths === 1 ? "" : "s"} and no more than ${usd(totalLimitCents)} in total, whichever comes first.`,
    "The first month's charge is set aside from my prepaid credit now.",
    "The charge is taken only if enough settled credit is available and it fits within my business's monthly spending limit. No card is charged, no credit is added automatically, and I can revoke this at any time.",
    "Final prices and terms are pending approval.",
  ].join(" ");
}

export type RecurringErrorCode = "not_authorized" | "no_legal_business" | "price_changed" | "already_authorized" | "invalid" | "pilot_business" | "monthly_limit" | "insufficient_credit" | "unavailable";
export class RecurringError extends Error {
  constructor(public readonly code: RecurringErrorCode, message: string) {
    super(message);
    this.name = "RecurringError";
  }
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : 0);

export type RecurringServiceState = "none" | "active" | "past_due" | "suspended";
/** Why the oldest unpaid period is unpaid: the owner's next step depends on it. */
export type RecurringServiceIssue = "unfunded" | "held" | "cap" | "limit" | "price" | "waiting" | null;
export type RecurringAuthorization = {
  id: string;
  kind: RecurringKind;
  priceCents: number;
  termMonths: number;
  totalLimitCents: number;
  spentCents: number;
  expiresAt: string;
  status: "active" | "revoked";
  thisLocation: boolean;
  lastStatus: "charged" | "unfunded" | "held" | "refused" | null;
  lastPeriod: string | null;
};
export type RecurringOverview = {
  legalBusiness: boolean;
  expectedMonthlyCents: number;
  availableCents: number;
  monthsCovered: number | null;
  lowForRecurring: boolean;
  onHold: boolean;
  /** The founder-authorized pilot business: recurring fees there are approved one operation at a time, never by a standing authorization. */
  pilotBusiness: boolean;
  serviceState: RecurringServiceState;
  serviceIssue: RecurringServiceIssue;
  authorizations: RecurringAuthorization[];
};

const SERVICE_STATES = new Set<string>(["none", "active", "past_due", "suspended"]);
const CHARGE_STATUSES = new Set<string>(["charged", "unfunded", "held", "refused"]);
const SERVICE_ISSUES = new Set<string>(["unfunded", "held", "cap", "limit", "price", "waiting"]);

export function parseRecurringOverview(data: unknown): RecurringOverview {
  const o = obj(data);
  const list = Array.isArray(o.authorizations) ? o.authorizations : [];
  return {
    legalBusiness: o.legal_business === true,
    expectedMonthlyCents: num(o.expected_monthly_cents),
    availableCents: num(o.available_cents),
    monthsCovered: o.months_covered == null ? null : num(o.months_covered),
    lowForRecurring: o.low_for_recurring === true,
    onHold: o.on_hold === true,
    pilotBusiness: o.pilot_business === true,
    serviceState: SERVICE_STATES.has(String(o.service_state)) ? (o.service_state as RecurringServiceState) : "none",
    serviceIssue: SERVICE_ISSUES.has(String(o.service_issue)) ? (o.service_issue as RecurringServiceIssue) : null,
    authorizations: list.flatMap((row) => {
      const r = obj(row);
      if (!isRecurringKind(r.kind) || (r.status !== "active" && r.status !== "revoked") || typeof r.id !== "string") return [];
      return [
        {
          id: r.id,
          kind: r.kind,
          priceCents: num(r.price_cents),
          termMonths: num(r.term_months),
          totalLimitCents: num(r.total_limit_cents),
          spentCents: num(r.spent_cents),
          expiresAt: String(r.expires_at ?? ""),
          status: r.status,
          thisLocation: r.this_location === true,
          lastStatus: CHARGE_STATUSES.has(String(r.last_status)) ? (r.last_status as RecurringAuthorization["lastStatus"]) : null,
          lastPeriod: typeof r.last_period === "string" ? r.last_period : null,
        },
      ];
    }),
  };
}

/** Null when the caller may not see it or the feature is not installed in this environment. */
export async function getRecurringOverview(supabase: Client, studioId: string): Promise<RecurringOverview | null> {
  const { data, error } = await supabase.rpc("sms_recurring_overview", { p_studio_id: studioId });
  if (error) return null;
  return parseRecurringOverview(data);
}

const CODE_MAP: Record<string, [RecurringErrorCode, string]> = {
  "42501": ["not_authorized", "Only the studio owner can authorize or revoke recurring charges."],
  TW010: ["no_legal_business", "Recurring charges are available once your legal business is verified."],
  TW008: ["price_changed", "The price changed or is not published yet. Review the current price and authorize again."],
  "23505": ["already_authorized", "This charge is already authorized for this location."],
  "22023": ["invalid", "Check the term and limit and try again."],
  TW011: ["pilot_business", "Your business is in the DanceFlow pilot: each recurring fee needs its own approval from DanceFlow. Nothing is charged automatically."],
  TW012: ["monthly_limit", "Set a monthly spending limit that covers your recurring charges first (Settings, Texting, Monthly spending limit)."],
  TW007: ["insufficient_credit", "Add credit first: the first month's charge is set aside from your prepaid credit when you authorize."],
};
const failure = (error: { code?: string } | null): RecurringError => {
  const mapped = CODE_MAP[String(error?.code ?? "")];
  return mapped ? new RecurringError(mapped[0], mapped[1]) : new RecurringError("unavailable", "Recurring charges are not available right now.");
};

/**
 * Records an owner's authorization (the total limit is always price x term: the term is the spending control). `admin` is the service-role client of a server route that has already proven who `userId` is; the database re-checks that user
 * is an OWNER of the studio, validates the price and limits, and writes the acknowledgement text itself.
 */
export async function authorizeRecurring(
  admin: Client,
  input: { studioId: string; userId: string; kind: RecurringKind; acknowledgedPriceCents: number; termMonths: number; totalLimitCents: number },
): Promise<{ authorizationId: string }> {
  if (!Number.isInteger(input.acknowledgedPriceCents) || input.acknowledgedPriceCents <= 0 || !(RECURRING_TERMS as readonly number[]).includes(input.termMonths)) {
    throw new RecurringError("invalid", "Check the term and limit and try again.");
  }
  const { data, error } = await admin.rpc("tw4_recurring_authorize", {
    p_studio_id: input.studioId,
    p_user_id: input.userId,
    p_kind: input.kind,
    p_acknowledged_price_cents: input.acknowledgedPriceCents,
    p_term_months: input.termMonths,
    p_total_limit_cents: input.totalLimitCents,
  });
  if (error) throw failure(error);
  const id = obj(data).authorization_id;
  if (typeof id !== "string") throw new RecurringError("unavailable", "Recurring charges are not available right now.");
  return { authorizationId: id };
}

export async function revokeRecurring(admin: Client, authorizationId: string, userId: string): Promise<void> {
  const { error } = await admin.rpc("tw4_recurring_revoke", { p_authorization_id: authorizationId, p_user_id: userId });
  if (error) throw failure(error);
}

// ---------------------------------------------------------------------------------------------------------------
// scheduler core (service role only; NOT wired to any cron by this slice)
// ---------------------------------------------------------------------------------------------------------------
export const periodKeyFor = (date: Date): string => `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;

export type RecurringRunSummary = { periods: string[]; runId: string | null; due: number; charged: number; unfunded: number; held: number; refused: number; replayed: number; errors: number };

/**
 * Charges every due authorization, one at a time. The DATABASE decides what is due and for which service month: months are calendar months in each legal business's
 * own timezone (the current and the previous one), so this code never computes a period. A failure of one charge never stops the others; every step is idempotent
 * (a charged period is a replay, an unpaid one is retried). Set-aside funds of authorizations that ended or were revoked are released first.
 */
export async function runDueRecurringCharges(admin: Client, runId: string | null = null): Promise<RecurringRunSummary> {
  const summary: RecurringRunSummary = { periods: [], runId, due: 0, charged: 0, unfunded: 0, held: 0, refused: 0, replayed: 0, errors: 0 };
  const released = await admin.rpc("tw4_recurring_release_ended");
  if (released.error) throw new Error(`recurring release failed (${released.error.code ?? "unknown"})`);
  const due = await admin.rpc("tw4_recurring_due_list");
  if (due.error) throw new Error(`recurring due query failed (${due.error.code ?? "unknown"})`);
  const items = (Array.isArray(due.data) ? due.data : []).flatMap((row) => {
    const r = obj(row);
    return typeof r.id === "string" && typeof r.period_key === "string" && /^[0-9]{4}-(0[1-9]|1[0-2])$/.test(r.period_key) ? [{ id: r.id, period: r.period_key }] : [];
  });
  summary.due = items.length;
  summary.periods = [...new Set(items.map((item) => item.period))].sort();
  for (const item of items) {
    const result = await admin.rpc("tw4_recurring_charge", { p_authorization_id: item.id, p_period_key: item.period, p_run_id: runId });
    if (result.error) {
      summary.errors += 1;
      continue;
    }
    const outcome = obj(result.data);
    if (outcome.replayed === true) summary.replayed += 1;
    if (outcome.outcome === "charged" && outcome.replayed !== true) summary.charged += 1;
    else if (outcome.outcome === "unfunded") summary.unfunded += 1;
    else if (outcome.outcome === "held") summary.held += 1;
    else if (outcome.outcome === "refused") summary.refused += 1;
  }
  return summary;
}

export type RecurringScheduledOutcome = { ran: false; reason: "disabled" | "busy" } | { ran: true; summary: RecurringRunSummary };

/**
 * The scheduler entry point. It takes the database's single run lease (refused while the database switch is off or another run is active), charges the due
 * authorizations under that run id (the database fences a runner whose lease has expired), and records the outcome. Nothing calls this on a schedule in this repository.
 */
export async function runScheduledRecurringCharges(admin: Client, input: { runner: string; leaseSeconds?: number }): Promise<RecurringScheduledOutcome> {
  const begin = await admin.rpc("tw4_recurring_run_begin", { p_runner: input.runner, p_lease_seconds: input.leaseSeconds ?? 600 });
  if (begin.error) throw new Error(`recurring run could not start (${begin.error.code ?? "unknown"})`);
  const started = obj(begin.data);
  if (started.acquired !== true || typeof started.run_id !== "string") return { ran: false, reason: started.reason === "busy" ? "busy" : "disabled" };
  const runId = started.run_id;
  try {
    const summary = await runDueRecurringCharges(admin, runId);
    const finish = await admin.rpc("tw4_recurring_run_finish", { p_run_id: runId, p_status: summary.errors > 0 ? "failed" : "completed", p_summary: summary, p_error: summary.errors > 0 ? `${summary.errors} charge call(s) failed` : null });
    if (finish.error) throw new Error(`recurring run could not be recorded (${finish.error.code ?? "unknown"})`); // the lease then expires on its own; the failure must be visible
    return { ran: true, summary };
  } catch (error) {
    await admin.rpc("tw4_recurring_run_finish", { p_run_id: runId, p_status: "failed", p_summary: null, p_error: error instanceof Error ? error.message.slice(0, 200) : "run failed" }).then(() => undefined, () => undefined);
    throw error;
  }
}

export type RecurringAdminOverview = {
  schedulerEnabled: boolean;
  reconciliationGaps: number;
  recentRuns: { runner: string; status: string; startedAt: string; finishedAt: string | null; error: string | null }[];
  activeAuthorizations: number;
  needsAttention: { legalName: string; kind: string; periodKey: string; amountCents: number; status: string; reason: string | null; attempts: number }[];
};
export function parseRecurringAdminOverview(data: unknown): RecurringAdminOverview {
  const o = obj(data);
  const rows = Array.isArray(o.needs_attention) ? o.needs_attention : [];
  const runs = Array.isArray(o.recent_runs) ? o.recent_runs : [];
  return {
    schedulerEnabled: o.scheduler_enabled === true,
    reconciliationGaps: num(o.reconciliation_gaps),
    recentRuns: runs.map((row) => {
      const r = obj(row);
      return { runner: String(r.runner ?? ""), status: String(r.status ?? ""), startedAt: String(r.started_at ?? ""), finishedAt: r.finished_at == null ? null : String(r.finished_at), error: r.error == null ? null : String(r.error) };
    }),
    activeAuthorizations: num(o.active_authorizations),
    needsAttention: rows.map((row) => {
      const r = obj(row);
      return { legalName: String(r.legal_name ?? ""), kind: String(r.kind ?? ""), periodKey: String(r.period_key ?? ""), amountCents: num(r.amount_cents), status: String(r.status ?? ""), reason: r.reason == null ? null : String(r.reason), attempts: num(r.attempts) };
    }),
  };
}
export async function getRecurringAdminOverview(supabase: Client): Promise<RecurringAdminOverview | null> {
  const { data, error } = await supabase.rpc("sms_recurring_admin_overview");
  if (error) return null;
  return parseRecurringAdminOverview(data);
}
