import { fireEvent, render, screen } from "@testing-library/react-native";
import { router } from "expo-router";
import { toStaffStudioDay } from "@/lib/staffApi";
import { StudioScheduleScreen } from "@/screens/StudioScheduleScreen";
import { auditA11y } from "@/test-utils/a11y";
import { fakeApi, STUDIO_ID, StaffTestProviders } from "@/test-utils/staff";

jest.setTimeout(20_000);

const mockFeatures = new Set<string>();
jest.mock("@/lib/features", () => ({
  ...jest.requireActual("@/lib/features"),
  isStaffFeatureEnabled: (feature: string) => mockFeatures.has(feature),
}));
jest.mock("expo-router", () => ({ router: { push: jest.fn() } }));
jest.mock("react-native-safe-area-context", () => {
  const { View } = jest.requireActual("react-native");
  return { SafeAreaView: View };
});

const NOW = Date.parse("2026-11-24T15:00:00.000Z");

const row = (id: string, startsAt: string, endsAt: string, over: Record<string, unknown> = {}) => ({
  id,
  title: null,
  appointmentType: "private_lesson",
  status: "scheduled",
  startsAt,
  endsAt,
  room: null,
  locationName: null,
  client: { id: "c1", firstName: "Ana", lastName: "Rivera" },
  partner: null,
  instructor: { id: "i1", firstName: "Ida", lastName: "Instructor" },
  ...over,
});

function day(appointments: unknown[]) {
  return toStaffStudioDay({ studioId: STUDIO_ID, date: "2026-11-24", timeZone: "America/New_York", truncated: false, appointments });
}

function renderStudio(studioSchedule: jest.Mock) {
  return render(
    <StaffTestProviders api={fakeApi({ studioSchedule })}>
      <StudioScheduleScreen />
    </StaffTestProviders>,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockFeatures.clear();
  jest.spyOn(Date, "now").mockReturnValue(NOW);
});
afterEach(() => jest.restoreAllMocks());

describe("studio schedule: next up", () => {
  it("shows the next open lesson with one obvious button that opens it", async () => {
    mockFeatures.add("appointmentAttendance");
    renderStudio(
      jest.fn(async () => day([row("later", "2026-11-24T17:00:00.000Z", "2026-11-24T17:45:00.000Z"), row("soon", "2026-11-24T15:30:00.000Z", "2026-11-24T16:15:00.000Z")])),
    );
    expect(await screen.findByTestId("next-up")).toBeTruthy();
    expect(screen.getByText("Next up")).toBeTruthy();
    fireEvent.press(screen.getByRole("button", { name: "Check in Ana Rivera" }));
    expect(router.push).toHaveBeenCalledWith({ pathname: "/appointments/[id]", params: { id: "soon", studioId: STUDIO_ID, tz: "America/New_York" } });
    expect(screen.queryByTestId("next-up-behind")).toBeNull();
  });

  it("says how many earlier lessons still have no result", async () => {
    mockFeatures.add("appointmentAttendance");
    renderStudio(
      jest.fn(async () =>
        day([
          row("e1", "2026-11-24T10:00:00.000Z", "2026-11-24T10:45:00.000Z"),
          row("e2", "2026-11-24T11:00:00.000Z", "2026-11-24T11:45:00.000Z"),
          row("soon", "2026-11-24T15:30:00.000Z", "2026-11-24T16:15:00.000Z"),
        ]),
      ),
    );
    expect(await screen.findByText("2 earlier lessons or classes still have no result.")).toBeTruthy();
  });

  it("when only ended lessons are open, the card asks for their result", async () => {
    mockFeatures.add("appointmentAttendance");
    renderStudio(jest.fn(async () => day([row("e1", "2026-11-24T10:00:00.000Z", "2026-11-24T10:45:00.000Z")])));
    expect(await screen.findByText("Still to record")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Record the result for Ana Rivera" })).toBeTruthy();
  });

  it("a class gets Take attendance, and only when the attendance capability is on", async () => {
    mockFeatures.add("attendance");
    const classRow = row("cls", "2026-11-24T16:00:00.000Z", "2026-11-24T17:00:00.000Z", { appointmentType: "group_class", title: "Salsa", client: null });
    const first = renderStudio(jest.fn(async () => day([classRow])));
    expect(await screen.findByRole("button", { name: "Take attendance" })).toBeTruthy();
    first.unmount();
    mockFeatures.clear();
    renderStudio(jest.fn(async () => day([classRow])));
    await screen.findByText("1 appointment");
    expect(screen.queryByTestId("next-up")).toBeNull();
  });

  it("a build without the lesson write word shows no lesson check-in card", async () => {
    renderStudio(jest.fn(async () => day([row("soon", "2026-11-24T15:30:00.000Z", "2026-11-24T16:15:00.000Z")])));
    await screen.findByText("1 appointment");
    expect(screen.queryByTestId("next-up")).toBeNull();
  });

  it("is only for today: another day has no next up", async () => {
    mockFeatures.add("appointmentAttendance");
    renderStudio(jest.fn(async () => day([row("soon", "2026-11-25T15:30:00.000Z", "2026-11-25T16:15:00.000Z")])));
    expect(await screen.findByTestId("next-up")).toBeTruthy();
    fireEvent.press(screen.getByRole("button", { name: "Next day" }));
    await screen.findByRole("button", { name: "Today" });
    await screen.findByText("1 appointment");
    expect(screen.queryByTestId("next-up")).toBeNull();
  });

  it("passes the accessibility audit (roles, names, 44pt targets, text scales to 200%)", async () => {
    mockFeatures.add("appointmentAttendance");
    renderStudio(
      jest.fn(async () => day([row("e1", "2026-11-24T10:00:00.000Z", "2026-11-24T10:45:00.000Z"), row("soon", "2026-11-24T15:30:00.000Z", "2026-11-24T16:15:00.000Z")])),
    );
    await screen.findByTestId("next-up");
    expect(auditA11y(screen.UNSAFE_root)).toEqual([]);
  });
});
