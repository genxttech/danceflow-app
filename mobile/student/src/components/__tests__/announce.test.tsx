import { render } from "@testing-library/react-native";
import { AccessibilityInfo } from "react-native";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Announce } from "@/components/Announce";
import { WARM_UP_TIMEOUT_MS, warmUpRenderer } from "@/test/warmUpRenderer";

jest.mock("@react-native-async-storage/async-storage", () =>
  jest.requireActual("@react-native-async-storage/async-storage/jest/async-storage-mock"),
);

beforeAll(warmUpRenderer, WARM_UP_TIMEOUT_MS);

describe("Announce (VoiceOver has no live regions)", () => {
  let spy: jest.SpyInstance;
  beforeEach(() => { spy = jest.spyOn(AccessibilityInfo, "announceForAccessibility").mockImplementation(() => undefined); });
  afterEach(() => spy.mockRestore());

  it("announces a message once on iOS, and again only when it changes", () => {
    const { rerender } = render(<Announce message="Payment requests are up to date." os="ios" />);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("Payment requests are up to date.");
    rerender(<Announce message="Payment requests are up to date." os="ios" />);
    expect(spy).toHaveBeenCalledTimes(1);
    rerender(<Announce message="Checking your payment status..." os="ios" />);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("says nothing for an empty message, and nothing on Android (its live region speaks)", () => {
    render(<Announce message={null} os="ios" />);
    render(<Announce message="Something failed" os="android" />);
    expect(spy).not.toHaveBeenCalled();
  });

  it("is wired next to every live-region message", () => {
    const root = join(__dirname, "..", "..", "..");
    const files = ["src/components/ErrorState.tsx", "app/wallet/payment-requests.tsx", "app/events/orders/[orderId].tsx", "app/events/[id]/register.tsx"];
    for (const f of files) expect(readFileSync(join(root, f), "utf8")).toContain("<Announce ");
  });
});
