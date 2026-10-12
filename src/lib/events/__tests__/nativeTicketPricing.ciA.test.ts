import { describe, expect, it } from "vitest";
import { parseExpectedUnitPriceCents, priceNativeTicketSelections } from "@/lib/events/nativeTicketPricing";
import { effectiveTicketPrice } from "@/lib/events/ticketPricing";

/** CI-A: native (Expo) checkout pricing uses the same rule as the web cart, with the same cutoff race refusal. */

const CUTOFF = "2027-03-01T06:00:00.000Z";
const CUTOFF_MS = Date.parse(CUTOFF);
const early = { id: "t-early", price: 40, early_bird_enabled: true, early_bird_price: 30, early_bird_ends_at: CUTOFF };
const regular = { id: "t-regular", price: "25.10", early_bird_enabled: false, early_bird_price: null, early_bird_ends_at: null };

describe("priceNativeTicketSelections", () => {
  it("prices with the shared rule (web/native parity) and totals in cents", () => {
    for (const now of [CUTOFF_MS - 1, CUTOFF_MS, CUTOFF_MS + 1]) {
      const result = priceNativeTicketSelections([{ ticketTypeId: "t-early", quantity: 2 }, { ticketTypeId: "t-regular", quantity: 1 }], [early, regular], now);
      const webEarly = effectiveTicketPrice(early, now);
      expect(result.ok && webEarly.ok).toBe(true);
      if (result.ok && webEarly.ok) {
        expect(result.unitCentsById.get("t-early")).toBe(webEarly.unitCents);
        expect(result.requestedTotalCents).toBe(webEarly.unitCents * 2 + 2510);
      }
    }
  });

  it("refuses a price higher than the app showed (cutoff passed) and accepts an equal or higher expectation", () => {
    expect(priceNativeTicketSelections([{ ticketTypeId: "t-early", quantity: 1, expectedUnitPriceCents: 3000 }], [early], CUTOFF_MS)).toEqual({ ok: false, kind: "ticket_price_changed" });
    expect(priceNativeTicketSelections([{ ticketTypeId: "t-early", quantity: 1, expectedUnitPriceCents: 3000 }], [early], CUTOFF_MS - 1)).toMatchObject({ ok: true, requestedTotalCents: 3000 });
    expect(priceNativeTicketSelections([{ ticketTypeId: "t-early", quantity: 1, expectedUnitPriceCents: 4000 }], [early], CUTOFF_MS - 1)).toMatchObject({ ok: true, requestedTotalCents: 3000 });
    expect(priceNativeTicketSelections([{ ticketTypeId: "t-early", quantity: 1 }], [early], CUTOFF_MS)).toMatchObject({ ok: true, requestedTotalCents: 4000 });
  });

  it("refuses tickets that cannot be priced or are missing", () => {
    expect(priceNativeTicketSelections([{ ticketTypeId: "t-bad", quantity: 1 }], [{ id: "t-bad", price: -1 }], CUTOFF_MS)).toEqual({ ok: false, kind: "ticket_unavailable" });
    expect(priceNativeTicketSelections([{ ticketTypeId: "t-missing", quantity: 1 }], [early], CUTOFF_MS)).toEqual({ ok: false, kind: "ticket_unavailable" });
  });

  it("parses the app's expectation fail-closed", () => {
    expect(parseExpectedUnitPriceCents(undefined)).toBeUndefined();
    expect(parseExpectedUnitPriceCents(null)).toBeUndefined();
    expect(parseExpectedUnitPriceCents(3000)).toBe(3000);
    expect(parseExpectedUnitPriceCents(0)).toBe(0);
    for (const bad of [-1, 12.5, "3000", Number.NaN, {}]) expect(parseExpectedUnitPriceCents(bad)).toBe(-1);
  });
});
