import type { MonthlyLimitOverview } from "./smsMonthlyLimits";

/** Display helpers shared by the owner's limit card and the platform-admin panel (server- and client-safe: no React, no I/O). */

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export const monthLabel = (key: string) => {
  const match = /^([0-9]{4})-(0[1-9]|1[0-2])$/.exec(key);
  return match ? `${MONTHS[Number(match[2]) - 1]} ${match[1]}` : key;
};

/** A date in the business's own timezone (a UTC slice would show the wrong day for zones ahead of UTC). */
export const localDate = (iso: string, timeZone: string, offsetMs = 0) => {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso.slice(0, 10);
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(t + offsetMs));
  } catch {
    return iso.slice(0, 10);
  }
};

/** What can still be spent this month: the effective limit less what is spent or set aside, never negative. */
export const remainingCents = (overview: Pick<MonthlyLimitOverview, "effectiveLimitCents" | "spentCents">) => Math.max(overview.effectiveLimitCents - overview.spentCents, 0);
