import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { router } from "expo-router";
import { StaffApiError, type StaffPulse } from "@/lib/staffApi";
import { PulseScreen } from "@/screens/PulseScreen";
import { fakeApi, STUDIO_ID, StaffTestProviders } from "@/test-utils/staff";

jest.mock("expo-router", () => ({ router: { push: jest.fn() } }));
jest.mock("react-native-safe-area-context", () => {
  const { View } = jest.requireActual("react-native");
  return { SafeAreaView: View };
});

const STUDIO: StaffPulse = {
  studioId: STUDIO_ID,
  timeZone: "America/New_York",
  date: "2026-11-09",
  asOf: "2026-11-09T15:30:00.000Z",
  scope: "studio",
  instructorId: null,
  today: { total: 5, upcoming: 4, cancelled: 1, truncated: false },
  next: { id: "appt-9", appointmentType: "private_lesson", title: null, status: "confirmed", startsAt: "2026-11-09T16:00:00.000Z", endsAt: "2026-11-09T16:45:00.000Z" },
  newClientsLast7Days: 3,
};

const OWN: StaffPulse = { ...STUDIO, scope: "own", instructorId: "ins-1", newClientsLast7Days: null, today: { total: 2, upcoming: 1, cancelled: 0, truncated: false } };

function renderPulse(api = fakeApi({ pulse: jest.fn(async () => STUDIO) }), providerProps = {}) {
  render(
    <StaffTestProviders api={api} {...providerProps}>
      <PulseScreen />
    </StaffTestProviders>,
  );
  return api;
}

beforeEach(() => jest.clearAllMocks());

describe("PulseScreen", () => {
  it("shows a loading state, then the studio's numbers with words next to them", async () => {
    let finish: (value: StaffPulse) => void = () => undefined;
    const api = fakeApi({ pulse: jest.fn(() => new Promise<StaffPulse>((resolve) => (finish = resolve))) });
    renderPulse(api);
    expect(screen.getByLabelText("Loading the studio pulse")).toBeTruthy();

    await act(async () => finish(STUDIO));
    expect(api.pulse).toHaveBeenCalledWith(STUDIO_ID);
    expect(screen.getByText(/Studio today/)).toBeTruthy();
    expect(screen.getByLabelText("appointments: 5")).toBeTruthy();
    expect(screen.queryByText("5 appointments")).toBeNull(); // the number is shown once, not twice
    expect(screen.getByLabelText("still to come: 4")).toBeTruthy();
    expect(screen.getByLabelText("cancelled: 1")).toBeTruthy();
    expect(screen.getByLabelText("new in the last 7 days: 3")).toBeTruthy();
  });

  it("an instructor sees their own day and no client count", async () => {
    renderPulse(fakeApi({ pulse: jest.fn(async () => OWN) }));
    expect(await screen.findByText(/Your day/)).toBeTruthy();
    expect(screen.queryByTestId("pulse-new-clients")).toBeNull();
    expect(screen.queryByTestId("pulse-cancelled")).toBeNull();
  });

  it("an empty day says so in words and still shows what is next", async () => {
    renderPulse(fakeApi({ pulse: jest.fn(async () => ({ ...STUDIO, today: { total: 0, upcoming: 0, cancelled: 0, truncated: false } })) }));
    expect(await screen.findByTestId("pulse-today-empty")).toBeTruthy();
    expect(screen.getByTestId("pulse-next")).toBeTruthy();
  });

  it("no next appointment is a sentence, not a blank", async () => {
    renderPulse(fakeApi({ pulse: jest.fn(async () => ({ ...STUDIO, next: null })) }));
    expect(await screen.findByTestId("pulse-next-none")).toBeTruthy();
  });

  it("flags a cut-off day", async () => {
    renderPulse(fakeApi({ pulse: jest.fn(async () => ({ ...STUDIO, today: { ...STUDIO.today, truncated: true } })) }));
    expect(await screen.findByTestId("pulse-truncated")).toBeTruthy();
  });

  it("an instructor with no instructor profile gets the not-linked explanation, not zeros", async () => {
    renderPulse(fakeApi({ pulse: jest.fn(async () => ({ ...OWN, instructorId: null })) }));
    expect(await screen.findByTestId("pulse-not-linked")).toBeTruthy();
    expect(screen.queryByTestId("pulse-today")).toBeNull();
  });

  it("opens the next appointment with the studio and time zone", async () => {
    renderPulse();
    fireEvent.press(await screen.findByRole("button", { name: /Next up: Private lesson/ }));
    expect(router.push).toHaveBeenCalledWith({ pathname: "/appointments/[id]", params: { id: "appt-9", studioId: STUDIO_ID, tz: "America/New_York" } });
  });

  it("a 401 asks to sign in again and the button signs out", async () => {
    const signOut = jest.fn(async () => undefined);
    renderPulse(fakeApi({ pulse: jest.fn(async () => Promise.reject(new StaffApiError(401, "unauthenticated", "x"))) }), { signOut });
    fireEvent.press(await screen.findByRole("button", { name: "Sign in again" }));
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it("a 403 role refusal is explained and offers a studio refresh, not a retry loop", async () => {
    const reload = jest.fn(async () => undefined);
    renderPulse(fakeApi({ pulse: jest.fn(async () => Promise.reject(new StaffApiError(403, "role_not_permitted", "x"))) }), { reload });
    expect(await screen.findByTestId("error-not-permitted")).toBeTruthy();
    fireEvent.press(screen.getByRole("button", { name: "Refresh studios" }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("after a 403, Refresh studios reloads the studio list and then the screen itself, so the numbers come back without a pull", async () => {
    const reload = jest.fn(async () => undefined);
    const pulse = jest.fn().mockRejectedValueOnce(new StaffApiError(403, "role_not_permitted", "x")).mockResolvedValueOnce(STUDIO);
    renderPulse(fakeApi({ pulse }), { reload });
    fireEvent.press(await screen.findByRole("button", { name: "Refresh studios" }));
    expect(await screen.findByLabelText("appointments: 5")).toBeTruthy();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(pulse).toHaveBeenCalledTimes(2);
  });

  it("an outage retries on the button and recovers", async () => {
    const pulse = jest.fn().mockRejectedValueOnce(new StaffApiError(503, "service_unavailable", "x")).mockResolvedValueOnce(STUDIO);
    renderPulse(fakeApi({ pulse }));
    fireEvent.press(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByLabelText("appointments: 5")).toBeTruthy();
    expect(pulse).toHaveBeenCalledTimes(2);
  });
});

