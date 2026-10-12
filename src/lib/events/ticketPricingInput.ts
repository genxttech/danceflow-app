import { fromMinorUnits, toMinorUnits } from "@/lib/events/ticketPricing";
import { EVENT_LOCAL_TIME_ERRORS, eventLocalToInstant } from "@/lib/events/eventLocalTime";

/**
 * CI-A: validation of the ticket editor's price and early-bird inputs. Pure, so it is unit-tested directly.
 *   - regular price: blank means 0 (free ticket, as before); otherwise a valid amount (>= 0, at most 2 decimals);
 *   - early bird (when enabled): a valid price strictly LOWER than the regular price, and a cutoff entered as an
 *     event-local wall time, converted in the EVENT's time zone (never the browser's), refusing DST-nonexistent and
 *     DST-ambiguous times.
 * Existing ticket rows are not rewritten by this; it only validates what an organizer saves.
 */
export type TicketPricingInput = {
  price: string;
  earlyBirdEnabled: boolean;
  earlyBirdPrice: string;
  earlyBirdEndsLocal: string;
  eventTimeZone: string;
};

export type TicketPricingFields = {
  price: number;
  early_bird_enabled: boolean;
  early_bird_price: number | null;
  early_bird_ends_at: string | null;
};

export const TICKET_PRICING_INPUT_ERRORS = {
  invalidPrice: "Enter a valid ticket price: 0 or more, with at most two decimal places.",
  invalidEarlyBirdPrice: "Early bird price is required when early bird pricing is enabled (0 or more, with at most two decimal places).",
  earlyBirdNotLower: "Early bird price must be lower than the regular ticket price.",
  missingEarlyBirdEnd: "Early bird end date/time is required when early bird pricing is enabled.",
} as const;

const KNOWN_TICKET_EDITOR_ERRORS = new Set<string>([
  ...Object.values(TICKET_PRICING_INPUT_ERRORS),
  ...Object.values(EVENT_LOCAL_TIME_ERRORS),
  "Ticket name is required.",
]);

/**
 * The ticket editor reports a refused save through its ?error= query value. Only known validation messages are shown
 * verbatim; anything else (database errors, or text placed in a crafted link) becomes a generic message.
 */
export function ticketEditorErrorMessage(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return null;
  return KNOWN_TICKET_EDITOR_ERRORS.has(raw) ? raw : "Your ticket changes were not saved. Check the values and try again.";
}

export function parseTicketPricingInput(input: TicketPricingInput): { ok: true; value: TicketPricingFields } | { ok: false; error: string } {
  const priceText = input.price.trim();
  const priceCents = priceText === "" ? 0 : toMinorUnits(priceText);
  if (priceCents === null) {
    return { ok: false, error: TICKET_PRICING_INPUT_ERRORS.invalidPrice };
  }

  if (!input.earlyBirdEnabled) {
    return { ok: true, value: { price: fromMinorUnits(priceCents), early_bird_enabled: false, early_bird_price: null, early_bird_ends_at: null } };
  }

  const earlyBirdText = input.earlyBirdPrice.trim();
  const earlyBirdCents = earlyBirdText === "" ? null : toMinorUnits(earlyBirdText);
  if (earlyBirdCents === null) {
    return { ok: false, error: TICKET_PRICING_INPUT_ERRORS.invalidEarlyBirdPrice };
  }
  if (earlyBirdCents >= priceCents) {
    return { ok: false, error: TICKET_PRICING_INPUT_ERRORS.earlyBirdNotLower };
  }

  if (!input.earlyBirdEndsLocal.trim()) {
    return { ok: false, error: TICKET_PRICING_INPUT_ERRORS.missingEarlyBirdEnd };
  }
  const cutoff = eventLocalToInstant(input.earlyBirdEndsLocal, input.eventTimeZone);
  if (!cutoff.ok) return { ok: false, error: EVENT_LOCAL_TIME_ERRORS[cutoff.reason] };

  return {
    ok: true,
    value: {
      price: fromMinorUnits(priceCents),
      early_bird_enabled: true,
      early_bird_price: fromMinorUnits(earlyBirdCents),
      early_bird_ends_at: cutoff.iso,
    },
  };
}
