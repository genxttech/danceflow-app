import { tabBarHeight } from "../../../app/(tabs)/_layout";

jest.mock("@expo/vector-icons", () => ({ Feather: { glyphMap: {} } }));
jest.mock("expo-router", () => ({ Tabs: () => null }));

describe("tabBarHeight", () => {
  it("grows with the system text size so labels are not clipped", () => {
    expect(tabBarHeight(2, 0)).toBeGreaterThan(tabBarHeight(1, 0));
    expect(tabBarHeight(2, 0) - tabBarHeight(1, 0)).toBe(Math.ceil(12 * 1.35 * 2) - Math.ceil(12 * 1.35));
  });

  it("includes the bottom safe-area inset (edge-to-edge gesture bar)", () => {
    expect(tabBarHeight(1, 48) - tabBarHeight(1, 0)).toBe(48);
  });

  it("never shrinks below the 100% layout", () => {
    expect(tabBarHeight(0.85, 0)).toBe(tabBarHeight(1, 0));
  });
});
