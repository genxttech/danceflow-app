import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { Linking } from "react-native";
import { AppUpdateNotice } from "@/components/AppUpdateNotice";
import { dismissNotice, isNoticeDismissed, loadAppConfig, ownBuildNumber } from "@/lib/appConfig";
import { WARM_UP_TIMEOUT_MS, warmUpRenderer } from "@/test/warmUpRenderer";

jest.unmock("@/components/AppUpdateNotice");
jest.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));
jest.mock("@react-native-async-storage/async-storage", () =>
  jest.requireActual("@react-native-async-storage/async-storage/jest/async-storage-mock"),
);
jest.mock("@/lib/appConfig", () => ({
  ...jest.requireActual("@/lib/appConfig"),
  loadAppConfig: jest.fn(),
  ownBuildNumber: jest.fn(),
  isNoticeDismissed: jest.fn(),
  dismissNotice: jest.fn(async () => undefined),
}));

const PLAY = "https://play.google.com/store/apps/details?id=com.idanceflow.student";

beforeAll(warmUpRenderer, WARM_UP_TIMEOUT_MS);
beforeEach(() => {
  jest.mocked(loadAppConfig).mockResolvedValue({ recommendedCode: 4, storeUrl: PLAY });
  jest.mocked(ownBuildNumber).mockReturnValue(3);
  jest.mocked(isNoticeDismissed).mockResolvedValue(false);
});

describe("AppUpdateNotice", () => {
  it("offers the update and opens only the store page", async () => {
    const open = jest.spyOn(Linking, "openURL").mockResolvedValue(true as never);
    render(<AppUpdateNotice />);
    expect(await screen.findByText("Update available")).toBeTruthy();
    fireEvent.press(screen.getByText("Update"));
    await waitFor(() => expect(open).toHaveBeenCalledWith(PLAY));
    open.mockRestore();
  });

  it("goes away on Not now and remembers it", async () => {
    render(<AppUpdateNotice />);
    fireEvent.press(await screen.findByText("Not now"));
    expect(screen.queryByText("Update available")).toBeNull();
    expect(dismissNotice).toHaveBeenCalledWith(4);
  });

  it("has no Update button without a store link", async () => {
    jest.mocked(loadAppConfig).mockResolvedValue({ recommendedCode: 4, storeUrl: null });
    render(<AppUpdateNotice />);
    expect(await screen.findByText("Not now")).toBeTruthy();
    expect(screen.queryByText("Update")).toBeNull();
  });

  it.each([
    ["no configuration", () => jest.mocked(loadAppConfig).mockResolvedValue(null)],
    ["an up-to-date build", () => jest.mocked(ownBuildNumber).mockReturnValue(4)],
    ["an unknown build number", () => jest.mocked(ownBuildNumber).mockReturnValue(null)],
    ["a dismissed notice", () => jest.mocked(isNoticeDismissed).mockResolvedValue(true)],
  ])("renders nothing for %s", async (_name, arrange) => {
    arrange();
    render(<AppUpdateNotice />);
    await waitFor(() => expect(loadAppConfig).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.toJSON()).toBeNull();
  });
});
