import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
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
  useLocalSearchParams: () => ({ id: "e1" }),
  router: { push: mockPush },
}));
jest.mock("@stripe/stripe-react-native", () => ({ useStripe: () => ({ initPaymentSheet: jest.fn(), presentPaymentSheet: jest.fn() }) }));
jest.mock("@/lib/stripeConnect", () => ({ prepareConnectedPaymentSheet: jest.fn(async () => ({})) }));
let mockSession: { user: { id: string; email: string } } | null = { user: { id: "u1", email: "d@example.test" } };
jest.mock("@/lib/auth", () => ({ useAuth: () => ({ session: mockSession }) }));

const mockEvents = jest.fn();
const mockDetail = jest.fn();
jest.mock("@/lib/publicDiscovery", () => ({
  getPublicEventsForMobile: (...a: unknown[]) => mockEvents(...a),
  getPublicEventDetailForMobile: (...a: unknown[]) => mockDetail(...a),
  setPublicFavoriteForMobile: jest.fn(),
}));

const base = {
  id: "e1", studioId: "s1", slug: "qa", name: "Summer Social", eventType: "social", imageUrl: null, hostName: "QA Dance Studio", categoryLabel: "Social",
  schedule: "Jun 14 · 7:00 PM", location: "Austin", latitude: null, longitude: null, summary: "A relaxed social.", beginnerFriendly: true,
  registrationRequired: true, favorited: false, webUrl: "", accountRequiredForRegistration: false, registrationOpensAt: null, registrationClosesAt: null,
  capacity: null, waitlistEnabled: false, registerUrl: "", requiredDocuments: [],
  ticketTypes: [{ id: "t1", name: "General admission", description: null, price: 18, regularPrice: 18, currency: "USD", isEarlyBird: false, earlyBirdEndsAt: null, attendeesPerTicket: 1, remainingAdmissionSpots: null, active: true }],
};

import { EventSearchScreen } from "@/components/EventSearchScreen";
import EventDetailScreen from "../../../app/events/[id]";
import EventRegisterScreen from "../../../app/events/[id]/register";

beforeAll(warmUpRenderer, WARM_UP_TIMEOUT_MS);
beforeEach(() => {
  mockEvents.mockReset();
  mockDetail.mockReset();
  mockPush.mockReset();
  mockSession = { user: { id: "u1", email: "d@example.test" } };
});

describe("Events list when nothing is upcoming (PROD today)", () => {
  it("reads as a normal state with a hint, not a failure", async () => {
    mockEvents.mockResolvedValue([]);
    render(<EventSearchScreen />);
    expect(await screen.findByText("No upcoming events")).toBeTruthy();
    expect(screen.getByText(/Check back soon/i)).toBeTruthy();
    expect(screen.queryByText(/need attention/i)).toBeNull();
    expect(screen.queryByText("No events found")).toBeNull();
    expect(mockEvents).toHaveBeenCalledWith("u1", { scope: "upcoming" });
  });

  it("a search with no match on a non-empty list keeps the 'No events found' wording", async () => {
    mockEvents.mockResolvedValue([{ ...base, ended: false }]);
    render(<EventSearchScreen />);
    expect(await screen.findByText("Summer Social")).toBeTruthy();
    fireEvent.changeText(screen.getByPlaceholderText(/search/i), "zzzz-nothing");
    expect(await screen.findByText("No events found")).toBeTruthy();
  });
});

describe("Past events toggle", () => {
  it("is an accessible two-option control (role tab, selected state, 44dp tall) and loads the past list on demand", async () => {
    mockEvents.mockImplementation(async (_user: unknown, options?: { scope?: string }) => (options?.scope === "past" ? [{ ...base, ended: true }] : []));
    render(<EventSearchScreen />);
    expect(await screen.findByText("No upcoming events")).toBeTruthy();

    const upcoming = screen.getByRole("tab", { name: "Show upcoming events" });
    const past = screen.getByRole("tab", { name: "Show past events" });
    expect(upcoming.props.accessibilityState).toMatchObject({ selected: true });
    expect(past.props.accessibilityState).toMatchObject({ selected: false });
    expect(JSON.stringify(past.props.style)).toContain('"minHeight":44');

    fireEvent.press(past);
    expect(await screen.findByText("Summer Social")).toBeTruthy();
    expect(mockEvents).toHaveBeenLastCalledWith("u1", { scope: "past" });
    expect(screen.getByRole("tab", { name: "Show past events" }).props.accessibilityState).toMatchObject({ selected: true });
  });

  it("the Past list keeps newest-ended-first (not alphabetical)", async () => {
    mockEvents.mockImplementation(async (_user: unknown, options?: { scope?: string }) =>
      options?.scope === "past"
        ? [
            { ...base, id: "p1", name: "Zumba Last Night", ended: true },
            { ...base, id: "p2", name: "Mambo Last Month", ended: true },
            { ...base, id: "p3", name: "Argentine Tango Last Year", ended: true },
          ]
        : [],
    );
    render(<EventSearchScreen />);
    fireEvent.press(await screen.findByRole("tab", { name: "Show past events" }));
    await screen.findByText("Zumba Last Night");
    const titles = screen.getAllByText(/Last (Night|Month|Year)$/).map((node) => node.props.children as string);
    expect(titles).toEqual(["Zumba Last Night", "Mambo Last Month", "Argentine Tango Last Year"]);
  });

  it("an empty past list says so in plain words", async () => {
    mockEvents.mockResolvedValue([]);
    render(<EventSearchScreen />);
    fireEvent.press(await screen.findByRole("tab", { name: "Show past events" }));
    expect(await screen.findByText("No past events")).toBeTruthy();
  });
});

describe("an ended event opened by id or direct link", () => {
  it("detail loads, says the event has ended, and offers no registration", async () => {
    mockDetail.mockResolvedValue({ ...base, ended: true });
    render(<EventDetailScreen />);
    expect(await screen.findByText("Summer Social")).toBeTruthy();
    expect(screen.getAllByText("This event has ended").length).toBeGreaterThan(0);
    expect(screen.queryByText("Register in app")).toBeNull();
    expect(screen.queryByText("Sign in to register")).toBeNull();
    expect(screen.queryByText("General admission")).toBeNull();
    const cta = screen.getByRole("button", { name: "This event has ended" });
    expect(cta.props.accessibilityState).toMatchObject({ disabled: true });
    fireEvent.press(cta);
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("signed out, an ended event does not push the visitor to sign in to register", async () => {
    mockSession = null;
    mockDetail.mockResolvedValue({ ...base, ended: true });
    render(<EventDetailScreen />);
    expect(await screen.findByText("Summer Social")).toBeTruthy();
    expect(screen.queryByText("Sign in to register")).toBeNull();
  });

  it("an upcoming event still shows tickets and the register action", async () => {
    mockDetail.mockResolvedValue({ ...base, ended: false });
    render(<EventDetailScreen />);
    expect(await screen.findByText("General admission")).toBeTruthy();
    expect(screen.getByText("Register in app")).toBeTruthy();
    expect(screen.queryByText("This event has ended")).toBeNull();
  });

  it("a stale link straight to the register form shows the ended state instead of checkout", async () => {
    mockDetail.mockResolvedValue({ ...base, ended: true });
    render(<EventRegisterScreen />);
    expect(await screen.findByText("This event has ended")).toBeTruthy();
    expect(screen.queryByText("Event Registration")).toBeNull();
    fireEvent.press(screen.getByRole("button", { name: "Back to events" }));
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith("/discover/events"));
  });
});
