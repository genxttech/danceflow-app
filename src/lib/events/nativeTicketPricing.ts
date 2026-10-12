import { effectiveTicketPrice, type TicketPriceDefinition } from "@/lib/events/ticketPricing";

/**
 * CI-A: pricing step of the native (Expo app) event checkout. Uses the shared effective-price rule at one instant,
 * refuses a ticket that cannot be priced, and refuses (before any order is created) a price higher than the one the
 * app showed for that line. Older app builds that send no expectation are priced by the server alone.
 */
export type NativeTicketSelection = { ticketTypeId: string; quantity: number; expectedUnitPriceCents?: number };

export type NativeTicketPricingResult =
  | { ok: true; unitCentsById: Map<string, number>; requestedTotalCents: number }
  | { ok: false; kind: "ticket_unavailable" | "ticket_price_changed" };

/** A submitted expectation: absent -> undefined; a valid non-negative integer -> itself; anything else -> -1. */
export function parseExpectedUnitPriceCents(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : -1;
}

export function priceNativeTicketSelections(
  selections: readonly NativeTicketSelection[],
  tickets: ReadonlyArray<TicketPriceDefinition & { id: string }>,
  nowMs: number,
): NativeTicketPricingResult {
  const unitCentsById = new Map<string, number>();
  for (const ticket of tickets) {
    const pricing = effectiveTicketPrice(ticket, nowMs);
    if (!pricing.ok) return { ok: false, kind: "ticket_unavailable" };
    unitCentsById.set(ticket.id, pricing.unitCents);
  }
  let requestedTotalCents = 0;
  for (const selection of selections) {
    const unitCents = unitCentsById.get(selection.ticketTypeId);
    if (unitCents === undefined) return { ok: false, kind: "ticket_unavailable" };
    if (selection.expectedUnitPriceCents !== undefined && unitCents > selection.expectedUnitPriceCents) {
      return { ok: false, kind: "ticket_price_changed" };
    }
    requestedTotalCents += unitCents * Math.max(1, selection.quantity);
  }
  return { ok: true, unitCentsById, requestedTotalCents };
}
