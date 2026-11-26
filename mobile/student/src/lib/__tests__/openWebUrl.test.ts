import { Linking } from "react-native";
import { openWebUrl, safeWebUrl } from "@/lib/openWebUrl";

describe("safeWebUrl", () => {
  it("keeps http and https links", () => {
    expect(safeWebUrl(" https://studio.example.test/apply ")).toBe("https://studio.example.test/apply");
    expect(safeWebUrl("http://studio.example.test")).toBe("http://studio.example.test/");
    expect(safeWebUrl("HTTPS://studio.example.test/Apply")?.toLowerCase()).toBe("https://studio.example.test/apply");
  });

  it("treats a bare host as https", () => {
    expect(safeWebUrl("studio.example.test/apply")).toBe("https://studio.example.test/apply");
    expect(safeWebUrl("www.studio.example.test")).toBe("https://www.studio.example.test/");
  });

  it.each([
    "intent://scan/#Intent;scheme=zxing;end",
    "javascript:alert(1)",
    "danceflow://auth/callback?token_hash=abc&type=magiclink",
    "market://details?id=com.example",
    "file:///data/data/x",
    "tel:+15555550100",
    "tel:+1.555.555.0100",
    "javascript:alert(document.cookie)",
    "intent:x.y",
    "not a url",
    "",
    "   ",
  ])("refuses %p", (value) => {
    expect(safeWebUrl(value)).toBeNull();
  });

  it("refuses null and undefined", () => {
    expect(safeWebUrl(null)).toBeNull();
    expect(safeWebUrl(undefined)).toBeNull();
  });
});

describe("openWebUrl", () => {
  const open = jest.spyOn(Linking, "openURL");
  beforeEach(() => open.mockReset());
  afterAll(() => open.mockRestore());

  it("opens a web link", async () => {
    open.mockResolvedValue(true as never);
    await expect(openWebUrl("https://studio.example.test/")).resolves.toBe(true);
    expect(open).toHaveBeenCalledWith("https://studio.example.test/");
  });

  it("opens nothing for a custom scheme", async () => {
    await expect(openWebUrl("danceflow://auth/callback?token_hash=abc")).resolves.toBe(false);
    expect(open).not.toHaveBeenCalled();
  });

  it("returns false instead of throwing when the device cannot open the link", async () => {
    open.mockRejectedValue(new Error("no handler"));
    await expect(openWebUrl("https://studio.example.test/")).resolves.toBe(false);
  });
});
