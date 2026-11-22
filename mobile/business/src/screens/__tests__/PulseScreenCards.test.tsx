import { fireEvent, render, screen } from "@testing-library/react-native";
import { router } from "expo-router";
import { toPulseCards } from "@/lib/pulseCards";
import type { StaffPulse } from "@/lib/staffApi";
import { PulseScreen } from "@/screens/PulseScreen";
import { fakeApi, STUDIO_ID, StaffTestProviders } from "@/test-utils/staff";

jest.mock("expo-router", () => ({ router: { push: jest.fn() } }));
jest.mock("react-native-safe-area-context", () => {
  const { View } = jest.requireActual("react-native");
  return { SafeAreaView: View };
});
// The command-center cards are behind the pulseCards word: this file turns it on, the existing PulseScreen test keeps it off.
jest.mock("@/lib/features", () => ({
  ...jest.requireActual("@/lib/features"),
  isStaffFeatureEnabled: (feature: string) => feature === "pulseCards",
}));

const OK = {
  requests: {
    state: "ok",
    bookingRequests: 2,
    selfService: 1,
    total: 3,
    oldestCreatedAt: "2026-11-20T15:30:00.000Z",
    truncated: false,
    recent: [{ id: "r1", source: "self_service", kind: "reschedule", createdAt: "2026-11-22T09:00:00.000Z", requestedStartsAt: null, clientName: "Maya Chen" }],
  },
  leads: {
    state: "ok",
    newLast7Days: 2,
    uncontacted: 1,
    followUpsOverdue: 1,
    truncated: false,
    recent: [{ id: "lead-1", name: "Lena Lead", createdAt: "2026-11-21T10:00:00.000Z", sourceLabel: "Intro booking", uncontacted: true, followUpDueAt: null }],
  },
  aria: { state: "ok", open: 2, truncated: false, recent: [{ id: "x1", title: "Reach out to a lapsed client", priority: "high", createdAt: "2026-11-21T00:00:00.000Z" }] },
  exceptions: { state: "ok", cancelledToday: 1, lowPackages: 3, truncated: false },
  health: { state: "ok", scope: "studio", sessionsToday: 6, sessionsDone: 4, sessionsAhead: 2, truncated: false },
};

function pulse(cards: unknown, overrides: Partial<StaffPulse> = {}): StaffPulse {
  return {
    studioId: STUDIO_ID,
    timeZone: "America/New_York",
    date: "2026-11-22",
    asOf: "2026-11-22T15:30:00.000Z",
    scope: "studio",
    instructorId: null,
    today: { total: 6, upcoming: 2, cancelled: 1, truncated: false },
    next: { id: "appt-9", appointmentType: "private_lesson", title: null, status: "confirmed", startsAt: "2026-11-22T16:00:00.000Z", endsAt: "2026-11-22T16:45:00.000Z" },
    newClientsLast7Days: 3,
    cards: toPulseCards(cards),
    ...overrides,
  };
}

function renderPulse(value: StaffPulse) {
  const api = fakeApi({ pulse: jest.fn(async () => value) });
  render(
    <StaffTestProviders api={api}>
      <PulseScreen />
    </StaffTestProviders>,
  );
  return api;
}

jest.setTimeout(30000); // the first render in a cold worker transforms the whole screen tree

beforeEach(() => jest.clearAllMocks());

describe("Pulse command center (pulseCards on)", () => {
  it("asks the server for the cards and shows every card with words next to the numbers", async () => {
    const api = renderPulse(pulse(OK));
    expect(await screen.findByTestId("pulse-health")).toBeTruthy();
    expect(api.pulse).toHaveBeenCalledWith(STUDIO_ID, { cards: true });
    expect(screen.getByLabelText("sessions today: 6")).toBeTruthy();
    expect(screen.getByLabelText("done: 4")).toBeTruthy();
    expect(screen.getByLabelText("still ahead: 2")).toBeTruthy();
    // Needs you: separate lines, each with its own count
    expect(screen.getByLabelText("3 lesson requests waiting")).toBeTruthy();
    expect(screen.getByLabelText("1 lead follow-up overdue")).toBeTruthy();
    expect(screen.getByLabelText("1 lead not contacted yet")).toBeTruthy();
    expect(screen.getByLabelText("2 ARIA suggestions to review")).toBeTruthy();
    expect(screen.getByText("Reschedule request from Maya Chen")).toBeTruthy();
    expect(screen.getByText(/Oldest has waited 2 days/)).toBeTruthy();
    expect(screen.getByLabelText("cancelled today: 1")).toBeTruthy();
    expect(screen.getByLabelText("packages running low: 3")).toBeTruthy();
    expect(screen.getByText(/Review and approve these in the web app/)).toBeTruthy();
  });

  it("does not draw the v1 Today counts twice when the health card is shown", async () => {
    renderPulse(pulse(OK));
    await screen.findByTestId("pulse-health");
    expect(screen.queryByTestId("pulse-today")).toBeNull();
    expect(screen.getByTestId("pulse-next")).toBeTruthy(); // the compact next-session line stays
  });

  it("opening a lead goes to the client record and nothing else is actionable", async () => {
    renderPulse(pulse(OK));
    fireEvent.press(await screen.findByTestId("pulse-lead-lead-1"));
    expect(router.push).toHaveBeenCalledWith({ pathname: "/clients/[id]", params: { id: "lead-1", studioId: STUDIO_ID } });
    // the only buttons on the screen are the lead and the next appointment: no approve, decline, execute or send control exists on any card
    expect(screen.getAllByRole("button").map((node) => String(node.props.accessibilityLabel))).toEqual([expect.stringContaining("Lena Lead"), expect.stringContaining("Next up")]);
  });

  it("hidden cards draw nothing and no error (front desk: no ARIA; instructor: own scope only)", async () => {
    renderPulse(pulse({ ...OK, aria: null }));
    await screen.findByTestId("pulse-health");
    expect(screen.queryByTestId("pulse-aria")).toBeNull();
    expect(screen.queryByTestId("pulse-aria-unavailable")).toBeNull();
    expect(screen.queryByTestId("pulse-needs-aria")).toBeNull();
    expect(screen.getByTestId("pulse-leads")).toBeTruthy();
  });

  it("an instructor sees their own sessions and exceptions, no leads, ARIA or package count", async () => {
    renderPulse(
      pulse(
        {
          requests: { state: "ok", bookingRequests: 1, selfService: 0, total: 1, oldestCreatedAt: "2026-11-22T10:00:00.000Z", truncated: false, recent: [{ id: "r", source: "booking_request", kind: "book", createdAt: "2026-11-22T10:00:00.000Z", clientName: null }] },
          leads: null,
          aria: null,
          exceptions: { state: "ok", cancelledToday: 0, lowPackages: null, truncated: false },
          health: { state: "ok", scope: "own", sessionsToday: 2, sessionsDone: 1, sessionsAhead: 1, truncated: false },
        },
        { scope: "own", instructorId: "ins-1", newClientsLast7Days: null },
      ),
    );
    expect(await screen.findByText("Your sessions")).toBeTruthy();
    expect(screen.queryByTestId("pulse-leads")).toBeNull();
    expect(screen.queryByTestId("pulse-aria")).toBeNull();
    expect(screen.queryByTestId("pulse-exceptions-low")).toBeNull();
    expect(screen.getByText("Booking request")).toBeTruthy(); // no client name for an instructor
    expect(screen.getByTestId("pulse-exceptions-clear")).toBeTruthy();
  });

  it("one unavailable card says so and leaves the other cards alone", async () => {
    renderPulse(pulse({ ...OK, requests: { state: "unavailable" } }));
    expect(await screen.findByTestId("pulse-requests-unavailable")).toBeTruthy();
    expect(screen.getByTestId("pulse-health")).toBeTruthy();
    expect(screen.getByTestId("pulse-leads")).toBeTruthy();
    expect(screen.getByText(/could not be loaded just now/)).toBeTruthy();
    expect(screen.queryByTestId("pulse-needs-requests")).toBeNull();
  });

  it("empty states are sentences", async () => {
    renderPulse(
      pulse({
        requests: { state: "ok", bookingRequests: 0, selfService: 0, total: 0, oldestCreatedAt: null, truncated: false, recent: [] },
        leads: { state: "ok", newLast7Days: 0, uncontacted: 0, followUpsOverdue: 0, truncated: false, recent: [] },
        aria: { state: "ok", open: 0, truncated: false, recent: [] },
        exceptions: { state: "ok", cancelledToday: 0, lowPackages: 0, truncated: false },
        health: { state: "ok", scope: "studio", sessionsToday: 0, sessionsDone: 0, sessionsAhead: 0, truncated: false },
      }),
    );
    expect(await screen.findByTestId("pulse-needs-you-clear")).toBeTruthy();
    expect(screen.getByTestId("pulse-requests-empty")).toBeTruthy();
    expect(screen.getByTestId("pulse-leads-empty")).toBeTruthy();
    expect(screen.getByTestId("pulse-aria-empty")).toBeTruthy();
    expect(screen.getByTestId("pulse-exceptions-clear")).toBeTruthy();
  });

  it("an older server without cards shows the v1 screen unchanged", async () => {
    const value = pulse(OK);
    delete value.cards;
    renderPulse(value);
    expect(await screen.findByTestId("pulse-today")).toBeTruthy();
    expect(screen.queryByTestId("pulse-health")).toBeNull();
    expect(screen.queryByTestId("pulse-needs-you")).toBeNull();
    expect(screen.getByLabelText("new in the last 7 days: 3")).toBeTruthy();
  });

  it("the New leads card never reuses the all-clients count", async () => {
    renderPulse(pulse(OK));
    await screen.findByTestId("pulse-leads");
    expect(screen.getByLabelText("new leads in 7 days: 2")).toBeTruthy();
    expect(screen.getByLabelText("new in the last 7 days: 3")).toBeTruthy(); // the honest all-clients line is kept, with its own label
  });
});
