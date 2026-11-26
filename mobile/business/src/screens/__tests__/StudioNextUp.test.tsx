import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { router } from "expo-router";
import { toStaffStudioDay } from "@/lib/staffApi";
import { StudioScheduleScreen } from "@/screens/StudioScheduleScreen";
import { auditA11y } from "@/test-utils/a11y";
import { fakeApi, STUDIO_ID, StaffTestProviders, workspace } from "@/test-utils/staff";

jest.setTimeout(20_000);

const mockFeatures = new Set<string>();
jest.mock("@/lib/features", () => ({
  ...jest.requireActual("@/lib/features"),
  isStaffFeatureEnabled: (feature: string) => mockFeatures.has(feature),
}));
const mockFocus: { effect: null | (() => void) } = { effect: null };
jest.mock("expo-router", () => ({
  router: { push: jest.fn() },
  // runs once on mount like the real hook; the test calls the registered effect again to simulate coming back to the screen
  useFocusEffect: (effect: () => void) => {
    mockFocus.effect = effect;
    jest.requireActual<typeof import("react")>("react").useEffect(() => effect(), [effect]);
  },
}));
jest.mock("react-native-safe-area-context", () => {
  const { View } = jest.requireActual("react-native");
  return { SafeAreaView: View };
});

const NOW = Date.parse("2026-11-24T15:00:00.000Z");

const row = (id: string, startsAt: string, endsAt: string, over: Record<string, unknown> = {}) => ({
  id,
  title: null,
  appointmentType: "private_lesson",
  status: "scheduled",
  startsAt,
  endsAt,
  room: null,
  locationName: null,
  client: { id: "c1", firstName: "Ana", lastName: "Rivera" },
  partner: null,
  instructor: { id: "i1", firstName: "Ida", lastName: "Instructor" },
  ...over,
});

function day(appointments: unknown[], date = "2026-11-24") {
  return toStaffStudioDay({ studioId: STUDIO_ID, date, timeZone: "America/New_York", truncated: false, appointments });
}

function renderStudio(studioSchedule: jest.Mock, providerProps = {}) {
  return render(
    <StaffTestProviders api={fakeApi({ studioSchedule })} {...providerProps}>
      <StudioScheduleScreen />
    </StaffTestProviders>,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockFeatures.clear();
  jest.spyOn(Date, "now").mockReturnValue(NOW);
});
afterEach(() => jest.restoreAllMocks());

describe("studio schedule: next up", () => {
  it("shows the next open lesson with one obvious button that opens it", async () => {
    mockFeatures.add("appointmentAttendance");
    renderStudio(
      jest.fn(async () => day([row("later", "2026-11-24T17:00:00.000Z", "2026-11-24T17:45:00.000Z"), row("soon", "2026-11-24T15:30:00.000Z", "2026-11-24T16:15:00.000Z")])),
    );
    expect(await screen.findByTestId("next-up")).toBeTruthy();
    expect(screen.getByText("Next up")).toBeTruthy();
    fireEvent.press(screen.getByRole("button", { name: "Check in Ana Rivera" }));
    expect(router.push).toHaveBeenCalledWith({ pathname: "/appointments/[id]", params: { id: "soon", studioId: STUDIO_ID, tz: "America/New_York" } });
    expect(screen.queryByTestId("next-up-behind")).toBeNull();
  });

  it("says how many earlier lessons still have no result", async () => {
    mockFeatures.add("appointmentAttendance");
    renderStudio(
      jest.fn(async () =>
        day([
          row("e1", "2026-11-24T10:00:00.000Z", "2026-11-24T10:45:00.000Z"),
          row("e2", "2026-11-24T11:00:00.000Z", "2026-11-24T11:45:00.000Z"),
          row("soon", "2026-11-24T15:30:00.000Z", "2026-11-24T16:15:00.000Z"),
        ]),
      ),
    );
    expect(await screen.findByText("2 earlier lessons or classes still have no result.")).toBeTruthy();
  });

  it("when only ended lessons are open, the card asks for their result", async () => {
    mockFeatures.add("appointmentAttendance");
    renderStudio(jest.fn(async () => day([row("e1", "2026-11-24T10:00:00.000Z", "2026-11-24T10:45:00.000Z")])));
    expect(await screen.findByText("Still to record")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Record the result for Ana Rivera" })).toBeTruthy();
  });

  it("a class gets Take attendance, and only when the attendance capability is on", async () => {
    mockFeatures.add("attendance");
    const classRow = row("cls", "2026-11-24T16:00:00.000Z", "2026-11-24T17:00:00.000Z", { appointmentType: "group_class", title: "Salsa", client: null });
    const first = renderStudio(jest.fn(async () => day([classRow])));
    expect(await screen.findByRole("button", { name: "Take attendance" })).toBeTruthy();
    first.unmount();
    mockFeatures.clear();
    renderStudio(jest.fn(async () => day([classRow])));
    await screen.findByText("1 appointment");
    expect(screen.queryByTestId("next-up")).toBeNull();
  });

  it("a build without the lesson write word shows no lesson check-in card", async () => {
    renderStudio(jest.fn(async () => day([row("soon", "2026-11-24T15:30:00.000Z", "2026-11-24T16:15:00.000Z")])));
    await screen.findByText("1 appointment");
    expect(screen.queryByTestId("next-up")).toBeNull();
  });

  it("is only for today: another day has no next up, and stepping back to today brings it back", async () => {
    mockFeatures.add("appointmentAttendance");
    const studioSchedule = jest.fn(async (_studio: string, date?: string) =>
      day(
        [row("soon", `${date ?? "2026-11-24"}T15:30:00.000Z`, `${date ?? "2026-11-24"}T16:15:00.000Z`)],
        date ?? "2026-11-24",
      ),
    );
    renderStudio(studioSchedule);
    expect(await screen.findByTestId("next-up")).toBeTruthy();
    fireEvent.press(screen.getByRole("button", { name: "Next day" }));
    await screen.findByRole("button", { name: "Today" });
    await screen.findByText("1 appointment");
    expect(screen.queryByTestId("next-up")).toBeNull(); // 2026-11-25
    fireEvent.press(screen.getByRole("button", { name: "Previous day" }));
    expect(await screen.findByTestId("next-up")).toBeTruthy(); // back on 2026-11-24 by date, not by the "today" button
  });

  it("a role that may not mark attendance gets no card (the appointment screen would have no controls)", async () => {
    mockFeatures.add("appointmentAttendance");
    const ws = workspace({ capabilities: { viewStudioSchedule: true, viewClients: true, markAttendance: false } });
    renderStudio(jest.fn(async () => day([row("soon", "2026-11-24T15:30:00.000Z", "2026-11-24T16:15:00.000Z")])), { ws });
    await screen.findByText("1 appointment");
    expect(screen.queryByTestId("next-up")).toBeNull();
  });

  it("moves on with the clock: a lesson that ends while the screen is open becomes Still to record", async () => {
    jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate", "queueMicrotask"] });
    try {
      mockFeatures.add("appointmentAttendance");
      renderStudio(jest.fn(async () => day([row("soon", "2026-11-24T15:30:00.000Z", "2026-11-24T16:15:00.000Z")])));
      expect(await screen.findByText("Next up")).toBeTruthy();
      jest.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-24T16:20:00.000Z"));
      await act(async () => {
        jest.advanceTimersByTime(30_000);
      });
      expect(screen.getByText("Still to record")).toBeTruthy();
    } finally {
      jest.useRealTimers();
    }
  });

  it("coming back to the screen re-reads the day, so a result recorded elsewhere moves the card on", async () => {
    mockFeatures.add("appointmentAttendance");
    const bo = { client: { id: "c2", firstName: "Bo", lastName: "Chen" } };
    const studioSchedule = jest
      .fn()
      .mockResolvedValueOnce(day([row("soon", "2026-11-24T15:30:00.000Z", "2026-11-24T16:15:00.000Z"), row("after", "2026-11-24T17:00:00.000Z", "2026-11-24T17:45:00.000Z", bo)]))
      .mockResolvedValue(day([row("soon", "2026-11-24T15:30:00.000Z", "2026-11-24T16:15:00.000Z", { status: "attended" }), row("after", "2026-11-24T17:00:00.000Z", "2026-11-24T17:45:00.000Z", bo)]));
    renderStudio(studioSchedule);
    expect(await screen.findByRole("button", { name: "Check in Ana Rivera" })).toBeTruthy();
    expect(studioSchedule).toHaveBeenCalledTimes(1); // the first focus is the initial load, not a second read
    await act(async () => mockFocus.effect?.());
    expect(await screen.findByRole("button", { name: "Check in Bo Chen" })).toBeTruthy();
    expect(studioSchedule).toHaveBeenCalledTimes(2);
  });

  it("passes the accessibility audit (roles, names, 44pt targets, text scales to 200%)", async () => {
    mockFeatures.add("appointmentAttendance");
    renderStudio(
      jest.fn(async () => day([row("e1", "2026-11-24T10:00:00.000Z", "2026-11-24T10:45:00.000Z"), row("soon", "2026-11-24T15:30:00.000Z", "2026-11-24T16:15:00.000Z")])),
    );
    await screen.findByTestId("next-up");
    expect(auditA11y(screen.UNSAFE_root)).toEqual([]);
  });
});
