import { render, screen } from "@testing-library/react-native";
import { createStaffApi, toStaffPulse, toStaffStudioDay, type StaffPulse, type StaffStudioDay } from "@/lib/staffApi";
import { PulseScreen } from "@/screens/PulseScreen";
import { StudioScheduleScreen } from "@/screens/StudioScheduleScreen";
import { fakeApi, STUDIO_ID, StaffTestProviders } from "@/test-utils/staff";

/*
  The server cuts a day at 500 appointments (GET /schedule and GET /pulse set `truncated: true`). The app must keep what it got, say plainly that the day is cut off,
  and never present the 500 as the whole day. Fixtures below are 500 rows, the size the server returns at the cap.
*/

jest.mock("expo-router", () => ({ router: { push: jest.fn() } }));
jest.mock("react-native-safe-area-context", () => {
  const { View } = jest.requireActual("react-native");
  return { SafeAreaView: View };
});
jest.setTimeout(60_000);

const CAP = 500;

const row = (n: number) => ({
  id: `appt-${String(n).padStart(4, "0")}`,
  title: null,
  appointmentType: "private_lesson",
  status: "scheduled",
  startsAt: new Date(Date.UTC(2026, 10, 9, 13, 0) + n * 60_000).toISOString(),
  endsAt: new Date(Date.UTC(2026, 10, 9, 13, 30) + n * 60_000).toISOString(),
  room: null,
  locationName: null,
  client: { id: `c${n}`, firstName: "Ana", lastName: `Rivera${n}` },
  partner: null,
  instructor: { id: "i1", firstName: "Ida", lastName: "Instructor" },
});

const wire = (count: number, truncated: boolean | undefined) => ({
  studioId: STUDIO_ID,
  date: "2026-11-09",
  timeZone: "America/New_York",
  ...(truncated === undefined ? {} : { truncated }),
  appointments: Array.from({ length: count }, (_, n) => row(n)),
});

const PULSE_CUT: StaffPulse = {
  studioId: STUDIO_ID,
  timeZone: "America/New_York",
  date: "2026-11-09",
  asOf: "2026-11-09T15:30:00.000Z",
  scope: "studio",
  instructorId: null,
  today: { total: CAP, upcoming: 300, cancelled: 12, truncated: true },
  next: null,
  newClientsLast7Days: 3,
};

describe("the adapter keeps what the server sent and its cut-off flag", () => {
  it("a 500-row day arrives whole with truncated true", () => {
    const day = toStaffStudioDay(wire(CAP, true));
    expect(day.appointments).toHaveLength(CAP);
    expect(day.truncated).toBe(true);
    expect(day.appointments[0].id).toBe("appt-0000");
    expect(day.appointments[CAP - 1].id).toBe("appt-0499");
  });

  it("a normal day, a missing flag and a non-boolean flag are all not cut off (only a real true counts)", () => {
    expect(toStaffStudioDay(wire(3, false)).truncated).toBe(false);
    expect(toStaffStudioDay(wire(3, undefined)).truncated).toBe(false);
    expect(toStaffStudioDay({ ...wire(3, undefined), truncated: "true" }).truncated).toBe(false);
    expect(toStaffStudioDay({ ...wire(3, undefined), truncated: 1 }).truncated).toBe(false);
  });

  it("the pulse flag is read the same strict way, and 500 is a number, not a string", () => {
    expect(toStaffPulse({ scope: "studio", today: { total: CAP, upcoming: 300, cancelled: 12, truncated: true } }).today).toEqual({ total: CAP, upcoming: 300, cancelled: 12, truncated: true });
    expect(toStaffPulse({ today: { total: 5, truncated: "yes" } }).today.truncated).toBe(false);
  });

  it("through the real client: a cut-off day over HTTP keeps the flag and every row", async () => {
    const fetchImpl = jest.fn(async () => ({ ok: true, status: 200, json: async () => wire(CAP, true) }));
    const api = createStaffApi({ baseUrl: "https://danceflow.test", getAccessToken: async () => "t", refreshAccessToken: async () => null, fetchImpl: fetchImpl as unknown as typeof fetch });
    const day = await api.studioSchedule(STUDIO_ID, "2026-11-09");
    expect(day.truncated).toBe(true);
    expect(day.appointments).toHaveLength(CAP);
  });
});

describe("the screens say the day is cut off", () => {
  it("the studio schedule shows the count it has, the cut-off note, and the rows in time order", async () => {
    const day: StaffStudioDay = toStaffStudioDay(wire(CAP, true));
    render(
      <StaffTestProviders api={fakeApi({ studioSchedule: jest.fn(async () => day) })}>
        <StudioScheduleScreen />
      </StaffTestProviders>,
    );
    expect(await screen.findByText("500 appointments")).toBeTruthy();
    expect(screen.getByTestId("studio-truncated").props.children).toBe("Showing the first 500 appointments of the day.");
    expect(screen.getByTestId("appointment-appt-0000")).toBeTruthy();
  });

  it("a normal day has no cut-off note", async () => {
    const day = toStaffStudioDay(wire(3, false));
    render(
      <StaffTestProviders api={fakeApi({ studioSchedule: jest.fn(async () => day) })}>
        <StudioScheduleScreen />
      </StaffTestProviders>,
    );
    expect(await screen.findByText("3 appointments")).toBeTruthy();
    expect(screen.queryByTestId("studio-truncated")).toBeNull();
  });

  it("Pulse shows the numbers it has and says they cover only the first 500", async () => {
    render(
      <StaffTestProviders api={fakeApi({ pulse: jest.fn(async () => PULSE_CUT) })}>
        <PulseScreen />
      </StaffTestProviders>,
    );
    expect(await screen.findByLabelText("appointments: 500")).toBeTruthy();
    expect(screen.getByTestId("pulse-truncated").props.children).toBe("Counts cover the first 500 appointments of the day.");
  });

  it("Pulse without the flag shows no note", async () => {
    render(
      <StaffTestProviders api={fakeApi({ pulse: jest.fn(async () => ({ ...PULSE_CUT, today: { ...PULSE_CUT.today, total: 5, truncated: false } })) })}>
        <PulseScreen />
      </StaffTestProviders>,
    );
    await screen.findByLabelText("appointments: 5");
    expect(screen.queryByTestId("pulse-truncated")).toBeNull();
  });
});
