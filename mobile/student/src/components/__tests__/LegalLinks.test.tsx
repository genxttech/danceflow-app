import { fireEvent, render, screen } from "@testing-library/react-native";
import { Linking } from "react-native";
import { LegalLinks, legalUrl } from "@/components/LegalLinks";
import { AppButton } from "@/components/AppButton";

jest.mock("@react-native-async-storage/async-storage", () =>
  jest.requireActual("@react-native-async-storage/async-storage/jest/async-storage-mock"),
);

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
