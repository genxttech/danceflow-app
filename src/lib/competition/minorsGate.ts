/*
  OD-02 (owner decision 2026-11-23): temporary launch restriction. For initial Competition OS activation,
  under-18 competitor registration is prohibited for EVERY competition event type (Studio / Custom included).
  This is DanceFlow policy, not a governing-body rule, and not a permanent exclusion of young dancers: the
  future minors-enabled design is docs/competition/od02-option-a-minors-design.md (not implemented).

  Enforcement point: this pure function is called by the only server path that can create competition entries
  (POST /api/events/[slug]/competition/checkout), BEFORE the database quote / start RPCs, and by the public
  builder for early feedback (never the only check). Every entry participant is evaluated individually (couples,
  teams, studio-side registrations). The purchaser's age is irrelevant.

  Privacy: the result carries only a boolean outcome and a reason code per roster person. Birthdates and
  computed ages are never returned, logged or echoed. A roster person who is not in any entry and supplied no
  date of birth is not asked for one (data minimisation).
*/

export const COMPETITION_MINIMUM_AGE_YEARS = 18;

export type MinorsGateReason = "under_minimum_age" | "age_not_established";

export type MinorsGateResult =
  | { ok: true }
  | {
      ok: false;
      /** One code for the whole draft: "minors_not_permitted" wins over "age_not_established". */
      code: "minors_not_permitted" | "age_not_established";
      blocked: Array<{ personClientId: string; reason: MinorsGateReason }>;
    };

export const MINORS_NOT_PERMITTED_MESSAGE =
  "Competitors must be 18 or older to register for this event. Registration for dancers under 18 is not available at this time.";
export const AGE_NOT_ESTABLISHED_MESSAGE =
  "A valid date of birth is required for every competitor so we can confirm the 18-or-older requirement.";

const DOB_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Reference date: "today" in the earliest timezone on Earth that still lags UTC (UTC-12), so no one is counted as an adult early. */
export function conservativeReferenceDate(now: Date): { y: number; m: number; d: number } {
  const shifted = new Date(now.getTime() - 12 * 60 * 60 * 1000);
  return { y: shifted.getUTCFullYear(), m: shifted.getUTCMonth() + 1, d: shifted.getUTCDate() };
}

/** "adult" | "minor" | "unknown" (missing, malformed, impossible, in the future, or implausibly old). Never returns an age. */
export function classifyDateOfBirth(value: unknown, now: Date = new Date()): "adult" | "minor" | "unknown" {
  if (typeof value !== "string") return "unknown";
  const match = DOB_PATTERN.exec(value);
  if (!match) return "unknown";
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) return "unknown";
  const ref = conservativeReferenceDate(now);
  if (y < 1900) return "unknown";
  const born = y * 10000 + m * 100 + d;
  const today = ref.y * 10000 + ref.m * 100 + ref.d;
  if (born > today) return "unknown";
  // 18th birthday date (Feb 29 birthdays reach 18 on Mar 1 of a non-leap year: the later date is the safe one).
  const eighteenth = new Date(Date.UTC(y + COMPETITION_MINIMUM_AGE_YEARS, m - 1, d));
  const adultDate = eighteenth.getUTCMonth() !== m - 1
    ? (y + COMPETITION_MINIMUM_AGE_YEARS) * 10000 + (m + 1) * 100 + 1
    : (y + COMPETITION_MINIMUM_AGE_YEARS) * 10000 + m * 100 + d;
  return today >= adultDate ? "adult" : "minor";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * Evaluate a registration draft (untrusted input). Fails closed:
 *  - every person who appears in an entry needs a valid date of birth showing 18 or older;
 *  - any roster person whose supplied date of birth shows under 18 is refused even if not yet in an entry;
 *  - an entry that references an unknown participant id is left to the quote's own validation, but the draft
 *    is still refused when any referenced participant cannot be age-established.
 */
export function evaluateCompetitionAdultGate(draft: unknown, now: Date = new Date()): MinorsGateResult {
  const root = asRecord(draft);
  const people = Array.isArray(root?.people) ? (root!.people as unknown[]) : [];
  const entries = Array.isArray(root?.entries) ? (root!.entries as unknown[]) : [];

  const inEntry = new Set<string>();
  for (const entryValue of entries) {
    const entry = asRecord(entryValue);
    const ids = Array.isArray(entry?.participantIds) ? (entry!.participantIds as unknown[]) : [];
    for (const id of ids) if (typeof id === "string" && id) inEntry.add(id);
  }

  const blocked: Array<{ personClientId: string; reason: MinorsGateReason }> = [];
  for (const personValue of people) {
    const person = asRecord(personValue);
    const clientId = typeof person?.clientId === "string" ? person.clientId : "";
    const dob = person?.dateOfBirth;
    const hasDob = typeof dob === "string" && dob !== "";
    const competes = clientId !== "" && inEntry.has(clientId);
    if (!competes && !hasDob) continue;
    const verdict = classifyDateOfBirth(dob, now);
    if (verdict === "adult") continue;
    const reason: MinorsGateReason = verdict === "minor" ? "under_minimum_age" : "age_not_established";
    blocked.push({ personClientId: clientId || `person-${blocked.length + 1}`, reason });
  }

  // A referenced participant id that is not on the roster has no date of birth to check: fail closed.
  const rosterIds = new Set(people.map((p) => asRecord(p)?.clientId).filter((id): id is string => typeof id === "string"));
  for (const id of inEntry) {
    if (!rosterIds.has(id)) blocked.push({ personClientId: id, reason: "age_not_established" });
  }

  if (blocked.length === 0) return { ok: true };
  const code = blocked.some((item) => item.reason === "under_minimum_age") ? "minors_not_permitted" : "age_not_established";
  return { ok: false, code, blocked };
}

export function minorsGateMessage(result: Exclude<MinorsGateResult, { ok: true }>): string {
  return result.code === "minors_not_permitted" ? MINORS_NOT_PERMITTED_MESSAGE : AGE_NOT_ESTABLISHED_MESSAGE;
}
