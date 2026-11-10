import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { router } from "expo-router";
import { StaffApiProvider, StaffSessionTestProvider } from "@/lib/staff";
import { StaffApiError, type StaffApi, type StaffToday, type StaffWorkspace } from "@/lib/staffApi";
import { TodayScreen } from "@/screens/TodayScreen";

jest.mock("expo-router", () => ({ router: { push: jest.fn() } }));
jest.mock("react-native-safe-area-context", () => {
  const { View } = jest.requireActual("react-native");
  return { SafeAreaView: View };
});

const WORKSPACE: StaffWorkspace = {
  studioId: "studio-1",
  name: "Studio A",
  publicName: "Studio A Dance",
  slug: "studio-a",
  role: "instructor",
  accessAllowed: true,
  subscriptionStatus: "active",
  capabilities: { viewStudioSchedule: true },
};

const DAY: StaffToday = {
  studioId: "studio-1",
  date: "2026-11-09",
  timeZone: "America/New_York",
  instructorId: "instructor-1",
  appointments: [
    {
      id: "appt-2",
      title: null,
      appointmentType: "group_class",
      status: "scheduled",
      startsAt: "2026-11-09T23:00:00.000Z",
      endsAt: "2026-11-10T00:00:00.000Z",
      room: { id: "room-1", name: "Main Floor" },
      locationName: null,
      client: null,
      partner: null,
    },
    {
      id: "appt-1",
      title: null,
      appointmentType: "private_lesson",
      status: "confirmed",
      startsAt: "2026-11-09T15:00:00.000Z",
      endsAt: "2026-11-09T15:45:00.000Z",
      room: null,
      locationName: null,
      client: { id: "c-1", firstName: "Ana", lastName: "Rivera" },
      partner: null,
    },
    {
      id: "appt-3",
      title: null,
      appointmentType: "private_lesson",
      status: "cancelled",
      startsAt: "2026-11-09T17:00:00.000Z",
      endsAt: "2026-11-09T17:45:00.000Z",
      room: null,
      locationName: null,
      client: null,
      partner: null,
    },
  ],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function renderToday(today: StaffApi["today"], overrides: { signOut?: jest.Mock; reload?: jest.Mock } = {}) {
  const api: StaffApi = {
    me: jest.fn(),
    today: jest.fn(today),
    appointment: jest.fn(),
    searchClients: jest.fn(),
    client: jest.fn(),
    setAttendance: jest.fn(),
  };
  const signOut = overrides.signOut ?? jest.fn(async () => undefined);
  const reload = overrides.reload ?? jest.fn(async () => undefined);

  render(
    <StaffApiProvider api={api}>
      <StaffSessionTestProvider
        value={{ me: null, loading: false, error: null, workspace: WORKSPACE, selectWorkspace: jest.fn(), reload, signOut }}
      >
        <TodayScreen />
      </StaffSessionTestProvider>
    </StaffApiProvider>,
  );

  return { api, signOut, reload };
}

describe("TodayScreen", () => {
  it("shows a labelled skeleton while the day loads", async () => {
    const pending = deferred<StaffToday>();
    renderToday(() => pending.promise);

    expect(screen.getByLabelText("Loading your schedule")).toBeTruthy();
    expect(screen.getByRole("progressbar")).toBeTruthy();

    await act(async () => pending.resolve({ ...DAY, appointments: [] }));
    expect(screen.queryByLabelText("Loading your schedule")).toBeNull();
  });

  it("asks for the studio's own today first, then lists appointments in time order", async () => {
    const { api } = renderToday(async () => DAY);

    expect(await screen.findByTestId("today-list")).toBeTruthy();
    expect(api.today).toHaveBeenCalledWith("studio-1", undefined);
    expect(screen.getByText("3 appointments")).toBeTruthy();

    const rows = screen.getAllByRole("button").filter((node) => String(node.props.testID ?? "").startsWith("appointment-"));
    expect(rows.map((node) => node.props.testID)).toEqual(["appointment-appt-1", "appointment-appt-3", "appointment-appt-2"]);
  });

  it("renders times in the studio's zone and status in words", async () => {
    renderToday(async () => DAY);

    // 15:00Z is 10:00 AM in New York on 2026-11-09 (EST).
    expect(await screen.findByText("10:00 AM")).toBeTruthy();
    expect(screen.getAllByText("45 min")).toHaveLength(2);
    expect(screen.getByText("60 min")).toBeTruthy();
    expect(screen.getByText("Ana Rivera")).toBeTruthy();
    expect(screen.getByText("Confirmed")).toBeTruthy();
    expect(screen.getByText("Cancelled")).toBeTruthy();
    expect(screen.getByText("Group class · Main Floor")).toBeTruthy();
    expect(screen.getByLabelText(/^10:00 AM, 45 minutes\. Ana Rivera\./)).toBeTruthy();
  });

  it("shows a neutral Client label when the name is withheld", async () => {
    renderToday(async () => DAY);
    expect(await screen.findByText("Client")).toBeTruthy();
  });

  it("opens the appointment with the studio and its zone", async () => {
    renderToday(async () => DAY);
    fireEvent.press(await screen.findByTestId("appointment-appt-1"));
    expect(router.push).toHaveBeenCalledWith({
      pathname: "/appointments/[id]",
      params: { id: "appt-1", studioId: "studio-1", tz: "America/New_York" },
    });
  });

  it("shows the empty state for a linked instructor with a free day", async () => {
    renderToday(async () => ({ ...DAY, appointments: [] }));
    expect(await screen.findByTestId("today-empty")).toBeTruthy();
    expect(screen.getByText("Nothing on your schedule today")).toBeTruthy();
  });

  it("explains an account without an instructor profile instead of an empty day", async () => {
    renderToday(async () => ({ ...DAY, instructorId: null, appointments: [] }));
    expect(await screen.findByTestId("today-not-linked")).toBeTruthy();
    expect(screen.queryByTestId("today-empty")).toBeNull();
  });

  it("offers sign-in again on a 401", async () => {
    const { signOut } = renderToday(async () => {
      throw new StaffApiError(401, "unauthenticated", "Sign in.");
    });

    expect(await screen.findByTestId("error-sign-in-again")).toBeTruthy();
    fireEvent.press(screen.getByRole("button", { name: "Sign in again" }));
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it("says there is no access to the studio on a 403 not_a_member, and refreshes studios", async () => {
    const { reload, signOut } = renderToday(async () => {
      throw new StaffApiError(403, "not_a_member", "No.");
    });

    expect(await screen.findByTestId("error-no-access")).toBeTruthy();
    expect(screen.getByText("No access to this studio")).toBeTruthy();
    fireEvent.press(screen.getByRole("button", { name: "Refresh studios" }));
    expect(reload).toHaveBeenCalledTimes(1);
    expect(signOut).not.toHaveBeenCalled();
  });

  it("shows the paused state on a 403 workspace_paused", async () => {
    renderToday(async () => {
      throw new StaffApiError(403, "workspace_paused", "Paused.");
    });
    expect(await screen.findByTestId("error-paused")).toBeTruthy();
  });

  it("shows temporarily unavailable on a 503, never signs out, and retries", async () => {
    let calls = 0;
    const { signOut, api } = renderToday(async () => {
      calls += 1;
      if (calls === 1) throw new StaffApiError(503, "service_unavailable", "Try again.");
      return DAY;
    });

    expect(await screen.findByTestId("error-unavailable")).toBeTruthy();
    expect(screen.getByText("Temporarily unavailable")).toBeTruthy();
    expect(signOut).not.toHaveBeenCalled();

    fireEvent.press(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByTestId("today-list")).toBeTruthy();
    expect(api.today).toHaveBeenCalledTimes(2);
  });

  it("announces errors as alerts", async () => {
    renderToday(async () => {
      throw new StaffApiError(503, "service_unavailable", "Try again.");
    });
    expect((await screen.findByTestId("error-unavailable")).props.accessibilityRole).toBe("alert");
  });

  it("moves to the next day using the date the server returned", async () => {
    const { api } = renderToday(async () => DAY);
    await screen.findByTestId("today-list");

    fireEvent.press(screen.getByRole("button", { name: "Next day" }));
    await waitFor(() => expect(api.today).toHaveBeenLastCalledWith("studio-1", "2026-11-10"));
  });

  it("ignores a slower answer for a day the person already left", async () => {
    const first = deferred<StaffToday>();
    const responses = [async () => DAY, () => first.promise, async () => ({ ...DAY, date: "2026-11-11", appointments: [] })];
    let index = 0;
    const { api } = renderToday(() => responses[index++]());
    await screen.findByTestId("today-list");

    fireEvent.press(screen.getByRole("button", { name: "Next day" }));
    await waitFor(() => expect(screen.getByLabelText("Loading your schedule")).toBeTruthy());
    fireEvent.press(screen.getByRole("button", { name: "Next day" }));
    expect(await screen.findByTestId("today-empty")).toBeTruthy();
    expect(api.today).toHaveBeenLastCalledWith("studio-1", "2026-11-11");

    await act(async () => first.resolve(DAY));
    expect(screen.getByTestId("today-empty")).toBeTruthy();
    expect(screen.queryByTestId("today-list")).toBeNull();
  });
});
