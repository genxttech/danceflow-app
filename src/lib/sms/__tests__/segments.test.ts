import { describe, expect, it } from "vitest";
import { estimateBilledSegments } from "../segments";

const seg = (body: string) => estimateBilledSegments(body).segments;

describe("estimateBilledSegments", () => {
  it("counts an empty body as 0", () => {
    expect(seg("")).toBe(0);
  });

  it("GSM-7 boundaries: 160 / 306 / 307", () => {
    expect(seg("a".repeat(160))).toBe(1);
    expect(seg("a".repeat(161))).toBe(2);
    expect(seg("a".repeat(306))).toBe(2);
    expect(seg("a".repeat(307))).toBe(3);
    expect(estimateBilledSegments("a".repeat(161)).encoding).toBe("gsm7");
  });

  it("extension characters take two septets", () => {
    expect(estimateBilledSegments("a".repeat(158) + "€").units).toBe(160);
    expect(seg("a".repeat(158) + "€")).toBe(1);
    expect(seg("a".repeat(159) + "€")).toBe(2);
  });

  it("uses 152 per part when an extension character is present", () => {
    expect(seg("a".repeat(302) + "€")).toBe(2); // 304 septets
    expect(seg("a".repeat(303) + "€")).toBe(3); // 305 septets
  });

  it("a non-GSM character switches to UCS-2", () => {
    expect(estimateBilledSegments("a".repeat(69) + "✓").encoding).toBe("ucs2");
    expect(seg("a".repeat(69) + "✓")).toBe(1); // 70 units
    expect(seg("a".repeat(70) + "✓")).toBe(2); // 71 units
    expect(seg("a".repeat(133) + "✓")).toBe(2); // 134 units
    expect(seg("a".repeat(134) + "✓")).toBe(3); // 135 units
  });

  it("emoji count as two UTF-16 units", () => {
    expect(seg("😀".repeat(35))).toBe(1);
    expect(seg("😀".repeat(36))).toBe(2);
  });

  it("newline and carriage return are GSM", () => {
    expect(estimateBilledSegments("a\nb\rc").encoding).toBe("gsm7");
    expect(estimateBilledSegments("a\nb\rc").units).toBe(5);
  });

  it("matches the database _tw4us_segments parity cases", () => {
    expect(seg("hello")).toBe(1);
    expect(seg("a".repeat(160))).toBe(1);
    expect(seg("a".repeat(161))).toBe(2);
    expect(seg("a".repeat(158) + "€")).toBe(1);
    expect(seg("héllo ✓")).toBe(1);
    expect(seg("😀".repeat(35))).toBe(1);
    expect(seg("😀".repeat(36))).toBe(2);
  });
});
