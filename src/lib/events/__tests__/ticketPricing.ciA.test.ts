import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { effectiveTicketPrice, fromMinorUnits, MAX_TICKET_PRICE_CENTS, ticketLineTotalCents, toMinorUnits } from "@/lib/events/ticketPricing";
import { eventLocalToInstant, instantToEventLocalInput, isValidTimeZone } from "@/lib/events/eventLocalTime";

/** CI-A: one effective-price rule for ordinary event tickets (exclusive cutoff, integer cents, fail-safe). */

const CUTOFF = "2027-03-01T06:00:00.000Z"; // 2027-03-01 00:00 in America/Chicago (CST, UTC-6)
const cutoffMs = Date.parse(CUTOFF);
const ticket = (overrides: Record<string, unknown> = {}) => ({
  price: 40,
  early_bird_enabled: true,
  early_bird_price: 30,
  early_bird_ends_at: CUTOFF,
  ...overrides,
});
const unit = (definition: Parameters<typeof effectiveTicketPrice>[0], nowMs: number) => {
  const result = effectiveTicketPrice(definition, nowMs);
  if (!result.ok) throw new Error(result.reason);
  return result;
};

describe("effectiveTicketPrice: cutoff semantics (exclusive)", () => {
  it("applies early bird well before the cutoff", () => {
    expect(unit(ticket(), cutoffMs - 86_400_000)).toMatchObject({ unitCents: 3000, regularCents: 4000, isEarlyBird: true, earlyBirdExpired: false, earlyBirdEndsAt: CUTOFF });
  });
  it("applies early bird one millisecond before the cutoff", () => {
    expect(unit(ticket(), cutoffMs - 1)).toMatchObject({ unitCents: 3000, isEarlyBird: true });
  });
  it("uses the regular price exactly at the cutoff", () => {
    expect(unit(ticket(), cutoffMs)).toMatchObject({ unitCents: 4000, isEarlyBird: false, earlyBirdExpired: true });
  });
  it("uses the regular price one millisecond after the cutoff and later", () => {
    expect(unit(ticket(), cutoffMs + 1)).toMatchObject({ unitCents: 4000, isEarlyBird: false, earlyBirdExpired: true });
    expect(unit(ticket(), cutoffMs + 365 * 86_400_000).unitCents).toBe(4000);
  });
  it("reads the cutoff as an absolute instant whatever offset notation it is stored in", () => {
    expect(unit(ticket({ early_bird_ends_at: "2027-03-01T00:00:00-06:00" }), cutoffMs - 1).isEarlyBird).toBe(true);
    expect(unit(ticket({ early_bird_ends_at: "2027-03-01T00:00:00-06:00" }), cutoffMs).isEarlyBird).toBe(false);
    expect(unit(ticket({ early_bird_ends_at: "2027-03-01 06:00:00+00" }), cutoffMs).isEarlyBird).toBe(false);
  });
});

describe("effectiveTicketPrice: absent, disabled and invalid configuration", () => {
  it("uses the regular price when early bird is disabled or missing", () => {
    expect(unit(ticket({ early_bird_enabled: false }), cutoffMs - 1)).toMatchObject({ unitCents: 4000, isEarlyBird: false, earlyBirdIgnoredReason: null, earlyBirdEndsAt: null });
    expect(unit({ price: 40 }, cutoffMs - 1)).toMatchObject({ unitCents: 4000, isEarlyBird: false });
    expect(unit(ticket({ early_bird_enabled: null }), cutoffMs - 1).isEarlyBird).toBe(false);
  });
  it("falls back to the regular price (never lower) for an enabled but invalid early-bird configuration", () => {
    expect(unit(ticket({ early_bird_price: null }), cutoffMs - 1)).toMatchObject({ unitCents: 4000, earlyBirdIgnoredReason: "invalid_early_bird_price" });
    expect(unit(ticket({ early_bird_price: -5 }), cutoffMs - 1)).toMatchObject({ unitCents: 4000, earlyBirdIgnoredReason: "invalid_early_bird_price" });
    expect(unit(ticket({ early_bird_price: Number.NaN }), cutoffMs - 1).earlyBirdIgnoredReason).toBe("invalid_early_bird_price");
    expect(unit(ticket({ early_bird_price: "abc" }), cutoffMs - 1).earlyBirdIgnoredReason).toBe("invalid_early_bird_price");
    expect(unit(ticket({ early_bird_price: 40 }), cutoffMs - 1)).toMatchObject({ unitCents: 4000, earlyBirdIgnoredReason: "not_lower_than_regular" });
    expect(unit(ticket({ early_bird_price: 55 }), cutoffMs - 1)).toMatchObject({ unitCents: 4000, earlyBirdIgnoredReason: "not_lower_than_regular" });
    expect(unit(ticket({ early_bird_ends_at: null }), cutoffMs - 1)).toMatchObject({ unitCents: 4000, earlyBirdIgnoredReason: "invalid_cutoff" });
    expect(unit(ticket({ early_bird_ends_at: "not a date" }), cutoffMs - 1).earlyBirdIgnoredReason).toBe("invalid_cutoff");
  });
  it("refuses to price a ticket whose regular price is invalid (no invented amount)", () => {
    for (const price of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY, -1, "", "1e3", "12.345", 12.345, {}, MAX_TICKET_PRICE_CENTS / 100 + 0.01]) {
      expect(effectiveTicketPrice({ price }, cutoffMs), String(price)).toEqual({ ok: false, reason: "invalid_regular_price" });
    }
  });
  it("refuses a non-finite evaluation instant", () => {
    expect(effectiveTicketPrice(ticket(), Number.NaN)).toEqual({ ok: false, reason: "invalid_evaluation_instant" });
  });
  it("accepts numeric strings as returned by PostgREST and free tickets", () => {
    expect(unit(ticket({ price: "40.00", early_bird_price: "29.99" }), cutoffMs - 1)).toMatchObject({ unitCents: 2999, regularCents: 4000 });
    expect(unit({ price: 0 }, cutoffMs)).toMatchObject({ unitCents: 0 });
    expect(unit(ticket({ price: 10, early_bird_price: 0 }), cutoffMs - 1)).toMatchObject({ unitCents: 0, isEarlyBird: true });
  });
});

describe("money in integer minor units", () => {
  it("converts exactly, without float drift", () => {
    expect(toMinorUnits(19.99)).toBe(1999);
    expect(toMinorUnits(0.1 + 0.2)).toBe(30);
    expect(toMinorUnits("1234.50")).toBe(123450);
    expect(fromMinorUnits(1999)).toBe(19.99);
    expect(ticketLineTotalCents(1999, 3)).toBe(5997);
    expect(fromMinorUnits(ticketLineTotalCents(1999, 3)!)).toBe(59.97);
  });
  it("rejects invalid quantities and units", () => {
    expect(ticketLineTotalCents(1999, 0)).toBeNull();
    expect(ticketLineTotalCents(1999, 1.5)).toBeNull();
    expect(ticketLineTotalCents(19.99, 1)).toBeNull();
  });
});

describe("event-local early-bird cutoff (strict, DST-aware)", () => {
  it("interprets the entered wall time in the event's time zone", () => {
    expect(eventLocalToInstant("2027-03-01T00:00", "America/Chicago")).toEqual({ ok: true, iso: CUTOFF });
    expect(eventLocalToInstant("2027-03-01T00:00", "America/New_York")).toEqual({ ok: true, iso: "2027-03-01T05:00:00.000Z" });
    expect(eventLocalToInstant("2027-07-01T18:30", "America/Los_Angeles")).toEqual({ ok: true, iso: "2027-07-02T01:30:00.000Z" });
    expect(eventLocalToInstant("2027-07-01T18:30", "Asia/Kolkata")).toEqual({ ok: true, iso: "2027-07-01T13:00:00.000Z" });
    expect(eventLocalToInstant("2027-07-01T18:30", "UTC")).toEqual({ ok: true, iso: "2027-07-01T18:30:00.000Z" });
  });
  it("gives the same instant whatever the browser or server time zone is", () => {
    // Same input, same zone -> same instant (the old code used the browser offset).
    const a = eventLocalToInstant("2027-11-20T09:15", "Europe/London");
    expect(a).toEqual({ ok: true, iso: "2027-11-20T09:15:00.000Z" });
  });
  it("rejects a wall time that does not exist (spring-forward gap)", () => {
    expect(eventLocalToInstant("2027-03-14T02:30", "America/New_York")).toEqual({ ok: false, reason: "nonexistent_local_time" });
    expect(eventLocalToInstant("2027-03-28T01:30", "Europe/London")).toEqual({ ok: false, reason: "nonexistent_local_time" });
  });
  it("rejects a wall time that happens twice (fall-back overlap)", () => {
    expect(eventLocalToInstant("2027-11-07T01:30", "America/New_York")).toEqual({ ok: false, reason: "ambiguous_local_time" });
    expect(eventLocalToInstant("2027-10-31T01:30", "Europe/London")).toEqual({ ok: false, reason: "ambiguous_local_time" });
  });
  it("accepts the unambiguous times right around the transitions", () => {
    expect(eventLocalToInstant("2027-03-14T01:59", "America/New_York")).toEqual({ ok: true, iso: "2027-03-14T06:59:00.000Z" });
    expect(eventLocalToInstant("2027-03-14T03:00", "America/New_York")).toEqual({ ok: true, iso: "2027-03-14T07:00:00.000Z" });
    expect(eventLocalToInstant("2027-11-07T00:59", "America/New_York")).toEqual({ ok: true, iso: "2027-11-07T04:59:00.000Z" });
    expect(eventLocalToInstant("2027-11-07T02:00", "America/New_York")).toEqual({ ok: true, iso: "2027-11-07T07:00:00.000Z" });
  });
  it("rejects invalid input and zones", () => {
    expect(eventLocalToInstant("", "America/Chicago")).toEqual({ ok: false, reason: "invalid_format" });
    expect(eventLocalToInstant("2027-02-30T10:00", "America/Chicago")).toEqual({ ok: false, reason: "invalid_date" });
    expect(eventLocalToInstant("2027-13-01T10:00", "America/Chicago")).toEqual({ ok: false, reason: "invalid_date" });
    expect(eventLocalToInstant("2027-03-01T24:00", "America/Chicago")).toEqual({ ok: false, reason: "invalid_date" });
    expect(eventLocalToInstant("2027-03-01T10:00", "Mars/Olympus")).toEqual({ ok: false, reason: "invalid_time_zone" });
    expect(isValidTimeZone("America/Chicago")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
  });
  it("round-trips the stored instant back to the editor input in the event's zone", () => {
    expect(instantToEventLocalInput(CUTOFF, "America/Chicago")).toBe("2027-03-01T00:00");
    expect(instantToEventLocalInput("2027-11-07T05:30:00.000Z", "America/New_York")).toBe("2027-11-07T01:30");
    expect(instantToEventLocalInput(null, "America/Chicago")).toBe("");
    expect(instantToEventLocalInput("garbage", "America/Chicago")).toBe("");
  });
});

describe("web / native parity", () => {
  const ROOT = join(__dirname, "..", "..", "..", "..");
  it("the Expo app carries an identical copy of the pricing rule", () => {
    const web = readFileSync(join(ROOT, "src/lib/events/ticketPricing.ts"), "utf8");
    const mobile = readFileSync(join(ROOT, "mobile/student/src/lib/ticketPricing.ts"), "utf8");
    expect(mobile).toBe(web);
  });
  // Identical source => identical behaviour for every ticket and instant. (The Expo file cannot be imported here: it
  // resolves under the Expo tsconfig.) The native checkout route itself imports the web module.
  it("the shared rule decides a fixed grid of tickets and instants exactly as specified", () => {
    const fixtures = [ticket(), ticket({ early_bird_enabled: false }), ticket({ early_bird_price: 45 }), ticket({ price: "19.99", early_bird_price: "9.99" }), { price: "bad" }];
    const instants = [cutoffMs - 86_400_000, cutoffMs - 1, cutoffMs, cutoffMs + 1];
    const grid = fixtures.map((fixture) => instants.map((now) => { const r = effectiveTicketPrice(fixture, now); return r.ok ? r.unitCents : r.reason; }));
    expect(grid).toEqual([
      [3000, 3000, 4000, 4000],
      [4000, 4000, 4000, 4000],
      [4000, 4000, 4000, 4000],
      [999, 999, 1999, 1999],
      ["invalid_regular_price", "invalid_regular_price", "invalid_regular_price", "invalid_regular_price"],
    ]);
  });
});

describe("withEffectiveTicketPricing (form props)", () => {
  it("attaches the server-computed effective price and marks unpriceable tickets as unavailable", async () => {
    const { withEffectiveTicketPricing } = await import("@/lib/events/ticketDisplayPricing");
    const [early, broken, expired] = withEffectiveTicketPricing(
      [ticket(), { price: "bad", early_bird_enabled: false }, ticket()],
      cutoffMs - 1,
    );
    expect(early).toMatchObject({ effectiveUnitPriceCents: 3000, regularUnitPriceCents: 4000, isEarlyBird: true, earlyBirdEndsAt: CUTOFF });
    expect(broken).toMatchObject({ effectiveUnitPriceCents: null, regularUnitPriceCents: null, isEarlyBird: false });
    expect(withEffectiveTicketPricing([ticket()], cutoffMs)[0]).toMatchObject({ effectiveUnitPriceCents: 4000, isEarlyBird: false, earlyBirdEndsAt: null });
    expect(expired.effectiveUnitPriceCents).toBe(3000);
  });
});
