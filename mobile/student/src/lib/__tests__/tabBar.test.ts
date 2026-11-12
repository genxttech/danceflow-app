import { tabBarMetrics } from "@/lib/tabBar";

describe("tabBarMetrics", () => {
  it("has an explicit numeric height at the default text size (never 'auto')", () => {
    // 8 top + max(48, 24 icon + 4 gap + ceil(11 × 1.35)) + (inset 24 + 8)
    expect(tabBarMetrics(1, 24)).toEqual({ height: 8 + 48 + 32, paddingTop: 8, paddingBottom: 32 });
  });

  it("grows with the system font scale so labels are never clipped", () => {
    const at200 = tabBarMetrics(2, 24);
    expect(at200.height).toBe(8 + (24 + 4 + Math.ceil(11 * 1.35 * 2)) + 32);
    expect(at200.height).toBeGreaterThan(tabBarMetrics(1, 24).height);
  });

  it("adds the bottom inset (three-button navigation, gesture bar, none)", () => {
    expect(tabBarMetrics(1, 48).paddingBottom).toBe(56);
    expect(tabBarMetrics(1, 0).paddingBottom).toBe(8);
  });

  it("never shrinks below the default for small or invalid scales", () => {
    expect(tabBarMetrics(0.85, 0).height).toBe(tabBarMetrics(1, 0).height);
    expect(tabBarMetrics(Number.NaN, 0).height).toBe(tabBarMetrics(1, 0).height);
  });
});
