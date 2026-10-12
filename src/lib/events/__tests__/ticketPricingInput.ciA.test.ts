import { describe, expect, it } from "vitest";
import { parseTicketPricingInput, TICKET_PRICING_INPUT_ERRORS, ticketEditorErrorMessage } from "@/lib/events/ticketPricingInput";
import { EVENT_LOCAL_TIME_ERRORS } from "@/lib/events/eventLocalTime";

/** CI-A: ticket editor price / early-bird validation (event-local cutoff, early bird strictly lower). */

const base = { price: "40", earlyBirdEnabled: true, earlyBirdPrice: "30", earlyBirdEndsLocal: "2027-03-01T00:00", eventTimeZone: "America/Chicago" };

describe("parseTicketPricingInput", () => {
  it("accepts a valid early bird and stores the cutoff as the event-local instant", () => {
    expect(parseTicketPricingInput(base)).toEqual({
      ok: true,
      value: { price: 40, early_bird_enabled: true, early_bird_price: 30, early_bird_ends_at: "2027-03-01T06:00:00.000Z" },
    });
  });

  it("interprets the same wall time differently for events in different time zones", () => {
    const ny = parseTicketPricingInput({ ...base, eventTimeZone: "America/New_York" });
    const la = parseTicketPricingInput({ ...base, eventTimeZone: "America/Los_Angeles" });
    expect(ny.ok && ny.value.early_bird_ends_at).toBe("2027-03-01T05:00:00.000Z");
    expect(la.ok && la.value.early_bird_ends_at).toBe("2027-03-01T08:00:00.000Z");
  });

  it("clears early-bird fields when it is disabled (ignoring whatever was typed)", () => {
    expect(parseTicketPricingInput({ ...base, earlyBirdEnabled: false, earlyBirdPrice: "999", earlyBirdEndsLocal: "garbage" })).toEqual({
      ok: true,
      value: { price: 40, early_bird_enabled: false, early_bird_price: null, early_bird_ends_at: null },
    });
  });

  it("keeps a blank regular price meaning a free ticket, and rejects invalid regular prices", () => {
    expect(parseTicketPricingInput({ ...base, price: "", earlyBirdEnabled: false })).toMatchObject({ ok: true, value: { price: 0 } });
    for (const price of ["-1", "abc", "12.345", "1e3", "100000.01"]) {
      expect(parseTicketPricingInput({ ...base, price, earlyBirdEnabled: false }), price).toMatchObject({ ok: false, error: expect.stringContaining("valid ticket price") });
    }
  });

  it("requires the early-bird price to be valid and strictly lower than the regular price", () => {
    expect(parseTicketPricingInput({ ...base, earlyBirdPrice: "" })).toMatchObject({ ok: false, error: expect.stringContaining("required") });
    expect(parseTicketPricingInput({ ...base, earlyBirdPrice: "-1" })).toMatchObject({ ok: false });
    expect(parseTicketPricingInput({ ...base, earlyBirdPrice: "30.001" })).toMatchObject({ ok: false });
    expect(parseTicketPricingInput({ ...base, earlyBirdPrice: "40" })).toMatchObject({ ok: false, error: "Early bird price must be lower than the regular ticket price." });
    expect(parseTicketPricingInput({ ...base, earlyBirdPrice: "45" })).toMatchObject({ ok: false, error: "Early bird price must be lower than the regular ticket price." });
    expect(parseTicketPricingInput({ ...base, price: "0", earlyBirdPrice: "0" })).toMatchObject({ ok: false });
    expect(parseTicketPricingInput({ ...base, earlyBirdPrice: "0" })).toMatchObject({ ok: true, value: { early_bird_price: 0 } });
  });

  it("requires a cutoff and refuses DST-nonexistent, DST-ambiguous and impossible times", () => {
    expect(parseTicketPricingInput({ ...base, earlyBirdEndsLocal: "" })).toMatchObject({ ok: false, error: expect.stringContaining("required") });
    expect(parseTicketPricingInput({ ...base, earlyBirdEndsLocal: "2027-03-14T02:30", eventTimeZone: "America/New_York" })).toMatchObject({ ok: false, error: expect.stringContaining("does not exist") });
    expect(parseTicketPricingInput({ ...base, earlyBirdEndsLocal: "2027-11-07T01:30", eventTimeZone: "America/New_York" })).toMatchObject({ ok: false, error: expect.stringContaining("happens twice") });
    expect(parseTicketPricingInput({ ...base, earlyBirdEndsLocal: "2027-02-30T10:00" })).toMatchObject({ ok: false, error: expect.stringContaining("not a valid date") });
    expect(parseTicketPricingInput({ ...base, eventTimeZone: "Mars/Olympus" })).toMatchObject({ ok: false, error: expect.stringContaining("time zone") });
  });
});

describe("ticketEditorErrorMessage", () => {
  it("shows known validation messages verbatim", () => {
    expect(ticketEditorErrorMessage(TICKET_PRICING_INPUT_ERRORS.earlyBirdNotLower)).toBe(TICKET_PRICING_INPUT_ERRORS.earlyBirdNotLower);
    expect(ticketEditorErrorMessage(EVENT_LOCAL_TIME_ERRORS.nonexistent_local_time)).toBe(EVENT_LOCAL_TIME_ERRORS.nonexistent_local_time);
    expect(ticketEditorErrorMessage([TICKET_PRICING_INPUT_ERRORS.invalidPrice, "x"])).toBe(TICKET_PRICING_INPUT_ERRORS.invalidPrice);
  });

  it("never echoes unknown text (database errors or a crafted link)", () => {
    const generic = "Your ticket changes were not saved. Check the values and try again.";
    expect(ticketEditorErrorMessage("Could not update ticket type: duplicate key")).toBe(generic);
    expect(ticketEditorErrorMessage("Your account is suspended. Call 555-0100.")).toBe(generic);
  });

  it("shows nothing without an error", () => {
    expect(ticketEditorErrorMessage(undefined)).toBeNull();
    expect(ticketEditorErrorMessage("")).toBeNull();
  });
});
