import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { StaffApiError, type AppointmentDetail } from "@/lib/staffApi";
import { AppointmentScreen } from "@/screens/AppointmentScreen";
import { auditA11y } from "@/test-utils/a11y";
import { deferred, fakeApi, STUDIO_ID, StaffTestProviders, workspace } from "@/test-utils/staff";

jest.setTimeout(30_000);

const flags = { appointmentAttendance: true };
jest.mock("@/lib/features", () => ({
  ...jest.requireActual("@/lib/features"),
  isStaffFeatureEnabled: (feature: string) => (feature === "appointmentAttendance" ? flags.appointmentAttendance : true),
}));
jest.mock("expo-router", () => ({ router: { push: jest.fn() } }));
jest.mock("react-native-safe-area-context", () => {
  const { View } = jest.requireActual("react-native");
  return { SafeAreaView: View };
});

const LESSON = (over: Partial<AppointmentDetail> = {}): AppointmentDetail =>
  ({
    id: "lesson-1",
    title: null,
    appointmentType: "private_lesson",
    status: "scheduled",
    startsAt: "2026-11-20T15:00:00.000Z",
    endsAt: "2026-11-20T15:45:00.000Z",
    room: null,
    locationName: null,
    client: { id: "c1", firstName: "Ana", lastName: "Rivera" },
    partner: null,
    studioId: STUDIO_ID,
    timeZone: "America/New_York",
    accessScope: "broad",
    notes: null,
    instructor: null,
    roster: null,
    recap: null,
    ...over,
  }) as AppointmentDetail;

beforeEach(() => {
  flags.appointmentAttendance = true;
  jest.clearAllMocks();
});

async function renderLesson(opts: { detail?: AppointmentDetail; outcome?: jest.Mock; ws?: ReturnType<typeof workspace> } = {}) {
  const outcome = opts.outcome ?? jest.fn(async (_s: string, _a: string, input: { status: string }) => ({ id: "lesson-1", status: input.status, alreadyApplied: false }));
  const api = fakeApi({ appointment: jest.fn(async () => opts.detail ?? LESSON()), setAppointmentOutcome: outcome });
  render(
    <StaffTestProviders api={api} ws={opts.ws}>
      <AppointmentScreen appointmentId="lesson-1" studioId={STUDIO_ID} />
    </StaffTestProviders>,
  );
  await act(async () => undefined);
  return { api, outcome };
}

const status = () => screen.getByTestId("check-in-status").props.children.join("");

describe("private-lesson check-in", () => {
  it("offers Mark attended (primary) and No-show for an open one-to-one lesson, and asks before sending", async () => {
    const { outcome } = await renderLesson();
    expect(status()).toBe("Status: Scheduled");
    fireEvent.press(screen.getByLabelText("Mark attended"));
    expect(screen.getByText("Mark Ana Rivera attended?")).toBeTruthy();
    expect(outcome).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.press(screen.getAllByLabelText("Mark attended").at(-1)!);
    });
    expect(outcome).toHaveBeenCalledTimes(1);
    const [studio, appt, input, key] = outcome.mock.calls[0] as unknown as [string, string, Record<string, unknown>, string];
    expect([studio, appt]).toEqual([STUDIO_ID, "lesson-1"]);
    expect(input).toEqual({ status: "attended" });
    expect(key).toMatch(/^df-bus-/);
    expect(status()).toBe("Status: Attended");
    expect(screen.getByTestId("check-in-recorded").props.children.join("")).toContain("Marked attended");
    expect(screen.getByText(/can't be changed in the app/)).toBeTruthy();
    // final: no controls and no undo
    expect(screen.queryByLabelText("No-show")).toBeNull();
    expect(screen.queryByLabelText(/undo|reset/i)).toBeNull();
  });

  it("the status changes at once (optimistic) while the request is running, and a double tap sends one request", async () => {
    const d = deferred<{ id: string; status: string; alreadyApplied: boolean }>();
    const { outcome } = await renderLesson({ outcome: jest.fn(() => d.promise) });
    fireEvent.press(screen.getByLabelText("Mark attended"));
    fireEvent.press(screen.getAllByLabelText("Mark attended").at(-1)!);
    expect(status()).toBe("Status: Attended");
    expect(screen.getByTestId("check-in-notice-saving")).toBeTruthy();
    expect(screen.queryByLabelText("No-show")).toBeNull(); // controls are gone while saving: no second tap
    expect(outcome).toHaveBeenCalledTimes(1);
    await act(async () => d.resolve({ id: "lesson-1", status: "attended", alreadyApplied: false }));
  });

  it("no-show asks what happens to the credit and sends the choice", async () => {
    const { outcome } = await renderLesson();
    fireEvent.press(screen.getByLabelText("No-show"));
    expect(screen.getByText("Mark Ana Rivera as a no-show?")).toBeTruthy();
    fireEvent.press(screen.getByTestId("charge-package"));
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Mark no-show"));
    });
    expect(outcome.mock.calls[0][2]).toEqual({ status: "no_show", missedAppointmentCharge: "package" });
    expect(status()).toBe("Status: No-show");
  });

  it("no-show defaults to no charge", async () => {
    const { outcome } = await renderLesson();
    fireEvent.press(screen.getByLabelText("No-show"));
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Mark no-show"));
    });
    expect(outcome.mock.calls[0][2]).toEqual({ status: "no_show", missedAppointmentCharge: "none" });
  });

  it("outcome_conflict puts back what the server says the lesson already is, in words, with no retry", async () => {
    const conflict = new StaffApiError(409, "conflict", "x", undefined, { serverCode: "outcome_conflict", current: { status: "no_show" } });
    await renderLesson({ outcome: jest.fn(async () => Promise.reject(conflict)) });
    fireEvent.press(screen.getByLabelText("Mark attended"));
    await act(async () => {
      fireEvent.press(screen.getAllByLabelText("Mark attended").at(-1)!);
    });
    expect(screen.getByText("Already recorded")).toBeTruthy();
    expect(status()).toBe("Status: No-show");
    expect(screen.queryByLabelText("Retry")).toBeNull();
    expect(screen.queryByLabelText("Try again")).toBeNull();
  });

  it("payment_required rolls the status back and says where to fix it", async () => {
    const e = new StaffApiError(409, "conflict", "x", undefined, { serverCode: "payment_required" });
    await renderLesson({ outcome: jest.fn(async () => Promise.reject(e)) });
    fireEvent.press(screen.getByLabelText("Mark attended"));
    await act(async () => {
      fireEvent.press(screen.getAllByLabelText("Mark attended").at(-1)!);
    });
    expect(screen.getByText("Payment needed first")).toBeTruthy();
    expect(status()).toBe("Status: Scheduled");
  });

  it("usage_sync_pending keeps Attended (it IS recorded), offers Try again with the same key and no Discard, and the retry finishes it", async () => {
    const pending = new StaffApiError(409, "conflict", "x", undefined, { serverCode: "usage_sync_pending" });
    const outcome = jest
      .fn()
      .mockRejectedValueOnce(pending)
      .mockResolvedValueOnce({ id: "lesson-1", status: "attended", alreadyApplied: true });
    await renderLesson({ outcome });
    fireEvent.press(screen.getByLabelText("Mark attended"));
    await act(async () => {
      fireEvent.press(screen.getAllByLabelText("Mark attended").at(-1)!);
    });
    expect(screen.getByText("Saved, not finished")).toBeTruthy();
    expect(status()).toBe("Status: Attended");
    expect(screen.queryByLabelText("Discard this change")).toBeNull();
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Try again"));
    });
    expect(outcome).toHaveBeenCalledTimes(2);
    expect(outcome.mock.calls[1][3]).toBe(outcome.mock.calls[0][3]);
    expect(screen.queryByText("Saved, not finished")).toBeNull();
  });

  it("a lost answer keeps the optimistic status with Try again (same key) or Discard (rolls back)", async () => {
    const lost = new StaffApiError(0, "network_error", "x");
    const outcome = jest.fn().mockRejectedValueOnce(lost).mockResolvedValueOnce({ id: "lesson-1", status: "attended", alreadyApplied: false });
    await renderLesson({ outcome });
    fireEvent.press(screen.getByLabelText("Mark attended"));
    await act(async () => {
      fireEvent.press(screen.getAllByLabelText("Mark attended").at(-1)!);
    });
    expect(screen.getByText("Not confirmed")).toBeTruthy();
    expect(status()).toBe("Status: Attended");
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Try again"));
    });
    expect(outcome.mock.calls[1][3]).toBe(outcome.mock.calls[0][3]);
    expect(status()).toBe("Status: Attended");
  });

  it("Discard after a lost answer puts the previous status back and offers the buttons again", async () => {
    await renderLesson({ outcome: jest.fn(async () => Promise.reject(new StaffApiError(0, "network_error", "x"))) });
    fireEvent.press(screen.getByLabelText("Mark attended"));
    await act(async () => {
      fireEvent.press(screen.getAllByLabelText("Mark attended").at(-1)!);
    });
    fireEvent.press(screen.getByLabelText("Discard this change"));
    expect(status()).toBe("Status: Scheduled");
    expect(screen.getByLabelText("No-show")).toBeTruthy();
  });

  it.each([
    ["writes_disabled", new StaffApiError(403, "writes_disabled", "off"), "This change is turned off"],
    ["upgrade_required", new StaffApiError(426, "upgrade_required", "old"), "Update DanceFlow Business"],
  ])("%s: said in words, status rolled back, no retry", async (_n, error, title) => {
    await renderLesson({ outcome: jest.fn(async () => Promise.reject(error)) });
    fireEvent.press(screen.getByLabelText("Mark attended"));
    await act(async () => {
      fireEvent.press(screen.getAllByLabelText("Mark attended").at(-1)!);
    });
    expect(screen.getByText(title)).toBeTruthy();
    expect(status()).toBe("Status: Scheduled");
    expect(screen.queryByLabelText("Retry")).toBeNull();
  });

  it("shows no controls for a lesson that already has a final outcome, a cancelled one, a group class, or behind the flag, or without the capability", async () => {
    for (const detail of [LESSON({ status: "attended" }), LESSON({ status: "no_show" }), LESSON({ status: "cancelled" })]) {
      await renderLesson({ detail });
      expect(screen.queryByLabelText("Mark attended")).toBeNull();
      screen.unmount();
    }
    await renderLesson({ detail: LESSON({ appointmentType: "group_class", roster: { bookedCount: 0, capacity: 5, attendees: [] } } as Partial<AppointmentDetail>) });
    expect(screen.queryByTestId("lesson-check-in")).toBeNull();
    screen.unmount();
    flags.appointmentAttendance = false;
    await renderLesson();
    expect(screen.queryByTestId("lesson-check-in")).toBeNull();
    screen.unmount();
    flags.appointmentAttendance = true;
    await renderLesson({ ws: workspace({ capabilities: { viewStudioSchedule: true, viewClients: true, markAttendance: false } }) });
    expect(screen.queryByTestId("lesson-check-in")).toBeNull();
  });

  it("passes the static accessibility audit with the sheet open", async () => {
    await renderLesson();
    fireEvent.press(screen.getByLabelText("No-show"));
    expect(auditA11y(screen.UNSAFE_root)).toEqual([]);
  });
});
