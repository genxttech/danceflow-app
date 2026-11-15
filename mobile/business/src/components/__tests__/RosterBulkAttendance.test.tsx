import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { RosterAttendance } from "@/components/RosterAttendance";
import { parseStaffFeatures } from "@/lib/features";
import { StaffApiError, type AttendanceResult } from "@/lib/staffApi";
import { fakeApi, STUDIO_ID, StaffTestProviders } from "@/test-utils/staff";

const flags = { bulkAttendance: true };
jest.mock("@/lib/features", () => ({
  ...jest.requireActual("@/lib/features"),
  isStaffFeatureEnabled: (feature: string) => (feature === "bulkAttendance" ? flags.bulkAttendance : true),
}));

const ATTENDEES = [
  { clientId: "c1", name: "Ana Rivera", attendanceStatus: null },
  { clientId: "c2", name: "Colin Marsh", attendanceStatus: "attended" },
  { clientId: "c3", name: "Dee Park", attendanceStatus: null },
  { clientId: "c4", name: "Eli Stone", attendanceStatus: "no_show" },
  { clientId: "c5", name: "Fay Moore", attendanceStatus: null },
];

const ok = (clientId: string, status: string): AttendanceResult => ({ clientId, attendanceStatus: status, displayName: null, updatedAt: null });

function renderRoster(setAttendance: jest.Mock, canMark = true, attendees = ATTENDEES) {
  const api = fakeApi({ setAttendance });
  render(
    <StaffTestProviders api={api}>
      <RosterAttendance studioId={STUDIO_ID} appointmentId="appt-1" attendees={attendees} canMark={canMark} />
    </StaffTestProviders>,
  );
  return api;
}

const markAll = () => screen.getByRole("button", { name: /^Mark all present/ });

beforeEach(() => {
  flags.bulkAttendance = true;
});

describe("Mark all present", () => {
  it("is off by default and named per build", () => {
    expect(parseStaffFeatures(undefined).has("bulkAttendance")).toBe(false);
    expect(parseStaffFeatures("bulkAttendance").has("bulkAttendance")).toBe(true);
  });

  it("is hidden with the flag off, without the capability, and when everyone already has a mark", () => {
    flags.bulkAttendance = false;
    renderRoster(jest.fn());
    expect(screen.queryByTestId("bulk-attendance")).toBeNull();
    screen.unmount();

    flags.bulkAttendance = true;
    renderRoster(jest.fn(), false);
    expect(screen.queryByTestId("bulk-attendance")).toBeNull();
    screen.unmount();

    renderRoster(jest.fn(), true, [{ clientId: "c2", name: "Colin Marsh", attendanceStatus: "attended" }]);
    expect(screen.queryByTestId("bulk-attendance")).toBeNull();
  });

  it("counts only the dancers with no mark yet, and never touches a no-show or an existing present", () => {
    renderRoster(jest.fn());
    expect(markAll().props.accessibilityLabel).toBe("Mark all present (3)");
  });

  it("writes one present per unmarked dancer, one after the other, each with its own key, and says how many were saved", async () => {
    const order: string[] = [];
    const setAttendance = jest.fn(async (_s: string, _a: string, clientId: string, status: string) => {
      order.push(clientId);
      return ok(clientId, status);
    });
    renderRoster(setAttendance);
    await act(async () => fireEvent.press(markAll()));

    expect(order).toEqual(["c1", "c3", "c5"]);
    const calls = setAttendance.mock.calls as unknown as [string, string, string, string, string][];
    expect(calls.map((c) => c[3])).toEqual(["attended", "attended", "attended"]);
    expect(new Set(calls.map((c) => c[4])).size).toBe(3); // a separate idempotency key for each write
    expect(screen.getByTestId("bulk-saved").props.children).toBe("3 dancers marked present.");
    expect(screen.getByTestId("attendance-summary").props.children.join("")).toBe("4 of 5 marked present");
    expect(screen.queryByRole("button", { name: /^Mark all present/ })).toBeNull(); // nothing left to mark
    expect(screen.getByRole("radio", { name: "No-show, Eli Stone" }).props.accessibilityState).toMatchObject({ checked: true });
  });

  it("while it runs the button is gone and a polite status says so", async () => {
    let finish: (r: AttendanceResult) => void = () => undefined;
    const setAttendance = jest.fn(() => new Promise<AttendanceResult>((resolve) => (finish = resolve)));
    renderRoster(setAttendance);
    await act(async () => fireEvent.press(markAll()));
    expect(screen.getByTestId("bulk-running")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Mark all present/ })).toBeNull();
    await act(async () => finish(ok("c1", "attended")));
  });

  it("a refused write reverts that row with its reason, the others save, and Try again retries only the failed one", async () => {
    const setAttendance = jest.fn(async (_s: string, _a: string, clientId: string, status: string) => {
      if (clientId === "c3" && setAttendance.mock.calls.filter((c) => c[2] === "c3").length === 1) throw new StaffApiError(404, "not_found", "x");
      return ok(clientId, status);
    });
    renderRoster(setAttendance);
    await act(async () => fireEvent.press(markAll()));

    expect(screen.getByTestId("bulk-saved").props.children).toBe("2 dancers marked present.");
    expect(screen.getByTestId("bulk-failed").props.children.join("")).toContain("1 dancer did not save.");
    expect(screen.getByText("Not saved. This dancer is no longer on the roster.")).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Present, Dee Park" }).props.accessibilityState).toMatchObject({ checked: false });

    await act(async () => fireEvent.press(screen.getByRole("button", { name: "Try the failed ones again" })));
    const dee = setAttendance.mock.calls.filter((c) => c[2] === "c3");
    expect(dee).toHaveLength(2);
    expect(setAttendance.mock.calls.filter((c) => c[2] === "c1")).toHaveLength(1); // not repeated
    expect(screen.queryByTestId("bulk-failed")).toBeNull();
    expect(screen.getByRole("radio", { name: "Present, Dee Park" }).props.accessibilityState).toMatchObject({ checked: true });
  });

  it("an ended session stops the run after the first refusal instead of repeating it, and the row offers Sign in again", async () => {
    const setAttendance = jest.fn(async () => Promise.reject(new StaffApiError(401, "unauthenticated", "x")));
    renderRoster(setAttendance);
    await act(async () => fireEvent.press(markAll()));
    expect(setAttendance).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("bulk-failed").props.children.join("")).toContain("3 dancers did not save.");
    expect(screen.getAllByRole("button", { name: "Sign in again" }).length).toBeGreaterThan(0);
  });
});
