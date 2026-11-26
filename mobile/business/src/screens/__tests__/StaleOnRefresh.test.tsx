import { act, fireEvent, render, screen } from "@testing-library/react-native";
import type React from "react";
import { RefreshControl } from "react-native";
import { StaleBanner } from "@/components/StaleBanner";
import { parseStaffFeatures } from "@/lib/features";
import { shouldKeepStale } from "@/lib/stale";
import { StaffApiError, type StaffPulse, type StaffStudioDay, type StaffToday } from "@/lib/staffApi";
import { PulseScreen } from "@/screens/PulseScreen";
import { StudioScheduleScreen } from "@/screens/StudioScheduleScreen";
import { TodayScreen } from "@/screens/TodayScreen";
import { fakeApi, STUDIO_ID, StaffTestProviders } from "@/test-utils/staff";

// the first render of a suite is slow on a loaded machine (cold transform); the default 5 s flaked in full runs
jest.setTimeout(20_000);

jest.mock("expo-router", () => ({ router: { push: jest.fn() }, useFocusEffect: (effect: () => void | (() => void)) => jest.requireActual<typeof import("react")>("react").useEffect(effect, [effect]) }));
jest.mock("react-native-safe-area-context", () => {
  const { View } = jest.requireActual("react-native");
  return { SafeAreaView: View };
});
const flags = { keepStale: true };
jest.mock("@/lib/features", () => ({
  ...jest.requireActual("@/lib/features"),
  isStaffFeatureEnabled: (feature: string) => (feature === "keepStale" ? flags.keepStale : true),
}));

const PULSE: StaffPulse = {
  studioId: STUDIO_ID,
  timeZone: "America/New_York",
  date: "2026-11-09",
  asOf: "2026-11-09T15:30:00.000Z",
  scope: "studio",
  instructorId: null,
  today: { total: 5, upcoming: 4, cancelled: 1, truncated: false },
  next: null,
  newClientsLast7Days: 3,
};
const TODAY: StaffToday = { studioId: STUDIO_ID, date: "2026-11-09", timeZone: "America/New_York", instructorId: "i1", appointments: [] };
const DAY: StaffStudioDay = { studioId: STUDIO_ID, date: "2026-11-09", timeZone: "America/New_York", truncated: false, appointments: [] };

const outage = () => new StaffApiError(503, "service_unavailable", "x");

const CASES: [string, "pulse" | "today" | "studioSchedule", unknown, React.ReactElement, string][] = [
  ["Pulse", "pulse", PULSE, <PulseScreen key="p" />, "pulse-today"],
  ["Today", "today", TODAY, <TodayScreen key="t" />, "today-empty"],
  ["Studio schedule", "studioSchedule", DAY, <StudioScheduleScreen key="s" />, "studio-empty"],
];

function renderScreen(method: "pulse" | "today" | "studioSchedule", jestFn: jest.Mock, element: React.ReactElement) {
  const api = fakeApi({ [method]: jestFn });
  render(<StaffTestProviders api={api}>{element}</StaffTestProviders>);
  return api;
}

async function pullToRefresh() {
  await act(async () => {
    screen.UNSAFE_getByType(RefreshControl).props.onRefresh();
  });
}

beforeEach(() => {
  flags.keepStale = true;
});

describe.each(CASES)("%s: a failed refresh", (_name, method, data, element, dataTestId) => {
  it("keeps the data on screen with a banner that says when it was loaded, and Try again brings fresh data back", async () => {
    const load = jest.fn().mockResolvedValueOnce(data).mockRejectedValueOnce(outage()).mockResolvedValueOnce(data);
    renderScreen(method, load, element);
    expect(await screen.findByTestId(dataTestId)).toBeTruthy();

    await pullToRefresh();
    expect(screen.getByTestId("stale-banner")).toBeTruthy();
    expect(screen.getByText(/^Couldn't refresh\. Showing what was loaded at \d{1,2}:\d{2} (AM|PM)\.$/)).toBeTruthy();
    expect(screen.getByTestId(dataTestId)).toBeTruthy(); // the numbers are still there
    expect(screen.queryByTestId("error-unavailable")).toBeNull();

    await act(async () => fireEvent.press(screen.getByRole("button", { name: "Try again" })));
    expect(load).toHaveBeenCalledTimes(3);
    expect(screen.queryByTestId("stale-banner")).toBeNull();
    expect(screen.getByTestId(dataTestId)).toBeTruthy();
  });

  it("a refused session is an answer, not an outage: the data is replaced by Sign in again", async () => {
    const load = jest.fn().mockResolvedValueOnce(data).mockRejectedValueOnce(new StaffApiError(401, "unauthenticated", "x"));
    renderScreen(method, load, element);
    await screen.findByTestId(dataTestId);
    await pullToRefresh();
    expect(screen.queryByTestId("stale-banner")).toBeNull();
    expect(screen.getByTestId("error-sign-in-again")).toBeTruthy();
  });

  it("with the flag off the outage replaces the data, as before", async () => {
    flags.keepStale = false;
    const load = jest.fn().mockResolvedValueOnce(data).mockRejectedValueOnce(outage());
    renderScreen(method, load, element);
    await screen.findByTestId(dataTestId);
    await pullToRefresh();
    expect(screen.queryByTestId("stale-banner")).toBeNull();
    expect(screen.getByTestId("error-unavailable")).toBeTruthy();
  });

  it("a first load that fails has nothing to keep and shows the error", async () => {
    renderScreen(method, jest.fn().mockRejectedValue(outage()), element);
    expect(await screen.findByTestId("error-unavailable")).toBeTruthy();
    expect(screen.queryByTestId("stale-banner")).toBeNull();
  });
});

describe("shouldKeepStale and the flag", () => {
  it("is only a transient failure of a refresh that already had data, with the flag on", () => {
    const base = { enabled: true, mode: "refresh" as const, hadData: true, error: outage() };
    expect(shouldKeepStale(base)).toBe(true);
    expect(shouldKeepStale({ ...base, enabled: false })).toBe(false);
    expect(shouldKeepStale({ ...base, mode: "initial" })).toBe(false);
    expect(shouldKeepStale({ ...base, hadData: false })).toBe(false);
    for (const code of ["unauthenticated", "role_not_permitted", "not_a_member", "workspace_paused", "account_inactive"] as const) {
      expect(shouldKeepStale({ ...base, error: new StaffApiError(403, code, "x") })).toBe(false);
    }
    expect(shouldKeepStale({ ...base, error: new StaffApiError(0, "network_error", "x") })).toBe(true);
  });

  it("is off by default and named per build", () => {
    expect(parseStaffFeatures(undefined).has("keepStale")).toBe(false);
    expect(parseStaffFeatures("keepStale").has("keepStale")).toBe(true);
  });

  it("the banner is an alert with a named retry", () => {
    const onRetry = jest.fn();
    render(<StaleBanner loadedAt={Date.UTC(2026, 10, 9, 15, 30)} timeZone="America/New_York" onRetry={onRetry} />);
    expect(screen.getByTestId("stale-banner").props.accessibilityRole).toBe("alert");
    expect(screen.getByText("Couldn't refresh. Showing what was loaded at 10:30 AM.")).toBeTruthy();
    fireEvent.press(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
