import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { router } from "expo-router";
import { StaffApiError, type ClientDetail } from "@/lib/staffApi";
import { ClientDetailScreen, formatExpiry, packageItemLabel } from "@/screens/ClientDetailScreen";
import { fakeApi, STUDIO_ID, StaffTestProviders } from "@/test-utils/staff";

jest.mock("expo-router", () => ({ router: { push: jest.fn() } }));
jest.mock("react-native-safe-area-context", () => {
  const { View } = jest.requireActual("react-native");
  return { SafeAreaView: View };
});

const FRONT_DESK: ClientDetail = {
  id: "c1",
  firstName: "Ana",
  lastName: "Rivera",
  status: "active",
  timeZone: "America/Los_Angeles",
  activePackages: [
    { id: "p1", name: "10 Private Lessons", expiresOn: "2027-01-31", items: [{ usageType: "private_lesson", remaining: 4, unlimited: false }] },
    { id: "p2", name: "Class Pass", expiresOn: null, items: [{ usageType: "group_class", remaining: null, unlimited: true }] },
  ],
  nextAppointment: { id: "a1", appointmentType: "private_lesson", title: null, startsAt: "2026-11-12T18:00:00.000Z", endsAt: "2026-11-12T18:45:00.000Z" },
};

const INSTRUCTOR: ClientDetail = { ...FRONT_DESK, status: null, activePackages: null };

async function renderDetail(detail: ClientDetail | Error) {
  const api = fakeApi({ client: jest.fn(async () => (detail instanceof Error ? Promise.reject(detail) : detail)) });
  render(
    <StaffTestProviders api={api}>
      <ClientDetailScreen clientId="c1" studioId={STUDIO_ID} />
    </StaffTestProviders>,
  );
  await act(async () => undefined);
  return api;
}

describe("ClientDetailScreen", () => {
  it("shows front desk the status, packages (remaining counts and expiry) and next booking in the studio's zone", async () => {
    await renderDetail(FRONT_DESK);
    expect(screen.getByText("Ana Rivera")).toBeTruthy();
    expect(screen.getByText("Active")).toBeTruthy();
    expect(screen.getByTestId("client-packages")).toBeTruthy();
    expect(screen.getByText("Private lesson: 4 remaining")).toBeTruthy();
    expect(screen.getByText("Expires Jan 31, 2027")).toBeTruthy();
    expect(screen.getByText("Group class: unlimited")).toBeTruthy();
    expect(screen.getByText("No expiry")).toBeTruthy();
    // 18:00Z is 10:00 AM in Los Angeles (PST), not the device's zone
    expect(screen.getByText("Thu, Nov 12, 10:00 AM")).toBeTruthy();
  });

  it("hides status and packages for an instructor instead of showing them empty", async () => {
    await renderDetail(INSTRUCTOR);
    expect(screen.getByText("Ana Rivera")).toBeTruthy();
    expect(screen.queryByText("Active")).toBeNull();
    expect(screen.queryByTestId("client-packages")).toBeNull();
    expect(screen.queryByText("No active packages.")).toBeNull();
    expect(screen.getByTestId("next-booking")).toBeTruthy();
  });

  it("says no active packages when front desk sees an empty list", async () => {
    await renderDetail({ ...FRONT_DESK, activePackages: [] });
    expect(screen.getByText("No active packages.")).toBeTruthy();
  });

  it("uses the class or lesson title when there is one", async () => {
    await renderDetail({ ...FRONT_DESK, nextAppointment: { ...FRONT_DESK.nextAppointment!, appointmentType: "group_class", title: "Beginner Salsa" } });
    expect(screen.getByText("Beginner Salsa")).toBeTruthy();
  });

  it("opens the next booking with the studio zone", async () => {
    await renderDetail(FRONT_DESK);
    fireEvent.press(screen.getByRole("button", { name: /Private lesson, Thu, Nov 12/ }));
    expect(router.push).toHaveBeenCalledWith({ pathname: "/appointments/[id]", params: { id: "a1", studioId: STUDIO_ID, tz: "America/Los_Angeles" } });
  });

  it("explains a 404 as a client this person can't see", async () => {
    await renderDetail(new StaffApiError(404, "not_found", "Not found."));
    expect(screen.getByText("Client not found")).toBeTruthy();
  });

  it("formats expiry as a calendar date without shifting the day", () => {
    expect(formatExpiry("2027-01-01")).toBe("Expires Jan 1, 2027");
    expect(packageItemLabel({ usageType: "coaching", remaining: 1, unlimited: false })).toBe("Coaching: 1 remaining");
    expect(packageItemLabel({ usageType: "private_lesson", remaining: null, unlimited: false })).toBe("Private lesson: not tracked");
  });
});
