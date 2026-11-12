import { fireEvent, render, screen } from "@testing-library/react-native";
import { Linking } from "react-native";
import { LegalLinks, legalUrl } from "@/components/LegalLinks";
import { AppButton } from "@/components/AppButton";

jest.mock("@react-native-async-storage/async-storage", () =>
  jest.requireActual("@react-native-async-storage/async-storage/jest/async-storage-mock"),
);

import { WARM_UP_TIMEOUT_MS, warmUpRenderer } from "@/test/warmUpRenderer";

// One-off renderer load, outside the tests' own timeouts (see warmUpRenderer).
beforeAll(warmUpRenderer, WARM_UP_TIMEOUT_MS);

describe("LegalLinks", () => {
  it("points at the live web pages", () => {
    expect(legalUrl("privacy")).toBe("https://danceflow.test/privacy");
    expect(legalUrl("terms")).toBe("https://danceflow.test/terms");
  });

  it("opens each page from a link", () => {
    const open = jest.spyOn(Linking, "openURL").mockResolvedValue(undefined);
    render(<LegalLinks prefix="By continuing you agree to the DanceFlow" />);

    fireEvent.press(screen.getByRole("link", { name: "Terms" }));
    fireEvent.press(screen.getByRole("link", { name: "Privacy Policy" }));

    expect(open.mock.calls).toEqual([
      ["https://danceflow.test/terms"],
      ["https://danceflow.test/privacy"],
    ]);
  });
});

describe("AppButton", () => {
  it("passes the pressed state to a style function", () => {
    const style = jest.fn(() => null);
    render(<AppButton label="Save" onPress={jest.fn()} style={style} />);

    expect(style).toHaveBeenCalledWith({ pressed: false });
  });
});

describe("AppText on Android", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { platformTextStyle } = require("@/components/AppText") as typeof import("@/components/AppText");

  it("drops every fixed lineHeight on Android, so large system text is never clipped", () => {
    const style = platformTextStyle([{ fontSize: 36, lineHeight: 40 }, { color: "#000", lineHeight: 31 }], "android");
    expect(style).toEqual({ fontSize: 36, color: "#000" });
  });

  it("keeps the type rhythm on iOS and web", () => {
    const style = [{ fontSize: 36, lineHeight: 40 }];
    expect(platformTextStyle(style, "ios")).toBe(style);
    expect(platformTextStyle(style, "web")).toBe(style);
  });
});

describe("AppText font scaling cap", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { AppText } = require("@/components/AppText") as typeof import("@/components/AppText");

  it("caps scaling at 1.35 by default and lets a caller lower it (the ticket code stays on one line)", () => {
    const { getByText } = render(
      <>
        <AppText>Body</AppText>
        <AppText maxFontSizeMultiplier={1}>HLD-HM-7Q2K-1842</AppText>
      </>
    );
    expect(getByText("Body").props.maxFontSizeMultiplier).toBe(1.35);
    expect(getByText("HLD-HM-7Q2K-1842").props.maxFontSizeMultiplier).toBe(1);
  });
});
