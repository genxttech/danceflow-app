import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { router } from "expo-router";
import { createStaffApi, StaffApiError, toStaffStudioDay, type StaffStudioDay } from "@/lib/staffApi";
import { isStudioWideRole } from "@/lib/navigation";
import { DayModeSwitch, StudioScheduleScreen } from "@/screens/StudioScheduleScreen";
import { fakeApi, STUDIO_ID, StaffTestProviders } from "@/test-utils/staff";

// the first render of a suite is slow on a loaded machine (cold transform); the default 5 s flaked in full runs
jest.setTimeout(20_000);

jest.mock("expo-router", () => ({ router: { push: jest.fn() }, useFocusEffect: (effect: () => void | (() => void)) => jest.requireActual<typeof import("react")>("react").useEffect(effect, [effect]) }));
jest.mock("react-native-safe-area-context", () => {
  const { View } = jest.requireActual("react-native");
  return { SafeAreaView: View };
});

const row = (id: string, startsAt: string, over: Record<string, unknown> = {}) => ({
  id,
  title: null,
  appointmentType: "private_lesson",
  status: "scheduled",
  startsAt,
  endsAt: startsAt,
  room: { id: "room-1", name: "Main Floor" },
  locationName: null,
  client: { id: "c1", firstName: "Ana", lastName: "Rivera" },
  partner: null,
  instructor: { id: "i1", firstName: "Ida", lastName: "Instructor" },
  ...over,
});

const DAY: StaffStudioDay = {
  studioId: STUDIO_ID,
  date: "2026-11-09",
  timeZone: "America/New_York",
  truncated: false,
  appointments: [
    row("late", "2026-11-09T23:00:00.000Z", { appointmentType: "group_class", title: "Salsa", client: null, instructor: { id: "i2", firstName: "Cole", lastName: "Teacher" } }),
    row("early", "2026-11-09T15:00:00.000Z"),
    row("rental", "2026-11-09T18:00:00.000Z", { appointmentType: "floor_space_rental", instructor: null, client: { id: "c9", firstName: "Rene", lastName: "Renter" } }),
  ],
} as StaffStudioDay;

function renderStudio(studioSchedule: jest.Mock, providerProps = {}) {
  const api = fakeApi({ studioSchedule });
  render(
    <StaffTestProviders api={api} {...providerProps}>
      <StudioScheduleScreen />
    </StaffTestProviders>,
  );
  return api;
}

beforeEach(() => jest.clearAllMocks());

describe("StudioScheduleScreen", () => {
  it("loads today's studio day, in time order, with who teaches each row", async () => {
    const api = renderStudio(jest.fn(async () => DAY));
    expect(screen.getByLabelText("Loading the studio schedule")).toBeTruthy();
    expect(await screen.findByText("3 appointments")).toBeTruthy();
    expect(api.studioSchedule).toHaveBeenCalledWith(STUDIO_ID, undefined);

    const labels = screen.getAllByRole("button").map((b) => b.props.accessibilityLabel as string).filter((l) => l?.includes("minutes"));
    expect(labels).toHaveLength(3);
    expect(labels[0]).toContain("Ana Rivera");
    expect(labels[0]).toContain("with Ida Instructor");
    expect(labels[1]).toContain("Rene Renter");
    expect(labels[1]).not.toContain("with"); // a rental has no instructor
    expect(labels[2]).toContain("Salsa");
    expect(labels[2]).toContain("with Cole Teacher");
  });

  it("an empty day says so", async () => {
    renderStudio(jest.fn(async () => ({ ...DAY, appointments: [] })));
    expect(await screen.findByTestId("studio-empty")).toBeTruthy();
  });

  it("says when a day was cut off", async () => {
    renderStudio(jest.fn(async () => ({ ...DAY, truncated: true })));
    expect(await screen.findByTestId("studio-truncated")).toBeTruthy();
  });

  it("opens an appointment with the studio and time zone", async () => {
    renderStudio(jest.fn(async () => DAY));
    fireEvent.press(await screen.findByTestId("appointment-early"));
    expect(router.push).toHaveBeenCalledWith({ pathname: "/appointments/[id]", params: { id: "early", studioId: STUDIO_ID, tz: "America/New_York" } });
  });

  it("moves a day at a time and returns to today", async () => {
    const studioSchedule = jest.fn(async (_studio: string, date?: string) => ({ ...DAY, date: date ?? "2026-11-09" }));
    renderStudio(studioSchedule);
    await screen.findByText("3 appointments");
    await act(async () => fireEvent.press(screen.getByRole("button", { name: "Next day" })));
    expect(studioSchedule).toHaveBeenLastCalledWith(STUDIO_ID, "2026-11-10");
    await act(async () => fireEvent.press(screen.getByRole("button", { name: "Today" })));
    expect(studioSchedule).toHaveBeenLastCalledWith(STUDIO_ID, undefined);
  });

  it("a 403 role refusal is explained, with a studio refresh and no retry loop", async () => {
    const reload = jest.fn(async () => undefined);
    renderStudio(jest.fn(async () => Promise.reject(new StaffApiError(403, "role_not_permitted", "x"))), { reload });
    expect(await screen.findByTestId("error-not-permitted")).toBeTruthy();
    fireEvent.press(screen.getByRole("button", { name: "Refresh studios" }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("after a 403, Refresh studios reloads the studio list and then the day", async () => {
    const reload = jest.fn(async () => undefined);
    const studioSchedule = jest.fn().mockRejectedValueOnce(new StaffApiError(403, "role_not_permitted", "x")).mockResolvedValueOnce(DAY);
    renderStudio(studioSchedule, { reload });
    fireEvent.press(await screen.findByRole("button", { name: "Refresh studios" }));
    expect(await screen.findByText("3 appointments")).toBeTruthy();
    expect(studioSchedule).toHaveBeenCalledTimes(2);
  });

  it("a 401 asks to sign in again and signs out on the button", async () => {
    const signOut = jest.fn(async () => undefined);
    renderStudio(jest.fn(async () => Promise.reject(new StaffApiError(401, "unauthenticated", "x"))), { signOut });
    fireEvent.press(await screen.findByRole("button", { name: "Sign in again" }));
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it("an outage retries and recovers", async () => {
    const studioSchedule = jest.fn().mockRejectedValueOnce(new StaffApiError(503, "service_unavailable", "x")).mockResolvedValueOnce(DAY);
    renderStudio(studioSchedule);
    fireEvent.press(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByText("3 appointments")).toBeTruthy();
  });
});

describe("DayModeSwitch", () => {
  it("is a radio group with the current choice checked, and tells the parent what was picked", () => {
    const onChange = jest.fn();
    render(<DayModeSwitch mode="mine" onChange={onChange} />);
    expect(screen.getByRole("radio", { name: "My day" }).props.accessibilityState).toMatchObject({ checked: true });
    expect(screen.getByRole("radio", { name: "Studio" }).props.accessibilityState).toMatchObject({ checked: false });
    fireEvent.press(screen.getByRole("radio", { name: "Studio" }));
    expect(onChange).toHaveBeenCalledWith("studio");
  });
});

describe("studio day adapter", () => {
  it("requests GET /schedule with the date, and normalises rows (a row without id or start is dropped)", async () => {
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ studioId: "s", date: "2026-11-09", timeZone: "America/New_York", truncated: true, appointments: [row("a", "2026-11-09T15:00:00.000Z"), { id: "no-start" }, null] }),
    }));
    const api = createStaffApi({ baseUrl: "https://danceflow.test", getAccessToken: async () => "t", refreshAccessToken: async () => null, fetchImpl: fetchImpl as unknown as typeof fetch });
    const day = await api.studioSchedule("studio 1", "2026-11-09");
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe("https://danceflow.test/api/staff/workspaces/studio%201/schedule?date=2026-11-09");
    expect(day.truncated).toBe(true);
    expect(day.appointments.map((a) => a.id)).toEqual(["a"]);
    expect(day.appointments[0].instructor).toEqual({ id: "i1", firstName: "Ida", lastName: "Instructor" });
  });

  it("an empty or malformed body is an empty day", () => {
    expect(toStaffStudioDay(null)).toEqual({ studioId: "", date: "", timeZone: "", truncated: false, appointments: [] });
    expect(toStaffStudioDay({ appointments: "nope" }).appointments).toEqual([]);
  });
});

describe("isStudioWideRole", () => {
  it("is owner, admin and front desk only", () => {
    for (const role of ["studio_owner", "studio_admin", "front_desk"]) expect(isStudioWideRole(role)).toBe(true);
    for (const role of ["instructor", "independent_instructor", "organizer_owner", "platform_admin", "", null, undefined]) expect(isStudioWideRole(role)).toBe(false);
  });
});
