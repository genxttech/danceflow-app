import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { router } from "expo-router";
import { StaffApiError, toStaffStudioDay } from "@/lib/staffApi";
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

/*
  The clock is fixed for every test: fake timers started at an explicit instant. Without `now`, fake timers start at the machine's real time, and a test that depends on
  the time of day passes only on some days. `advanceTimersByTime` and `setSystemTime` are the only ways time moves here.
*/
beforeEach(() => {
  jest.clearAllMocks();
  mockFeatures.clear();
  jest.useFakeTimers({ now: NOW, doNotFake: ["nextTick", "setImmediate", "queueMicrotask"] });
});
afterEach(() => jest.useRealTimers());

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

  // The studio is in America/New_York (UTC-5 in November).
  it.each([
    ["late morning", "2026-11-24T15:00:00.000Z", "2026-11-24T15:30:00.000Z", "2026-11-24T16:15:00.000Z", "2026-11-24T16:20:00.000Z"],
    ["09:24Z, early morning in the studio", "2026-11-24T09:24:00.000Z", "2026-11-24T09:30:00.000Z", "2026-11-24T10:15:00.000Z", "2026-11-24T10:20:00.000Z"],
    ["across midnight UTC (18:45 to 19:20 in the studio)", "2026-11-24T23:45:00.000Z", "2026-11-24T23:30:00.000Z", "2026-11-25T00:15:00.000Z", "2026-11-25T00:20:00.000Z"],
  ])("moves on with the clock (%s): a lesson that ends while the screen is open becomes Still to record", async (_label, openedAt, startsAt, endsAt, later) => {
    jest.setSystemTime(Date.parse(openedAt));
    mockFeatures.add("appointmentAttendance");
    renderStudio(jest.fn(async () => day([row("soon", startsAt, endsAt)])));
    expect(await screen.findByText("Next up")).toBeTruthy();
    jest.setSystemTime(Date.parse(later));
    await act(async () => {
      jest.advanceTimersByTime(30_000);
    });
    expect(screen.getByText("Still to record")).toBeTruthy();
    expect(screen.queryByText("Next up")).toBeNull();
  });

  describe("studio midnight (00:00 in America/New_York is 05:00Z)", () => {
    const BEFORE = "2026-11-25T04:45:00.000Z"; // 23:45 on the 24th in the studio
    const AFTER = "2026-11-25T05:20:00.000Z"; // 00:20 on the 25th, well past the two-minute grace
    const bo = { client: { id: "c2", firstName: "Bo", lastName: "Chen" } };
    const oldDay = () => day([row("late", "2026-11-25T04:30:00.000Z", "2026-11-25T05:15:00.000Z")]);
    const newDay = () => day([row("morning", "2026-11-25T15:00:00.000Z", "2026-11-25T15:45:00.000Z", bo)], "2026-11-25");

    const advanceTo = async (instant: string, ticks = 1) => {
      jest.setSystemTime(Date.parse(instant));
      for (let i = 0; i < ticks; i += 1) {
        await act(async () => {
          jest.advanceTimersByTime(30_000);
        });
      }
    };

    beforeEach(() => {
      jest.setSystemTime(Date.parse(BEFORE));
      mockFeatures.add("appointmentAttendance");
    });

    it("re-reads today when the studio date moves on, without being touched", async () => {
      const studioSchedule = jest.fn().mockResolvedValueOnce(oldDay()).mockResolvedValue(newDay());
      renderStudio(studioSchedule);
      expect(await screen.findByRole("button", { name: "Check in Ana Rivera" })).toBeTruthy();
      expect(screen.getByText("Studio today")).toBeTruthy();
      await advanceTo(AFTER);
      expect(await screen.findByRole("button", { name: "Check in Bo Chen" })).toBeTruthy();
      expect(screen.getByText("Wednesday, November 25")).toBeTruthy();
      expect(screen.getByText("Studio today")).toBeTruthy();
      expect(studioSchedule).toHaveBeenCalledTimes(2);
      expect(studioSchedule).toHaveBeenLastCalledWith(STUDIO_ID, undefined);
      await advanceTo("2026-11-25T05:30:00.000Z", 3);
      expect(studioSchedule).toHaveBeenCalledTimes(2);
    });

    it("does not re-read before the studio's midnight, even after midnight UTC", async () => {
      jest.setSystemTime(Date.parse("2026-11-24T23:45:00.000Z"));
      const studioSchedule = jest.fn(async () => oldDay());
      renderStudio(studioSchedule);
      await screen.findByText("1 appointment");
      await advanceTo("2026-11-25T04:55:00.000Z", 4); // ends at 04:57Z, 23:57 on the 24th
      expect(studioSchedule).toHaveBeenCalledTimes(1);
      expect(screen.getByText("Studio today")).toBeTruthy();
    });

    it("waits two minutes past midnight, so a device clock slightly ahead of the server does not re-read too early", async () => {
      const studioSchedule = jest.fn().mockResolvedValueOnce(oldDay()).mockResolvedValue(newDay());
      renderStudio(studioSchedule);
      await screen.findByTestId("next-up");
      await advanceTo("2026-11-25T05:00:00.000Z", 2); // 00:01 in the studio
      expect(studioSchedule).toHaveBeenCalledTimes(1);
      await advanceTo("2026-11-25T05:02:00.000Z");
      expect(await screen.findByRole("button", { name: "Check in Bo Chen" })).toBeTruthy();
      expect(studioSchedule).toHaveBeenCalledTimes(2);
    });

    it("takes the server's answer after the re-read, even if it is still the earlier day, and does not ask again", async () => {
      const studioSchedule = jest.fn(async () => oldDay());
      renderStudio(studioSchedule);
      await screen.findByTestId("next-up");
      await advanceTo(AFTER, 5);
      await screen.findByText("1 appointment");
      expect(studioSchedule).toHaveBeenCalledTimes(2);
      await advanceTo("2026-11-25T08:00:00.000Z", 3);
      expect(studioSchedule).toHaveBeenCalledTimes(2);
      // the following midnight is a new date: asked once more
      await advanceTo("2026-11-26T05:10:00.000Z", 3);
      expect(studioSchedule).toHaveBeenCalledTimes(3);
    });

    it("a failed re-read keeps the earlier day under its own date with a banner, and tries again no more than every five minutes", async () => {
      mockFeatures.add("keepStale");
      const studioSchedule = jest.fn().mockResolvedValueOnce(oldDay()).mockRejectedValue(new StaffApiError(503, "service_unavailable", "x"));
      renderStudio(studioSchedule);
      await screen.findByTestId("next-up");
      await advanceTo(AFTER, 4); // two minutes of ticks
      expect(await screen.findByText("1 appointment")).toBeTruthy();
      expect(studioSchedule).toHaveBeenCalledTimes(2);
      expect(screen.queryByText("Studio today")).toBeNull();
      expect(screen.getByText("Tuesday, November 24")).toBeTruthy();
      expect(screen.queryByTestId("next-up")).toBeNull();
      await advanceTo("2026-11-25T05:23:00.000Z", 2); // under five minutes after the first try
      expect(studioSchedule).toHaveBeenCalledTimes(2);
      studioSchedule.mockResolvedValue(newDay());
      await advanceTo("2026-11-25T05:26:30.000Z"); // over five minutes after it
      expect(await screen.findByRole("button", { name: "Check in Bo Chen" })).toBeTruthy();
      expect(studioSchedule).toHaveBeenCalledTimes(3);
      expect(screen.getByText("Studio today")).toBeTruthy();
    });

    it("a device clock a day ahead of the server changes nothing at load: the server says what today is", async () => {
      jest.setSystemTime(Date.parse("2026-11-26T15:00:00.000Z"));
      const studioSchedule = jest.fn(async () => oldDay());
      renderStudio(studioSchedule);
      await screen.findByText("1 appointment");
      await advanceTo("2026-11-26T15:05:00.000Z", 4);
      expect(studioSchedule).toHaveBeenCalledTimes(1);
      expect(screen.getByText("Studio today")).toBeTruthy();
    });

    it("with the stale-data flag off too, a failed midnight re-read keeps the day on screen and tries again", async () => {
      const studioSchedule = jest.fn().mockResolvedValueOnce(oldDay()).mockRejectedValueOnce(new StaffApiError(503, "service_unavailable", "x")).mockResolvedValue(newDay());
      renderStudio(studioSchedule);
      await screen.findByTestId("next-up");
      await advanceTo(AFTER);
      expect(await screen.findByText("1 appointment")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Next day" }).props.accessibilityState.disabled).toBe(false);
      expect(screen.queryByText("Studio today")).toBeNull();
      await advanceTo("2026-11-25T05:26:30.000Z");
      expect(await screen.findByRole("button", { name: "Check in Bo Chen" })).toBeTruthy();
      expect(studioSchedule).toHaveBeenCalledTimes(3);
    });

    it("a refused session at midnight is still shown as an answer", async () => {
      const studioSchedule = jest.fn().mockResolvedValueOnce(oldDay()).mockRejectedValue(new StaffApiError(401, "unauthenticated", "x"));
      renderStudio(studioSchedule);
      await screen.findByTestId("next-up");
      await advanceTo(AFTER);
      expect(await screen.findByRole("button", { name: "Sign in again" })).toBeTruthy();
    });

    it("a read that answered with the earlier day just after midnight still rolls over", async () => {
      jest.setSystemTime(Date.parse("2026-11-25T05:00:30.000Z")); // the device is just past midnight, the server not yet
      const studioSchedule = jest.fn().mockResolvedValueOnce(oldDay()).mockResolvedValue(newDay());
      renderStudio(studioSchedule);
      await screen.findByTestId("next-up");
      await advanceTo("2026-11-25T05:03:00.000Z");
      expect(await screen.findByRole("button", { name: "Check in Bo Chen" })).toBeTruthy();
      expect(studioSchedule).toHaveBeenCalledTimes(2);
    });

    it("an empty earlier day is not called today while the new one is on its way", async () => {
      const studioSchedule = jest.fn().mockResolvedValueOnce(day([])).mockRejectedValue(new StaffApiError(503, "service_unavailable", "x"));
      renderStudio(studioSchedule);
      await screen.findByText("Nothing on the studio schedule today");
      await advanceTo(AFTER);
      expect(await screen.findByText("Nothing on the studio schedule")).toBeTruthy();
      expect(screen.queryByText("Nothing on the studio schedule today")).toBeNull();
    });

    it("pressing Today after midnight reads once, not twice", async () => {
      const studioSchedule = jest.fn(async (_studio: string, date?: string) => (date ? day([], date) : oldDay()));
      renderStudio(studioSchedule);
      await screen.findByTestId("next-up");
      fireEvent.press(screen.getByRole("button", { name: "Previous day" }));
      await screen.findByText("Monday, November 23");
      await advanceTo(AFTER);
      expect(studioSchedule).toHaveBeenCalledTimes(2);
      await act(async () => {
        fireEvent.press(screen.getByRole("button", { name: "Today" }));
      });
      await screen.findByText("1 appointment");
      expect(studioSchedule).toHaveBeenCalledTimes(3);
    });

    it("leaves a day the person picked alone", async () => {
      const studioSchedule = jest.fn(async (_studio: string, date?: string) => day([row("x", `${date ?? "2026-11-24"}T15:00:00.000Z`, `${date ?? "2026-11-24"}T15:45:00.000Z`)], date ?? "2026-11-24"));
      renderStudio(studioSchedule);
      await screen.findByText("1 appointment");
      fireEvent.press(screen.getByRole("button", { name: "Previous day" }));
      await screen.findByText("Monday, November 23");
      await advanceTo(AFTER, 3);
      expect(studioSchedule).toHaveBeenCalledTimes(2);
      expect(screen.getByText("Monday, November 23")).toBeTruthy();
    });

    it("a device clock behind the server causes no re-read", async () => {
      const studioSchedule = jest.fn(async () => newDay()); // the server is already on the 25th
      renderStudio(studioSchedule);
      expect(await screen.findByRole("button", { name: "Check in Bo Chen" })).toBeTruthy();
      await advanceTo("2026-11-25T05:10:00.000Z", 3); // the device crosses midnight onto the date the server already gave
      expect(studioSchedule).toHaveBeenCalledTimes(1);
      expect(screen.getByText("Studio today")).toBeTruthy();
    });
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
