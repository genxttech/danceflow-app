import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PRICE_KINDS } from "@/lib/sms/priceChange";
import { isMicroPriceKind, microsToUsd, usdToMicros } from "@/lib/sms/priceMicros";

type Entry = { order: number; kind: string; unit: string; priceMicros?: number; costMicros?: number; priceUsd?: string; costUsd?: string; priceCents?: number; costCents?: number; description: string; reason: string };
const manifest = JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "..", "docs", "twilio", "pricing", "ConfiDance_pilot_price_manifest.json"), "utf8")) as { status: string; prices: Entry[] };

/** The database's own proposal rules, restated: a manifest entry the form or the database would refuse is caught here, before anyone is waiting on a 24 hour cooling-off. */
describe("ConfiDance pilot price manifest (data only; nothing is published by it)", () => {
  it("is explicitly a proposal, not an approval", () => {
    expect(manifest.status).toBe("PROPOSED_NOT_APPROVED");
  });
  it("lists exactly the six Low Volume path kinds, once each, in order", () => {
    expect(manifest.prices.map((p) => p.kind)).toEqual(["sms_usage", "sms_inbound", "brand_low_volume", "campaign_vetting", "monthly_low_volume", "number"]);
    expect(manifest.prices.map((p) => p.order)).toEqual([1, 2, 3, 4, 5, 6]);
    for (const p of manifest.prices) expect(PRICE_KINDS, p.kind).toContain(p.kind);
  });
  it("the per-segment kinds are micro-dollars equal to the approved rates; the fixed-fee kinds are whole cents", () => {
    const by = Object.fromEntries(manifest.prices.map((p) => [p.kind, p]));
    expect(by.sms_usage.priceMicros).toBe(17000);
    expect(by.sms_inbound.priceMicros).toBe(13000);
    for (const p of manifest.prices) {
      if (isMicroPriceKind(p.kind)) {
        expect(p.unit).toBe("micro-dollars");
        expect(p.priceMicros).toBeGreaterThanOrEqual(1);
        expect(p.priceMicros).toBeLessThanOrEqual(10_000_000);
        expect(p.costMicros).toBeGreaterThanOrEqual(0);
        expect(usdToMicros(p.priceUsd!)).toBe(p.priceMicros);
        expect(usdToMicros(p.costUsd!)).toBe(p.costMicros);
        expect(p.priceCents).toBeUndefined();
      } else {
        expect(p.unit).toBe("cents");
        expect(Number.isInteger(p.priceCents) && p.priceCents! > 0 && p.priceCents! <= 10_000_000, p.kind).toBe(true);
        expect(Number.isInteger(p.costCents) && p.costCents! >= 0 && p.costCents! <= 10_000_000, p.kind).toBe(true);
        expect(p.priceMicros).toBeUndefined();
      }
    }
  });
  it("every price is above its expected cost", () => {
    for (const p of manifest.prices) {
      if (isMicroPriceKind(p.kind)) expect(p.priceMicros!, p.kind).toBeGreaterThan(p.costMicros!);
      else expect(p.priceCents!, p.kind).toBeGreaterThan(p.costCents!);
    }
  });
  it("descriptions (3 to 200) and reasons (10 to 500) satisfy the database limits", () => {
    for (const p of manifest.prices) {
      expect(p.description.trim().length, p.kind).toBeGreaterThanOrEqual(3);
      expect(p.description.trim().length, p.kind).toBeLessThanOrEqual(200);
      expect(p.reason.trim().length, p.kind).toBeGreaterThanOrEqual(10);
      expect(p.reason.trim().length, p.kind).toBeLessThanOrEqual(500);
    }
  });
  it("the Low Volume setup total at customer prices matches the decision package ($31.90 with the first month and the number)", () => {
    const c = Object.fromEntries(manifest.prices.filter((p) => !isMicroPriceKind(p.kind)).map((p) => [p.kind, p.priceCents!]));
    expect(c.brand_low_volume + c.campaign_vetting + c.monthly_low_volume + c.number).toBe(3190);
    expect(microsToUsd(17000)).toBe("$0.017");
  });
});
