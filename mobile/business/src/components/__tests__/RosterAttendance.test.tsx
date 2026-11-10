import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { RosterAttendance } from "@/components/RosterAttendance";
import { StaffApiError, type AttendanceResult } from "@/lib/staffApi";
import { deferred, fakeApi, STUDIO_ID, StaffTestProviders } from "@/test-utils/staff";

const ATTENDEES = [
  { clientId: "c1", name: "Ana Rivera", attendanceStatus: null },
  { clientId: "c2", name: null, attendanceStatus: "attended" },
];

function renderRoster(api = fakeApi(), canMark = true) {
  render(
    <StaffTestProviders api={api}>
      <RosterAttendance studioId={STUDIO_ID} appointmentId="appt-1" attendees={ATTENDEES} canMark={canMark} />
    </StaffTestProviders>,
  );
  return api;
}

const radio = (label: string) => screen.getByRole("radio", { name: label });

describe("RosterAttendance", () => {
  it("is read-only without the capability: status in words, no controls", () => {
    const api = renderRoster(fakeApi(), false);
    expect(screen.getByText("Not recorded")).toBeTruthy();
    expect(screen.getByText("Present")).toBeTruthy();
    expect(screen.getByText("Dancer")).toBeTruthy();
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
    expect(api.setAttendance).not.toHaveBeenCalled();
  });

  it("offers Present / Absent as a labelled radio group per dancer, with the current mark checked", () => {
    renderRoster();
    expect(screen.getByLabelText("Attendance for Ana Rivera")).toBeTruthy();
    expect(screen.getByLabelText("Attendance for Dancer")).toBeTruthy();
    expect(radio("Present, Ana Rivera").props.accessibilityState).toMatchObject({ checked: false });
    expect(radio("Present, Dancer").props.accessibilityState).toMatchObject({ checked: true });
    expect(screen.getByTestId("attendance-summary").props.children.join("")).toBe("1 of 2 marked present");
  });

  it("marks present at once, sends one keyed write, and keeps the server's answer", async () => {
    const pending = deferred<AttendanceResult>();
    const api = renderRoster(fakeApi({ setAttendance: jest.fn(() => pending.promise) }));

    fireEvent.press(radio("Present, Ana Rivera"));
    expect(radio("Present, Ana Rivera").props.accessibilityState).toMatchObject({ checked: true, busy: true, disabled: true });
    expect(screen.getByText("Saving…")).toBeTruthy();
    expect(api.setAttendance).toHaveBeenCalledWith(STUDIO_ID, "appt-1", "c1", "attended", expect.stringMatching(/^df-bus-/));

    // a second tap while saving does nothing
    fireEvent.press(radio("Absent, Ana Rivera"));
    expect(api.setAttendance).toHaveBeenCalledTimes(1);

    await act(async () => pending.resolve({ clientId: "c1", attendanceStatus: "attended" }));
    expect(radio("Present, Ana Rivera").props.accessibilityState).toMatchObject({ checked: true, busy: false });
    expect(screen.getByTestId("attendance-summary").props.children.join("")).toBe("2 of 2 marked present");
  });

  it("does not resend a mark that is already set", () => {
    const api = renderRoster();
    fireEvent.press(radio("Present, Dancer"));
    expect(api.setAttendance).not.toHaveBeenCalled();
  });

  it("puts the previous mark back and says why when saving fails", async () => {
    renderRoster(fakeApi({ setAttendance: jest.fn(async () => Promise.reject(new StaffApiError(503, "service_unavailable", "x"))) }));

    await act(async () => {
      fireEvent.press(radio("Absent, Dancer"));
    });

    expect(radio("Present, Dancer").props.accessibilityState).toMatchObject({ checked: true });
    expect(radio("Absent, Dancer").props.accessibilityState).toMatchObject({ checked: false });
    const error = screen.getByTestId("attendance-error-c2");
    expect(error.props.accessibilityRole).toBe("alert");
    expect(screen.getByText("Not saved. Check your connection and try again.")).toBeTruthy();
  });

  it.each([
    [new StaffApiError(401, "unauthenticated", "x"), "Not saved. Sign in again, then retry."],
    [new StaffApiError(403, "role_not_permitted", "x"), "Not saved. Your role cannot mark attendance."],
    [new StaffApiError(403, "not_a_member", "x"), "Not saved. You no longer have access to this studio."],
    [new StaffApiError(404, "not_found", "x"), "Not saved. This dancer is no longer on the roster."],
  ])("explains %s on the row", async (failure, text) => {
    renderRoster(fakeApi({ setAttendance: jest.fn(async () => Promise.reject(failure)) }));
    await act(async () => {
      fireEvent.press(radio("Present, Ana Rivera"));
    });
    expect(screen.getByText(text)).toBeTruthy();
  });

  it("uses a new key for each separate action", async () => {
    const api = renderRoster(fakeApi({ setAttendance: jest.fn(async (_s, _a, clientId: string, status: string) => ({ clientId, attendanceStatus: status })) }));
    await act(async () => {
      fireEvent.press(radio("Present, Ana Rivera"));
    });
    await act(async () => {
      fireEvent.press(radio("Absent, Ana Rivera"));
    });
    const keys = api.setAttendance.mock.calls.map((c: unknown[]) => c[4]);
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
  });
});
