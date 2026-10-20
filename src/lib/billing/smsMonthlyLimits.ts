import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Monthly spending limits for routine messaging costs (SMS usage, recurring number rent and campaign fees), by calendar month in the legal business's own timezone.
 * The database enforces everything; this module reads the screen's data and calls the owner actions with the signed-in user's id (service role, from a route).
 */
type Client = Pick<SupabaseClient, "rpc">;

export function smsMonthlyLimitsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return String(env.SMS_MONTHLY_LIMITS ?? "").trim().toLowerCase() === "on";
}

export type MonthlyLimitChange = { effectiveMonth: string; limitCents: number; previousLimitCents: number; spendAtChangeCents: number; changedByRole: "owner" | "platform_admin"; createdAt: string };
export type MonthlyLimitOverview = {
  legalBusiness: boolean;
  month: string;
  timezone: string;
  nextMonthTimezone: string;
  /** What the owner configured (0 until configured). */
  limitCents: number;
  /** The platform safety ceiling that bounds it: a bound, never an authorization. */
  ceilingCents: number;
  /** The lesser of the two: what can actually be spent this month. */
  effectiveLimitCents: number;
  nextMonthLimitCents: number;
  /** Outgoing texting usage. */
  usageCents: number;
  /** Charged ordinary inbound texts (D4: counted toward the limit; never refused, so they can overrun it). */
  inboundCents: number;
  /** Inbound charges beyond the negative-balance ceiling, not collected (DanceFlow absorbs them). */
  inboundUncollectedCents: number;
  /** Estimated provider cost DanceFlow absorbs: compliance (STOP/START/HELP) texts and their confirmations. */
  absorbedCostCents: number;
  /** How far the month's spending is above its effective limit (0 when within it). */
  overrunCents: number;
  recurringCents: number;
  setAsideCents: number;
  spentCents: number;
  monthStartsAt: string;
  monthEndsAt: string;
  onHold: boolean;
  availableCents: number;
  pilotBusiness: boolean;
  recentChanges: MonthlyLimitChange[];
};

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : 0);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

export function parseMonthlyLimitOverview(data: unknown): MonthlyLimitOverview {
  const o = obj(data);
  const parts = obj(o.parts);
  const changes = Array.isArray(o.recent_changes) ? o.recent_changes : [];
  return {
    legalBusiness: o.legal_business === true,
    month: str(o.month),
    timezone: str(o.timezone),
    nextMonthTimezone: str(o.next_month_timezone),
    limitCents: num(o.limit_cents),
    ceilingCents: num(o.ceiling_cents),
    effectiveLimitCents: num(o.effective_limit_cents),
    nextMonthLimitCents: num(o.next_month_limit_cents),
    usageCents: num(parts.usage_cents),
    inboundCents: num(parts.inbound_cents),
    inboundUncollectedCents: num(parts.inbound_uncollected_cents),
    absorbedCostCents: num(parts.absorbed_cost_cents),
    overrunCents: Math.max(num(parts.total_cents) - num(o.effective_limit_cents), 0),
    recurringCents: num(parts.recurring_cents),
    setAsideCents: num(parts.reserved_cents),
    spentCents: num(parts.total_cents),
    monthStartsAt: str(parts.starts_at),
    monthEndsAt: str(parts.ends_at),
    onHold: o.on_hold === true,
    availableCents: num(o.available_cents),
    pilotBusiness: o.pilot_business === true,
    recentChanges: changes.flatMap((row) => {
      const r = obj(row);
      if (r.changed_by_role !== "owner" && r.changed_by_role !== "platform_admin") return [];
      return [{ effectiveMonth: str(r.effective_month), limitCents: num(r.limit_cents), previousLimitCents: num(r.previous_limit_cents), spendAtChangeCents: num(r.spend_at_change_cents), changedByRole: r.changed_by_role, createdAt: str(r.created_at) }];
    }),
  };
}

/** Null when the caller may not see it or the feature is not installed in this environment. */
export async function getMonthlyLimitOverview(supabase: Client, studioId: string): Promise<MonthlyLimitOverview | null> {
  const { data, error } = await supabase.rpc("sms_monthly_limit_overview", { p_studio_id: studioId });
  if (error) return null;
  return parseMonthlyLimitOverview(data);
}

export type MonthlyLimitErrorCode = "not_authorized" | "no_legal_business" | "invalid" | "above_ceiling" | "blocked" | "reauth_required" | "unavailable";
export class MonthlyLimitError extends Error {
  constructor(public readonly code: MonthlyLimitErrorCode, message: string) {
    super(message);
    this.name = "MonthlyLimitError";
  }
}

const CODE_MAP: Record<string, [MonthlyLimitErrorCode, string]> = {
  "42501": ["not_authorized", "Only the studio owner can change this."],
  TW010: ["no_legal_business", "This is available once your legal business is verified."],
  "22023": ["invalid", "Check the amount, the month and the confirmation, then try again."],
  TW013: ["above_ceiling", "That is above the platform safety ceiling. DanceFlow can approve a higher ceiling for your business separately."],
  TW007: ["blocked", "A limit cannot be raised while your credit is on hold or negative."],
  TW014: ["reauth_required", "For your security, sign in again and then raise the limit."],
};
const failure = (error: { code?: string } | null): MonthlyLimitError => {
  const mapped = CODE_MAP[String(error?.code ?? "")];
  return mapped ? new MonthlyLimitError(mapped[0], mapped[1]) : new MonthlyLimitError("unavailable", "Spending limits are not available right now.");
};

const CURRENT_OR_FUTURE_MONTH = /^[0-9]{4}-(0[1-9]|1[0-2])$/;

export async function setMonthlyLimit(
  admin: Client,
  input: { studioId: string; userId: string; limitCents: number; confirmed: boolean; effectiveMonth?: string | null; reason?: string | null },
): Promise<{ limitCents: number; previousLimitCents: number; effectiveMonth: string; spendCents: number }> {
  if (!Number.isInteger(input.limitCents) || input.limitCents < 0 || input.confirmed !== true || (input.effectiveMonth != null && !CURRENT_OR_FUTURE_MONTH.test(input.effectiveMonth))) {
    throw new MonthlyLimitError("invalid", CODE_MAP["22023"][1]);
  }
  const { data, error } = await admin.rpc("tw4_monthly_limit_set", {
    p_studio_id: input.studioId,
    p_user_id: input.userId,
    p_limit_cents: input.limitCents,
    p_effective_month: input.effectiveMonth ?? null,
    p_confirmed: true,
    p_reason: input.reason ?? null,
  });
  if (error) throw failure(error);
  const d = obj(data);
  return { limitCents: num(d.limit_cents), previousLimitCents: num(d.previous_limit_cents), effectiveMonth: str(d.effective_month), spendCents: num(d.spend_cents) };
}

export async function setEntityTimezone(admin: Client, input: { studioId: string; userId: string; timezone: string; reason: string }): Promise<{ timezone: string; effectiveMonth: string }> {
  if (!input.timezone || input.timezone.length > 64 || input.reason.trim().length < 3) throw new MonthlyLimitError("invalid", CODE_MAP["22023"][1]);
  const { data, error } = await admin.rpc("tw4_entity_timezone_set", { p_studio_id: input.studioId, p_user_id: input.userId, p_timezone: input.timezone, p_reason: input.reason });
  if (error) throw failure(error);
  const d = obj(data);
  return { timezone: str(d.timezone), effectiveMonth: str(d.effective_month) };
}

/** Zones offered in the picker; the database accepts any real IANA zone. */
export const COMMON_TIMEZONES = [
  "America/New_York", "America/Chicago", "America/Denver", "America/Phoenix", "America/Los_Angeles", "America/Anchorage", "Pacific/Honolulu",
  "America/Toronto", "America/Vancouver", "Europe/London", "Europe/Paris", "Australia/Sydney", "UTC",
] as const;
