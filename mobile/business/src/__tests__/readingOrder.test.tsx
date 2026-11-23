import { act, render, screen } from "@testing-library/react-native";
import type React from "react";
import { inOrder, spokenOrder, type RenderedNode } from "@/test-utils/readingOrder";
import { StaffApiError, type AppointmentDetail, type ClientDetail, type StaffPulse, type StaffStudioDay, type StaffToday } from "@/lib/staffApi";
import { AppointmentScreen } from "@/screens/AppointmentScreen";
import { ClientDetailScreen } from "@/screens/ClientDetailScreen";
import { MoreScreen } from "@/screens/MoreScreen";
import { PulseScreen } from "@/screens/PulseScreen";
import { StudioScheduleScreen } from "@/screens/StudioScheduleScreen";
import { TodayScreen } from "@/screens/TodayScreen";
import SignInScreen from "../../app/sign-in";
import { fakeApi, STUDIO_ID, StaffTestProviders } from "@/test-utils/staff";
import { FRONT_DESK_CARDS, INSTRUCTOR_CARDS, OWNER_CARDS } from "@/test-utils/pulseFixtures";

/*
  Reading-order guard: the order a screen reader walks each key screen (sign-in, Today, Studio view, Pulse, roster, client, More). It is what
  can be asserted without a device; the same screens are walked on a device by scripts/a11y-audit.js over the smoke dumps.
  A reorder, a lost heading or a control that stops being named fails here.
*/

jest.mock("expo-router", () => ({ router: { push: jest.fn() } }));
jest.mock("react-native-safe-area-context", () => {
  const { View } = jest.requireActual("react-native");
  return { SafeAreaView: View };
});
jest.mock("@/lib/features", () => ({ ...jest.requireActual("@/lib/features"), isStaffFeatureEnabled: () => true }));
jest.mock("@/lib/auth", () => ({ useAuth: () => ({ signInWithPassword: jest.fn(), sendSignInLink: jest.fn() }) }));
jest.setTimeout(30_000);

const order = () => spokenOrder(screen.toJSON() as unknown as RenderedNode | RenderedNode[] | null);
const flush = () => act(async () => undefined);

const ROW = { room: { id: "r", name: "Main Floor" }, locationName: null, client: { id: "c1", firstName: "Ana", lastName: "Rivera" }, partner: null, title: null };
const DAY: StaffToday = {
  studioId: STUDIO_ID,
  date: "2026-11-10",
  timeZone: "America/New_York",
  instructorId: "i1",
  appointments: [{ id: "a1", appointmentType: "private_lesson", status: "confirmed", startsAt: "2026-11-10T15:00:00Z", endsAt: "2026-11-10T15:45:00Z", ...ROW }],
};
const STUDIO_DAY: StaffStudioDay = {
  studioId: STUDIO_ID,
  date: "2026-11-10",
  timeZone: "America/New_York",
  truncated: false,
  appointments: [{ ...DAY.appointments[0], instructor: { id: "i1", firstName: "Ida", lastName: "Instructor" } }],
};
const PULSE: StaffPulse = {
  studioId: STUDIO_ID,
  timeZone: "America/New_York",
  date: "2026-11-10",
  asOf: "2026-11-10T15:00:00.000Z",
  scope: "studio",
  instructorId: null,
  today: { total: 5, upcoming: 4, cancelled: 1, truncated: false },
  next: { id: "a1", appointmentType: "private_lesson", title: null, status: "scheduled", startsAt: "2026-11-10T16:00:00.000Z", endsAt: "2026-11-10T16:45:00.000Z" },
  newClientsLast7Days: 3,
};
const CLASS = {
  ...DAY.appointments[0],
  id: "class-1",
  title: "Beginner Salsa",
  appointmentType: "group_class",
  status: "scheduled",
  client: null,
  studioId: STUDIO_ID,
  accessScope: "own-instructor",
  notes: null,
  instructor: { id: "i1", firstName: "Ida", lastName: "Instructor" },
  roster: { bookedCount: 2, capacity: 12, attendees: [{ clientId: "c1", name: "Ana Rivera", attendanceStatus: null }, { clientId: "c2", name: "Colin Marsh", attendanceStatus: "attended" }] },
  recap: null,
} as AppointmentDetail;
const CLIENT: ClientDetail = {
  id: "c1",
  firstName: "Ana",
  lastName: "Rivera",
  status: "active",
  timeZone: "America/New_York",
  activePackages: [{ id: "p1", name: "10 Private Lessons", expiresOn: "2027-01-31", items: [{ usageType: "private_lesson", remaining: 4, unlimited: false }] }],
  nextAppointment: { id: "a1", appointmentType: "private_lesson", title: null, startsAt: "2026-11-12T18:00:00.000Z", endsAt: "2026-11-12T18:45:00.000Z" },
};

async function show(node: React.ReactElement, api = fakeApi()) {
  render(<StaffTestProviders api={api}>{node}</StaffTestProviders>);
  await flush();
  await flush();
  return order();
}

describe("reading order of the key screens", () => {
  it("sign-in: identity, headline, the form top to bottom, the two ways in, then the footnote", () => {
    render(<SignInScreen />);
    const o = order();
    expect(o).toEqual(expect.arrayContaining(["Sign in to your studio"]));
    expect(inOrder(o, ["DanceFlow Business", "Sign in to your studio", "Email", "Password", "[Sign in]", "[Email me a sign-in link]", /Accounts are created by your studio/])).toBe(true);
  });

  it("Today: heading, date, day navigation, then the appointments with their time first", async () => {
    const o = await show(<TodayScreen />, fakeApi({ today: jest.fn(async () => DAY) }));
    expect(inOrder(o, ["Today", /November 10/, "[Previous day]", "[Next day]", "1 appointment", /^\[10:00 AM, 45 minutes\./])).toBe(true);
  });

  it("Studio view: heading, day navigation, the count, then each row naming who teaches it", async () => {
    const o = await show(<StudioScheduleScreen />, fakeApi({ studioSchedule: jest.fn(async () => STUDIO_DAY) }));
    expect(inOrder(o, ["Studio today", "[Previous day]", "[Next day]", "1 appointment", /^\[10:00 AM, 45 minutes\..*with Ida Instructor/])).toBe(true);
  });

  it("Pulse: heading, scope and date, the numbers, what is next (a button), then new clients", async () => {
    const o = await show(<PulseScreen />, fakeApi({ pulse: jest.fn(async () => PULSE) }));
    expect(inOrder(o, ["Pulse", /Studio today · /, "Today", "appointments: 5", "still to come: 4", "cancelled: 1", "Next up", /^\[Next up: Private lesson/, "Clients", "new in the last 7 days: 3"])).toBe(true);
  });

  it("Pulse cards (owner): what needs you first, then requests, leads, ARIA, worth a look, health, next up; each stat is one spoken item", async () => {
    const o = await show(<PulseScreen />, fakeApi({ pulse: jest.fn(async () => ({ ...PULSE, cards: OWNER_CARDS })) }));
    expect(
      inOrder(o, [
        "Pulse",
        "Needs you",
        "2 lesson requests waiting",
        "1 lead follow-up overdue",
        "1 lead not contacted yet",
        "1 ARIA suggestion to review",
        "Lesson requests",
        "requests waiting: 2",
        "New leads",
        "new leads in 7 days: 2",
        /^\[Priya Nair, Website, not contacted/,
        /^\[Marcus Webb, Instagram, follow-up overdue/,
        "ARIA suggestions",
        "Worth a look",
        "cancelled today: 1",
        "Studio health",
        "sessions today: 5",
        "Next up",
      ]),
    ).toBe(true);
  });

  it("Pulse cards (front desk): no ARIA anywhere, everything else in the same order", async () => {
    const fd = await show(<PulseScreen />, fakeApi({ pulse: jest.fn(async () => ({ ...PULSE, cards: FRONT_DESK_CARDS })) }));
    expect(fd.some((line) => /ARIA/.test(line))).toBe(false);
    expect(inOrder(fd, ["Needs you", "Lesson requests", "New leads", "Worth a look", "Studio health"])).toBe(true);
  });

  it("Pulse cards (instructor): own sessions, no leads, ARIA or package line", async () => {
    const ins = await show(<PulseScreen />, fakeApi({ pulse: jest.fn(async () => ({ ...PULSE, scope: "own" as const, instructorId: "ins-1", newClientsLast7Days: null, cards: INSTRUCTOR_CARDS })) }));
    expect(ins.some((line) => /New leads|ARIA|running low|request from /.test(line))).toBe(false);
    expect(inOrder(ins, ["Needs you", "Lesson requests", "Booking request", "Your sessions", "sessions today: 2"])).toBe(true);
  });

  it("class roster: the class, its details, the capacity, then each dancer followed by their own marks", async () => {
    const o = await show(<AppointmentScreen appointmentId="class-1" studioId={STUDIO_ID} />, fakeApi({ appointment: jest.fn(async () => CLASS), setAttendance: jest.fn() }));
    expect(
      inOrder(o, ["Group class", "Beginner Salsa", "Details", "Roster and attendance", "2 of 12 booked", "Attendance for Ana Rivera", "[Present, Ana Rivera]", "[No-show, Ana Rivera]", "Attendance for Colin Marsh", "[Present, Colin Marsh]"]),
    ).toBe(true);
  });

  it("client: name and status, then the next booking (a button), then each package read as one item", async () => {
    const o = await show(<ClientDetailScreen clientId="c1" studioId={STUDIO_ID} />, fakeApi({ client: jest.fn(async () => CLIENT) }));
    expect(inOrder(o, ["Ana Rivera", "Active", "Next booking", /^\[/, "Active packages", /^10 Private Lessons\. Private lesson: 4 remaining\. Expires /])).toBe(true);
  });

  it("More: the page, then who is signed in and the studio, with the sign-out actions after them", async () => {
    const o = await show(<MoreScreen />);
    const signOut = o.indexOf("[Sign out]");
    expect(inOrder(o, ["More", "Profile", "Your studio"])).toBe(true);
    expect(signOut).toBeGreaterThan(o.indexOf("Your studio"));
    expect(o.indexOf("[Sign out of all devices]")).toBeGreaterThan(signOut);
  });

  it("an error state reads as its heading, its words, then its one action", async () => {
    const o = await show(<PulseScreen />, fakeApi({ pulse: jest.fn(async () => Promise.reject(new StaffApiError(401, "unauthenticated", "x"))) }));
    expect(inOrder(o, ["Pulse", "Sign in again", /Your session has ended/, "[Sign in again]"])).toBe(true);
  });
});
