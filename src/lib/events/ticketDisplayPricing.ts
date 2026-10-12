import { effectiveTicketPrice, type TicketPriceDefinition } from "@/lib/events/ticketPricing";

/**
 * CI-A: attaches the server-computed effective price to ticket rows passed to the public registration form, so the
 * form never computes prices itself. One evaluation instant per page render. A ticket whose regular price is not a
 * valid amount gets null prices and must not be selectable.
 */
export type TicketDisplayPricing = {
  effectiveUnitPriceCents: number | null;
  regularUnitPriceCents: number | null;
  isEarlyBird: boolean;
  earlyBirdEndsAt: string | null;
};

export function withEffectiveTicketPricing<T extends TicketPriceDefinition>(tickets: readonly T[], nowMs: number): Array<T & TicketDisplayPricing> {
  return tickets.map((ticket) => {
    const pricing = effectiveTicketPrice(ticket, nowMs);
    return pricing.ok
      ? { ...ticket, effectiveUnitPriceCents: pricing.unitCents, regularUnitPriceCents: pricing.regularCents, isEarlyBird: pricing.isEarlyBird, earlyBirdEndsAt: pricing.isEarlyBird ? pricing.earlyBirdEndsAt : null }
      : { ...ticket, effectiveUnitPriceCents: null, regularUnitPriceCents: null, isEarlyBird: false, earlyBirdEndsAt: null };
  });
}
