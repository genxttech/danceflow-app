import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { StaffApiError, type AppointmentDetail } from "@/lib/staffApi";
import { AppointmentScreen } from "@/screens/AppointmentScreen";
import { fakeApi, STUDIO_ID, StaffTestProviders, workspace } from "@/test-utils/staff";

/*
  Regression suite for the appointment / class roster flow: who may mark attendance, what a cancelled or read-only class shows, the capacity wording, the recap
  states, and the error states of the detail itself. The row-level marking behaviour is in RosterAttendance.test.tsx and RosterBulkAttendance.test.tsx.
*/

jest.mock("expo-router", () => ({ router: { push: jest.fn() } }));
jest.mock("react-native-safe-area-context", () => {
  const { View } = jest.requireActual("react-native");
  return { SafeAreaView: View };
});
jest.mock("@/lib/features", () => ({ ...jest.requireActual("@/lib/features"), isStaffFeatureEnabled: () => true }));
jest.setTimeout(20_000);

const BASE = {
  title: null,
  status: "scheduled",
  startsAt: "2026-11-09T23:00:00.000Z",
  endsAt: "2026-11-10T00:00:00.000Z",
  room: { id: "room-1", name: "Main Floor" },
  locationName: null,
  client: null,
  partner: null,
  studioId: STUDIO_ID,
  timeZone: "America/New_York",
  accessScope: "own-instructor",
  notes: "Warm up with the basic.",
  instructor: { id: "i1", firstName: "Ida", lastName: "Instructor" },
};

const CLASS = (over: Partial<AppointmentDetail> = {}, capacity: number | null = 10, attendees = 2): AppointmentDetail =>
  ({
    ...BASE,
    id: "class-1",
    title: "Beginner Salsa",
    appointmentType: "group_class",
    roster: {
      bookedCount: attendees,
      capacity,
      attendees: [
        { clientId: "c1", name: "Ana Rivera", attendanceStatus: null },
        { clientId: "c2", name: null, attendanceStatus: "attended" },
      ].slice(0, attendees),
    },
    recap: null,
    ...over,
  }) as AppointmentDetail;

const LESSON = (over: Partial<AppointmentDetail> = {}): AppointmentDetail =>
  ({
    ...BASE,
    id: "lesson-1",
    appointmentType: "private_lesson",
    client: { id: "c1", firstName: "Ana", lastName: "Rivera" },
    partner: { id: "c3", firstName: "Pat", lastName: "Partner" },
    roster: null,
    recap: { summary: "Frame", homework: "Box step", nextFocus: "Timing", visibleToClient: true, updatedAt: null },
    ...over,
  }) as AppointmentDetail;

function renderDetail(detail: AppointmentDetail | Promise<never>, props: React.ComponentProps<typeof StaffTestProviders> extends infer P ? Partial<P> : never = {}) {
  const appointment = jest.fn(() => (detail instanceof Promise ? detail : Promise.resolve(detail)));
  const api = fakeApi({ appointment, setAttendance: jest.fn() });
  render(
    <StaffTestProviders api={api} {...props}>
      <AppointmentScreen appointmentId="appt-1" studioId={STUDIO_ID} />
    </StaffTestProviders>,
  );
  return api;
}

beforeEach(() => jest.clearAllMocks());

describe("who may mark attendance on a class", () => {
  it("a role with the markAttendance capability sees the marking controls and the Roster and attendance heading", async () => {
    renderDetail(CLASS());
    expect(await screen.findByText("Roster and attendance")).toBeTruthy();
    expect(screen.getAllByRole("radio").length).toBeGreaterThan(0);
  });

  it("without the capability the roster is read-only: a plain heading, statuses in words, no controls", async () => {
    renderDetail(CLASS(), { ws: workspace({ capabilities: { viewStudioSchedule: true, viewClients: true, markAttendance: false } }) });
    expect(await screen.findByText("Roster")).toBeTruthy();
    expect(screen.queryByText("Roster and attendance")).toBeNull();
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
    expect(screen.getByText("Not recorded")).toBeTruthy();
  });

  it("a paused studio never offers marking, even with the capability", async () => {
    renderDetail(CLASS(), { ws: workspace({ accessAllowed: false }) });
    await screen.findByText("Roster");
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
  });

  it("the capability of the studio this class belongs to decides, not the selected studio", async () => {
    const other = workspace({ studioId: "studio-2", name: "Harbor", capabilities: { viewStudioSchedule: true, markAttendance: true } });
    const mine = workspace({ capabilities: { viewStudioSchedule: true, markAttendance: false } });
    renderDetail(CLASS(), { ws: other, workspaces: [other, mine] });
    await screen.findByText("Roster");
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
  });

  it("a cancelled class cannot be marked and says it is cancelled", async () => {
    renderDetail(CLASS({ status: "cancelled" }));
    expect(await screen.findByText("Roster")).toBeTruthy();
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
    expect(screen.getByText("Cancelled")).toBeTruthy();
  });
});

describe("capacity wording", () => {
  it.each([
    [10, 6, "6 of 10 booked"],
    [10, 10, "10 of 10 booked · Full"],
    [10, 12, "12 of 10 booked · Full"],
    [null, 4, "4 booked"],
  ] as const)("capacity %s with %s booked reads %s", async (capacity, booked, expected) => {
    renderDetail(CLASS({ roster: { bookedCount: booked, capacity, attendees: [] } }));
    expect((await screen.findByTestId("roster-capacity")).props.children).toBe(expected);
  });

  it("an empty roster says no one is enrolled yet", async () => {
    renderDetail(CLASS({ roster: { bookedCount: 0, capacity: 10, attendees: [] } }));
    expect(await screen.findByText("No one is enrolled yet.")).toBeTruthy();
  });
});

describe("what each appointment type shows", () => {
  it("a private lesson shows client and partner (as names), the instructor and the recap; no roster", async () => {
    renderDetail(LESSON());
    expect(await screen.findByText("Ana Rivera & Pat Partner")).toBeTruthy();
    expect(screen.getByLabelText("Client: Ana Rivera")).toBeTruthy();
    expect(screen.getByLabelText("Partner: Pat Partner")).toBeTruthy();
    expect(screen.getByLabelText("Instructor: Ida Instructor")).toBeTruthy();
    expect(screen.getByText("Lesson recap")).toBeTruthy();
    expect(screen.getByLabelText("Summary: Frame")).toBeTruthy();
    expect(screen.getByText("Visible to the client")).toBeTruthy();
    expect(screen.queryByTestId("roster-capacity")).toBeNull();
  });

  it("a lesson recap that is not visible to the client says so", async () => {
    renderDetail(LESSON({ recap: { summary: "Frame", homework: null, nextFocus: null, visibleToClient: false, updatedAt: null } }));
    expect(await screen.findByText("Not visible to the client")).toBeTruthy();
  });

  it("a lesson with no recap yet says recaps are written on the web", async () => {
    renderDetail(LESSON({ recap: null }));
    expect(await screen.findByText(/No recap written yet/)).toBeTruthy();
  });

  it("a client the teaching rule hides is a neutral label, not a blank or an error", async () => {
    renderDetail(LESSON({ client: { id: "c1", firstName: "", lastName: "" }, partner: null }));
    expect(await screen.findByLabelText("Client: Client")).toBeTruthy();
  });

  it("a group class has no recap section and no client/partner rows", async () => {
    renderDetail(CLASS());
    await screen.findByText("Beginner Salsa");
    expect(screen.queryByText("Lesson recap")).toBeNull();
    expect(screen.queryByLabelText(/^Client:/)).toBeNull();
  });

  it("teaching notes appear only when there are some", async () => {
    renderDetail(LESSON({ notes: null }));
    await screen.findByText("Ana Rivera & Pat Partner");
    expect(screen.queryByText("Teaching notes")).toBeNull();
  });
});

describe("the detail's own states", () => {
  it("shows a loading state first", () => {
    renderDetail(new Promise<never>(() => undefined));
    expect(screen.getByLabelText("Loading the appointment")).toBeTruthy();
  });

  it.each([
    ["not_found", 404, "error-not-found"],
    ["role_not_permitted", 403, "error-not-permitted"],
    ["not_a_member", 403, "error-no-access"],
    ["workspace_paused", 403, "error-paused"],
    ["unauthenticated", 401, "error-sign-in-again"],
    ["service_unavailable", 503, "error-unavailable"],
  ] as const)("%s is explained (%s)", async (code, status, testID) => {
    renderDetail(Promise.reject(new StaffApiError(status, code, "x")) as Promise<never>);
    expect(await screen.findByTestId(testID)).toBeTruthy();
  });

  it("an outage retries on the button and recovers", async () => {
    const appointment = jest.fn().mockRejectedValueOnce(new StaffApiError(503, "service_unavailable", "x")).mockResolvedValueOnce(LESSON());
    render(
      <StaffTestProviders api={fakeApi({ appointment })}>
        <AppointmentScreen appointmentId="appt-1" studioId={STUDIO_ID} />
      </StaffTestProviders>,
    );
    fireEvent.press(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Ana Rivera & Pat Partner")).toBeTruthy();
    expect(appointment).toHaveBeenCalledTimes(2);
  });

  it("a 401 on the detail offers Sign in again, which signs out", async () => {
    const signOut = jest.fn(async () => undefined);
    renderDetail(Promise.reject(new StaffApiError(401, "unauthenticated", "x")) as Promise<never>, { signOut });
    fireEvent.press(await screen.findByRole("button", { name: "Sign in again" }));
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it("asks for the appointment of the studio in the route, not the selected one", async () => {
    const api = renderDetail(LESSON());
    await screen.findByText("Ana Rivera & Pat Partner");
    await act(async () => undefined);
    expect(api.appointment).toHaveBeenCalledWith(STUDIO_ID, "appt-1");
  });
});
