/**
 * CI-A: the ONE effective-price rule for ordinary event tickets (public page, web cart checkout, native checkout).
 * Pure: no imports, no clock, no server-only APIs, so the same rule can be used wherever a ticket is priced. The
 * Expo app keeps a byte-for-byte copy of the rule (mobile/student/src/lib/ticketPricing.ts) whose parity is enforced
 * by src/lib/events/__tests__/ticketPricing.ciA.test.ts.
 *
 * Money is handled in integer minor units (cents). The rule:
 *   - the regular price must be a valid amount (finite, >= 0, at most 2 decimal places); otherwise the ticket is
 *     NOT priceable and must not be sold (no invented amount);
 *   - early bird applies only when it is enabled, its price is valid and strictly lower than the regular price,
 *     its cutoff is a valid instant, and the evaluation instant is strictly BEFORE the cutoff (the cutoff instant
 *     itself and everything after it use the regular price);
 *   - an enabled but invalid early-bird configuration falls back to the regular price (never a lower or invented one).
 * The cutoff is stored as an absolute instant (timestamptz); event-local interpretation happens when the organizer
 * enters it (see eventLocalTime.ts).
 */

/** Largest accepted ticket amount in cents ($100,000.00). */
export const MAX_TICKET_PRICE_CENTS = 10_000_000;

export type TicketPriceDefinition = {
  price: unknown;
  early_bird_enabled?: boolean | null;
  early_bird_price?: unknown;
  early_bird_ends_at?: string | null;
};

export type EarlyBirdIgnoredReason = "invalid_early_bird_price" | "not_lower_than_regular" | "invalid_cutoff";

export type EffectiveTicketPrice =
  | {
      ok: true;
      /** The amount to show and charge per ticket, in cents. */
      unitCents: number;
      regularCents: number;
      isEarlyBird: boolean;
      /** Early bird is configured, valid, but its cutoff has passed (or is now). */
      earlyBirdExpired: boolean;
      /** The early-bird cutoff (ISO) when early bird is configured and valid, else null. */
      earlyBirdEndsAt: string | null;
      /** Why an ENABLED early-bird configuration was not applied (invalid configuration), if so. */
      earlyBirdIgnoredReason: EarlyBirdIgnoredReason | null;
    }
  | { ok: false; reason: "invalid_regular_price" | "invalid_evaluation_instant" };

/**
 * A money amount in cents, or null when it is not a valid amount: non-finite, negative, more than 2 decimal places,
 * above MAX_TICKET_PRICE_CENTS, or not a number / numeric string. Accepts numbers and numeric strings (PostgREST
 * returns numeric columns as numbers or strings).
 */
export function toMinorUnits(value: unknown): number | null {
  let numeric: number;
  if (typeof value === "number") numeric = value;
  else if (typeof value === "string" && /^\s*-?\d+(\.\d+)?\s*$/.test(value)) numeric = Number(value);
  else return null;
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  const cents = Math.round(numeric * 100);
  if (Math.abs(numeric * 100 - cents) > 1e-6) return null;
  if (cents > MAX_TICKET_PRICE_CENTS) return null;
  return cents;
}

/** cents -> currency amount (e.g. 1999 -> 19.99) for numeric(…, 2) columns. */
export function fromMinorUnits(cents: number): number {
  return Math.round(cents) / 100;
}

export function effectiveTicketPrice(ticket: TicketPriceDefinition, nowMs: number): EffectiveTicketPrice {
  if (!Number.isFinite(nowMs)) return { ok: false, reason: "invalid_evaluation_instant" };
  const regularCents = toMinorUnits(ticket.price);
  if (regularCents === null) return { ok: false, reason: "invalid_regular_price" };

  const regular = (earlyBirdIgnoredReason: EarlyBirdIgnoredReason | null, earlyBirdEndsAt: string | null, earlyBirdExpired: boolean) =>
    ({ ok: true as const, unitCents: regularCents, regularCents, isEarlyBird: false, earlyBirdExpired, earlyBirdEndsAt, earlyBirdIgnoredReason });

  if (ticket.early_bird_enabled !== true) return regular(null, null, false);

  const earlyBirdCents = ticket.early_bird_price === null || ticket.early_bird_price === undefined ? null : toMinorUnits(ticket.early_bird_price);
  if (earlyBirdCents === null) return regular("invalid_early_bird_price", null, false);
  if (earlyBirdCents >= regularCents) return regular("not_lower_than_regular", null, false);

  const cutoffMs = typeof ticket.early_bird_ends_at === "string" ? Date.parse(ticket.early_bird_ends_at) : Number.NaN;
  if (!Number.isFinite(cutoffMs)) return regular("invalid_cutoff", null, false);
  const earlyBirdEndsAt = new Date(cutoffMs).toISOString();

  // Exclusive cutoff: early bird strictly before the instant; the instant itself is regular price.
  if (nowMs < cutoffMs) {
    return { ok: true, unitCents: earlyBirdCents, regularCents, isEarlyBird: true, earlyBirdExpired: false, earlyBirdEndsAt, earlyBirdIgnoredReason: null };
  }
  return regular(null, earlyBirdEndsAt, true);
}

/** Line total in cents for a validated quantity (a positive integer). Returns null for an invalid quantity. */
export function ticketLineTotalCents(unitCents: number, quantity: number): number | null {
  if (!Number.isInteger(unitCents) || unitCents < 0) return null;
  if (!Number.isInteger(quantity) || quantity < 1) return null;
  return unitCents * quantity;
}
