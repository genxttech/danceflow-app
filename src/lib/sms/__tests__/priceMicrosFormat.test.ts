import { describe, expect, it } from "vitest";
import { isMicroPriceKind, microsToUsd, usdToMicros } from "@/lib/sms/priceChange";

describe("micro-dollar price formatting (TW-4F price publication)", () => {
  it("reads dollar text as exact whole micro-dollars", () => {
    expect(usdToMicros("0.017")).toBe(17000);
    expect(usdToMicros("0.013")).toBe(13000);
    expect(usdToMicros("0.0127")).toBe(12700);
    expect(usdToMicros("0.000001")).toBe(1);
    expect(usdToMicros("10")).toBe(10_000_000);
    expect(usdToMicros(" 0.02 ")).toBe(20000);
  });
  it("refuses zero, too many decimals, negatives, exponents and anything above $10", () => {
    for (const bad of ["0", "0.0000001", "-0.017", "1e-2", "10.000001", "100", "", ".017", "0,017", "abc"]) expect(usdToMicros(bad)).toBeNull();
  });
  it("formats micro-dollars without float drift", () => {
    expect(microsToUsd(17000)).toBe("$0.017");
    expect(microsToUsd(13000)).toBe("$0.013");
    expect(microsToUsd(20000)).toBe("$0.020");
    expect(microsToUsd(12700)).toBe("$0.0127");
    expect(microsToUsd(1_000_000)).toBe("$1.000");
    expect(microsToUsd(null)).toBe("none");
  });
  it("only the two per-segment kinds are micro-priced", () => {
    expect(isMicroPriceKind("sms_usage")).toBe(true);
    expect(isMicroPriceKind("sms_inbound")).toBe(true);
    for (const k of ["brand", "brand_low_volume", "campaign_vetting", "number", "monthly", "monthly_low_volume"]) expect(isMicroPriceKind(k)).toBe(false);
  });
});
