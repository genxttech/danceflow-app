import { fireEvent, render, screen } from "@testing-library/react-native";
import { WARM_UP_TIMEOUT_MS, warmUpRenderer } from "@/test/warmUpRenderer";

jest.mock("react-native-reanimated", () => ({ ...jest.requireActual("react-native-reanimated/mock"), useReducedMotion: () => false }));
jest.mock("@react-native-async-storage/async-storage", () =>
  jest.requireActual("@react-native-async-storage/async-storage/jest/async-storage-mock"),
);
jest.mock("@/lib/supabase", () => ({ supabase: {} }));
jest.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));
jest.mock("react-native-safe-area-context", () => {
  const { View } = jest.requireActual("react-native");
  return { SafeAreaView: View, useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) };
});
const mockPush = jest.fn();
jest.mock("expo-router", () => ({
  useRouter: () => ({ push: mockPush, back: jest.fn(), canGoBack: () => false }),
  Link: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock("@/lib/auth", () => ({ useAuth: () => ({ session: { user: { id: "u1", email: "d@example.test" } } }) }));
jest.mock("@/lib/studentAccess", () => ({ getStudentAccess: jest.fn(async () => ({ linkedStudios: [] })) }));
const mockWallet = jest.fn();
jest.mock("@/lib/studentWallet", () => ({
  loadStudentWallet: (...a: unknown[]) => mockWallet(...a),
  formatWalletDate: (value: string | null) => value ?? "Date coming soon",
}));

import ScheduleEventsScreen from "../../../app/schedule/events";

const reg = (id: string, extra: Record<string, unknown> = {}) => ({
  id, eventId: `event-${id}`, studioId: "s1", studioName: "QA Studio", hostName: "QA Studio", eventName: `Event ${id}`, eventSlug: `slug-${id}`,
  status: "confirmed", paymentStatus: "paid", quantity: 1, admits: 1, totalAmount: 25, eventDate: "2099-01-01", eventTime: "19:00", eventEndDate: "2099-01-01",
  eventEndTime: "22:00", eventTimeZone: "America/New_York", venue: "QA Ballroom", city: "Austin", state: "TX", ...extra,
});
const wallet = (registrations: unknown[], closedRegistrations: unknown[] = [], tickets: unknown[] = []) => ({
  digitalEntitlements: [], memberships: [], packages: [], paymentRequests: [], registrations, closedRegistrations, rewards: [], rewardProgress: [], tickets,
});
const pastReg = (n: number) => reg(`p${String(n).padStart(2, "0")}`, { eventDate: `2026-0${(n % 9) + 1}-15`, eventEndDate: `2026-0${(n % 9) + 1}-15`, eventName: `Past Event ${String(n).padStart(2, "0")}` });

beforeAll(warmUpRenderer, WARM_UP_TIMEOUT_MS);
beforeEach(() => {
  mockWallet.mockReset();
  mockPush.mockReset();
});

describe("Tickets & registrations: Past events section", () => {
  it("upcoming registrations stay as they were; ended ones are in a Past events section below, with their status wording", async () => {
    mockWallet.mockResolvedValue(wallet([reg("up1", { eventName: "Upcoming Social" }), reg("old1", { eventName: "Old Social", eventDate: "2026-01-10", eventEndDate: "2026-01-10" })]));
    render(<ScheduleEventsScreen />);
    expect(await screen.findByText("Upcoming Social")).toBeTruthy();
    expect(screen.getByText("Upcoming events")).toBeTruthy();
    expect(screen.getByText("Past events")).toBeTruthy();
    expect(screen.getByText("Old Social")).toBeTruthy();
    expect(screen.getAllByText("confirmed").length).toBe(2);
  });

  it("section titles are headings for a screen reader", async () => {
    mockWallet.mockResolvedValue(wallet([reg("up1"), reg("old1", { eventDate: "2026-01-10", eventEndDate: "2026-01-10" })]));
    render(<ScheduleEventsScreen />);
    expect(await screen.findByRole("header", { name: "Past events" })).toBeTruthy();
    expect(screen.getByRole("header", { name: "Upcoming events" })).toBeTruthy();
  });

  it("shows 12, then 'Show more' reveals the next page", async () => {
    mockWallet.mockResolvedValue(wallet(Array.from({ length: 15 }, (_, i) => pastReg(i + 1))));
    render(<ScheduleEventsScreen />);
    expect(await screen.findByText("Past events")).toBeTruthy();
    expect(screen.getAllByText(/^Past Event \d\d$/)).toHaveLength(12);
    const more = screen.getByRole("button", { name: "Show more past events, 3 remaining" });
    expect(screen.getByText("Show more (3 more)")).toBeTruthy();
    fireEvent.press(more);
    expect(screen.getAllByText(/^Past Event \d\d$/)).toHaveLength(15);
    expect(screen.queryByText(/^Show more/)).toBeNull();
  });

  it("exactly 12 past events: no Show more", async () => {
    mockWallet.mockResolvedValue(wallet(Array.from({ length: 12 }, (_, i) => pastReg(i + 1))));
    render(<ScheduleEventsScreen />);
    expect(await screen.findByText("Past events")).toBeTruthy();
    expect(screen.queryByText(/^Show more/)).toBeNull();
  });

  it("nothing past: no Past section at all; with no upcoming either, the upcoming empty state is unchanged", async () => {
    mockWallet.mockResolvedValue(wallet([]));
    render(<ScheduleEventsScreen />);
    expect(await screen.findByText("No upcoming events")).toBeTruthy();
    expect(screen.queryByText("Past events")).toBeNull();
  });

  it("only past registrations: 'No upcoming events' still shows above the history", async () => {
    mockWallet.mockResolvedValue(wallet([reg("old1", { eventName: "Old Social", eventDate: "2026-01-10", eventEndDate: "2026-01-10" })]));
    render(<ScheduleEventsScreen />);
    expect(await screen.findByText("Old Social")).toBeTruthy();
    expect(screen.getByText("No upcoming events")).toBeTruthy();
    expect(screen.getByText("Past events")).toBeTruthy();
  });

  it("a registration without a ticket shows as 'Registration'; one with tickets shows the count", async () => {
    mockWallet.mockResolvedValue(
      wallet(
        [reg("a", { eventName: "No Ticket Event", eventDate: "2026-02-01", eventEndDate: "2026-02-01" }), reg("b", { eventName: "Ticket Event", eventDate: "2026-02-02", eventEndDate: "2026-02-02" })],
        [],
        [{ id: "t1", registrationId: "b", checkedInAt: null }, { id: "t2", registrationId: "b", checkedInAt: null }],
      ),
    );
    render(<ScheduleEventsScreen />);
    expect(await screen.findByText("No Ticket Event")).toBeTruthy();
    expect(screen.getByText("Registration")).toBeTruthy();
    expect(screen.getByText("2 tickets")).toBeTruthy();
  });

  it("cancelled and refunded registrations of ended events show their own status wording", async () => {
    mockWallet.mockResolvedValue(
      wallet(
        [],
        [
          reg("c1", { eventName: "Cancelled Social", status: "cancelled", paymentStatus: "paid", eventDate: "2026-03-01", eventEndDate: "2026-03-01" }),
          reg("r1", { eventName: "Refunded Social", status: "cancelled", paymentStatus: "refunded", eventDate: "2026-03-02", eventEndDate: "2026-03-02" }),
        ],
      ),
    );
    render(<ScheduleEventsScreen />);
    expect(await screen.findByText("Cancelled Social")).toBeTruthy();
    expect(screen.getByText("cancelled")).toBeTruthy(); // status when paid
    expect(screen.getByText("refunded")).toBeTruthy(); // payment status wins when not paid, as before
  });

  it("an ended registration opens the event page (ended state, no checkout) when pressed", async () => {
    mockWallet.mockResolvedValue(wallet([reg("old1", { eventName: "Old Social", eventDate: "2026-01-10", eventEndDate: "2026-01-10" })]));
    render(<ScheduleEventsScreen />);
    fireEvent.press(await screen.findByText("Old Social"));
    expect(mockPush).toHaveBeenCalledWith("/events/event-old1");
  });
});
