import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fireEvent, render, screen } from "@testing-library/react-native";
import { Linking } from "react-native";
import { AccountDeletionLink, HelpLinks, LegalLinks, legalUrl } from "@/components/LegalLinks";
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

  it("links the in-app delete button to the public account-deletion page", () => {
    expect(legalUrl("accountDeletion")).toBe("https://danceflow.test/account-deletion");
    const open = jest.spyOn(Linking, "openURL").mockResolvedValue(undefined);
    render(<AccountDeletionLink />);
    fireEvent.press(screen.getByRole("link", { name: "How account deletion works" }));
    expect(open).toHaveBeenCalledWith("https://danceflow.test/account-deletion");
    open.mockRestore();
  });

  it("opens the public help, security and DPA pages", () => {
    const open = jest.spyOn(Linking, "openURL").mockResolvedValue(undefined);
    render(<HelpLinks />);
    fireEvent.press(screen.getByRole("link", { name: "Help Center" }));
    fireEvent.press(screen.getByRole("link", { name: "Security" }));
    fireEvent.press(screen.getByRole("link", { name: "Data Processing Agreement" }));
    expect(open.mock.calls).toEqual([
      ["https://danceflow.test/knowledgebase"],
      ["https://danceflow.test/security"],
      ["https://danceflow.test/dpa"],
    ]);
    open.mockRestore();
  });

  it("sits beside the Delete Account button on the settings screen", () => {
    const settings = readFileSync(join(__dirname, "..", "..", "..", "app", "settings.tsx"), "utf8");
    const button = settings.indexOf("label=\"Delete Account\"");
    expect(button).toBeGreaterThan(-1);
    expect(settings.indexOf("<AccountDeletionLink />")).toBeGreaterThan(button);
  });
});
