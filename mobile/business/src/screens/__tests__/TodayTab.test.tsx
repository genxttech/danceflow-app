import { fireEvent, render, screen } from "@testing-library/react-native";
import { fakeApi, StaffTestProviders, workspace } from "@/test-utils/staff";

jest.mock("expo-router", () => ({ router: { push: jest.fn() } }));
jest.mock("react-native-safe-area-context", () => {
  const { View } = jest.requireActual("react-native");
  return { SafeAreaView: View };
});

const flags = { studioSchedule: true };
jest.mock("@/lib/features", () => ({
  ...jest.requireActual("@/lib/features"),
  isStaffFeatureEnabled: (feature: string) => (feature === "studioSchedule" ? flags.studioSchedule : true),
}));

function renderTab(role: string) {
  const api = fakeApi({
    today: jest.fn(async () => ({ studioId: "studio-1", date: "2026-11-09", timeZone: "America/New_York", instructorId: "i1", appointments: [] })),
    studioSchedule: jest.fn(async () => ({ studioId: "studio-1", date: "2026-11-09", timeZone: "America/New_York", truncated: false, appointments: [] })),
  });
  const Tab = require("../../../app/(tabs)/today").default; // eslint-disable-line @typescript-eslint/no-require-imports
  render(
    <StaffTestProviders api={api} ws={workspace({ role })}>
      <Tab />
    </StaffTestProviders>,
  );
  return api;
}

describe("Today tab", () => {
  beforeEach(() => {
    flags.studioSchedule = true;
  });

  it.each(["front_desk", "studio_owner", "studio_admin"])("%s can switch to the studio's day and back", async (role) => {
    {
      const api = renderTab(role);
      expect(await screen.findByTestId("day-mode-switch")).toBeTruthy();
      expect(api.today).toHaveBeenCalled();
      fireEvent.press(screen.getByRole("radio", { name: "Studio" }));
      expect(await screen.findByTestId("studio-empty")).toBeTruthy();
      expect(api.studioSchedule).toHaveBeenCalled();
      fireEvent.press(screen.getByRole("radio", { name: "My day" }));
      expect(await screen.findByTestId("today-empty")).toBeTruthy();
      expect(api.today).toHaveBeenCalledTimes(2);
      screen.unmount();
    }
  }, 20_000);

  it("an instructor keeps Today with no switch, and never calls the studio route", async () => {
    const api = renderTab("instructor");
    expect(await screen.findByTestId("today-empty")).toBeTruthy();
    expect(screen.queryByTestId("day-mode-switch")).toBeNull();
    expect(api.studioSchedule).not.toHaveBeenCalled();
  });

  it("with the flag off nobody gets the switch", async () => {
    flags.studioSchedule = false;
    const api = renderTab("front_desk");
    expect(await screen.findByTestId("today-empty")).toBeTruthy();
    expect(screen.queryByTestId("day-mode-switch")).toBeNull();
    expect(api.studioSchedule).not.toHaveBeenCalled();
  });
});
