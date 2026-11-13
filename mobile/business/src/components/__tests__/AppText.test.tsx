import { platformTypeStyle } from "@/components/AppText";
import { type as typeScale } from "@/theme";

describe("platformTypeStyle", () => {
  it("drops the fixed line height on Android so native layout fits the font at any system text size", () => {
    const android = platformTypeStyle("lead", "android");
    expect("lineHeight" in android).toBe(false);
    expect(android).toEqual({ fontSize: typeScale.lead.fontSize, fontWeight: typeScale.lead.fontWeight });
  });

  it("keeps the type scale's line height on iOS (which scales it with Dynamic Type) and web", () => {
    expect(platformTypeStyle("body", "ios")).toBe(typeScale.body);
    expect(platformTypeStyle("body", "web")).toBe(typeScale.body);
  });
});
