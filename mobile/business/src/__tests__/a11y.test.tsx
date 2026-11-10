import { act, render, screen, fireEvent } from "@testing-library/react-native";
import type React from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { StaffErrorState } from "@/components/StaffErrorState";
import { StaffApiError, type AppointmentDetail, type StaffToday } from "@/lib/staffApi";
import { AppointmentScreen } from "@/screens/AppointmentScreen";
import { ClientDetailScreen } from "@/screens/ClientDetailScreen";
import { ClientsScreen, SEARCH_DEBOUNCE_MS } from "@/screens/ClientsScreen";
import { MoreScreen } from "@/screens/MoreScreen";
import { TodayScreen } from "@/screens/TodayScreen";
import SignInScreen from "../../app/sign-in";
import { auditA11y } from "@/test-utils/a11y";
import { fakeApi, STUDIO_ID, StaffTestProviders, workspace } from "@/test-utils/staff";

jest.mock("expo-router", () => ({ router: { push: jest.fn() } }));
jest.mock("react-native-safe-area-context", () => {
  const { View: RNView } = jest.requireActual("react-native");
  return { SafeAreaView: RNView };
});
jest.mock("@/lib/features", () => ({ ...jest.requireActual("@/lib/features"), isStaffFeatureEnabled: () => true }));
jest.mock("@/lib/auth", () => ({
  useAuth: () => ({ signInWithPassword: jest.fn(), sendSignInLink: jest.fn() }),
}));

const DAY: StaffToday = {
  studioId: STUDIO_ID,
  date: "2026-11-10",
  timeZone: "America/New_York",
  instructorId: "i1",
  appointments: [
    { id: "a1", title: null, appointmentType: "private_lesson", status: "confirmed", startsAt: "2026-11-10T15:00:00Z", endsAt: "2026-11-10T15:45:00Z", room: { id: "r", name: "Main Floor" }, locationName: null, client: { id: "c1", firstName: "Ana", lastName: "Rivera" }, partner: null },
    { id: "a2", title: "Beginner Salsa", appointmentType: "group_class", status: "cancelled", startsAt: "2026-11-11T00:00:00Z", endsAt: "2026-11-11T01:00:00Z", room: null, locationName: null, client: null, partner: null },
  ],
};

const CLASS: AppointmentDetail = {
  ...DAY.appointments[1],
  status: "scheduled",
  studioId: STUDIO_ID,
  accessScope: "own-instructor",
  notes: "Warm up with the basic.",
  instructor: { id: "i1", firstName: "Ida", lastName: "Instructor" },
  roster: { bookedCount: 2, capacity: 12, attendees: [{ clientId: "c1", name: "Ana Rivera", attendanceStatus: null }, { clientId: "c2", name: null, attendanceStatus: "attended" }] },
  recap: null,
};

const LESSON: AppointmentDetail = {
  ...DAY.appointments[0],
  studioId: STUDIO_ID,
  accessScope: "own-instructor",
  notes: null,
  instructor: { id: "i1", firstName: "Ida", lastName: "Instructor" },
  recap: { summary: "Frame", homework: "Box step", nextFocus: "Timing", visibleToClient: true, updatedAt: null },
};

function expectClean() {
  expect(auditA11y(screen.UNSAFE_root)).toEqual([]);
}

async function flush(ms = 0) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
}

function withProviders(node: React.ReactElement, api = fakeApi(), extra: Partial<React.ComponentProps<typeof StaffTestProviders>> = {}) {
  render(
    <StaffTestProviders api={api} {...extra}>
      {node}
    </StaffTestProviders>,
  );
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe("the auditor itself (negative controls)", () => {
  it("flags a nameless, roleless, tiny pressable, truncated or unscalable text, a fixed-height text box and an unlabelled input", () => {
    render(
      <View>
        <Pressable onPress={() => undefined} style={{ minHeight: 20 }} />
        <Text numberOfLines={1}>Cut off</Text>
        <Text allowFontScaling={false}>Fixed</Text>
        <View style={{ height: 30 }}>
          <Text>Clipped</Text>
        </View>
        <TextInput style={{ minHeight: 48 }} />
      </View>,
    );
    const problems = auditA11y(screen.UNSAFE_root).join("\n");
    expect(problems).toMatch(/pressable without an interactive role/);
    expect(problems).toMatch(/pressable without a name/);
    expect(problems).toMatch(/touch target under 44pt/);
    expect(problems).toMatch(/truncated text/);
    expect(problems).toMatch(/font scaling turned off/);
    expect(problems).toMatch(/fixed-height container holding text/);
    expect(problems).toMatch(/text input without a label/);
  });
});

describe("every screen passes the audit", () => {
  it("sign-in", () => {
    render(<SignInScreen />);
    expectClean();
  });

  it("Today with appointments", async () => {
    withProviders(<TodayScreen />, fakeApi({ today: jest.fn(async () => DAY) }));
    await flush();
    expect(screen.getByText("2 appointments")).toBeTruthy();
    expectClean();
  });

  it("Today loading, empty, not linked and error", async () => {
    withProviders(<TodayScreen />, fakeApi({ today: jest.fn(() => new Promise<StaffToday>(() => undefined)) }));
    await flush();
    expectClean();
    screen.unmount();

    withProviders(<TodayScreen />, fakeApi({ today: jest.fn(async () => ({ ...DAY, appointments: [] })) }));
    await flush();
    expectClean();
    screen.unmount();

    withProviders(<TodayScreen />, fakeApi({ today: jest.fn(async () => ({ ...DAY, instructorId: null, appointments: [] })) }));
    await flush();
    expectClean();
    screen.unmount();

    withProviders(<TodayScreen />, fakeApi({ today: jest.fn(async () => Promise.reject(new StaffApiError(503, "service_unavailable", "x"))) }));
    await flush();
    expectClean();
  });

  it("group class with attendance marking", async () => {
    withProviders(<AppointmentScreen appointmentId="a2" studioId={STUDIO_ID} timeZone="America/New_York" />, fakeApi({ appointment: jest.fn(async () => CLASS) }));
    await flush();
    expect(screen.getAllByRole("radio").length).toBe(4);
    expectClean();
  });

  it("private lesson with recap", async () => {
    withProviders(<AppointmentScreen appointmentId="a1" studioId={STUDIO_ID} timeZone="America/New_York" />, fakeApi({ appointment: jest.fn(async () => LESSON) }));
    await flush();
    expect(screen.getByText("Lesson recap")).toBeTruthy();
    expectClean();
  });

  it("clients list with paging, and no match", async () => {
    const api = fakeApi({
      searchClients: jest.fn(async (_s: string, p: { q?: string }) =>
        p.q ? { clients: [], nextCursor: null } : { clients: [{ id: "c1", firstName: "Ana", lastName: "Rivera", status: "active" }], nextCursor: "n" },
      ),
    });
    withProviders(<ClientsScreen />, api);
    await flush(SEARCH_DEBOUNCE_MS);
    expect(screen.getByRole("button", { name: "Load more clients" })).toBeTruthy();
    expectClean();
    fireEvent.changeText(screen.getByLabelText("Search clients"), "zz");
    await flush(SEARCH_DEBOUNCE_MS);
    expect(screen.getByText("No clients match")).toBeTruthy();
    expectClean();
  });

  it("client summary", async () => {
    withProviders(
      <ClientDetailScreen clientId="c1" studioId={STUDIO_ID} />,
      fakeApi({
        client: jest.fn(async () => ({
          id: "c1",
          firstName: "Ana",
          lastName: "Rivera",
          status: "active",
          activePackages: [
            { id: "p1", name: "10 Private Lessons", expiresOn: "2027-01-31", items: [{ usageType: "private_lesson", remaining: 4, unlimited: false }] },
          ],
          nextAppointment: { id: "a1", appointmentType: "private_lesson", title: null, startsAt: "2026-11-12T15:00:00.000Z", endsAt: "2026-11-12T15:45:00.000Z" },
          timeZone: "America/New_York",
        })),
      }),
    );
    await flush();
    expect(screen.getByText("Private lesson: 4 remaining")).toBeTruthy();
    expectClean();
  });

  it("client summary for an instructor (no status, no packages)", async () => {
    withProviders(
      <ClientDetailScreen clientId="c1" studioId={STUDIO_ID} />,
      fakeApi({
        client: jest.fn(async () => ({
          id: "c1",
          firstName: "Ana",
          lastName: "Rivera",
          status: null,
          activePackages: null,
          nextAppointment: null,
          timeZone: "America/New_York",
        })),
      }),
    );
    await flush();
    expect(screen.getByText("Nothing booked.")).toBeTruthy();
    expectClean();
  });

  it("More with several studios and the sign-out-everywhere confirmation", async () => {
    const second = workspace({ studioId: "studio-2", name: "Harbor", publicName: null, role: "instructor" });
    withProviders(<MoreScreen />, fakeApi(), { workspaces: [workspace(), second] });
    expectClean();
    fireEvent.press(screen.getByRole("button", { name: "Sign out of all devices" }));
    expectClean();
  });

  it.each(["unauthenticated", "account_inactive", "platform_admin_unsupported", "not_a_member", "workspace_paused", "role_not_permitted", "not_found", "not_markable", "invalid_request", "service_unavailable"] as const)(
    "error state %s",
    (code) => {
      render(<StaffErrorState error={new StaffApiError(400, code, "x")} onRetry={jest.fn()} onSignInAgain={jest.fn()} onRefreshWorkspaces={jest.fn()} />);
      expect(JSON.stringify(screen.toJSON())).toContain("\"accessibilityRole\":\"alert\"");
      expectClean();
    },
  );
});
