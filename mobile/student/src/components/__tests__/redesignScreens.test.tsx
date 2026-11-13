import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";

const mockPush = jest.fn();
const mockSetFavorite = jest.fn();
const mockEvents = [
  { id: "e1", studioId: "s1", slug: "a", name: "Harvest Moon Social", eventType: "social", imageUrl: null, hostName: "Harbor Lights", categoryLabel: "Social", schedule: "Sat, Nov 14 · 7:30 PM", location: "Port Ellery", latitude: null, longitude: null, summary: null, beginnerFriendly: true, registrationRequired: true, favorited: false, webUrl: "" },
  { id: "e2", studioId: "s1", slug: "b", name: "Bachata Musicality", eventType: "workshop", imageUrl: "https://example.test/b.jpg", hostName: "Harbor Lights", categoryLabel: "Bachata", schedule: "Nov 21", location: "Port Ellery", latitude: null, longitude: null, summary: null, beginnerFriendly: false, registrationRequired: true, favorited: false, webUrl: "" },
  { id: "e3", studioId: "s2", slug: "c", name: "Swing Night", eventType: "social", imageUrl: null, hostName: "Copper Street", categoryLabel: "Swing", schedule: "Nov 22", location: "Port Ellery", latitude: null, longitude: null, summary: null, beginnerFriendly: true, registrationRequired: false, favorited: false, webUrl: "" },
  { id: "e4", studioId: "s2", slug: "d", name: "Fourth", eventType: null, imageUrl: null, hostName: "x", categoryLabel: null, schedule: "", location: "", latitude: null, longitude: null, summary: null, beginnerFriendly: false, registrationRequired: false, favorited: false, webUrl: "" }
];

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
jest.mock("expo-router", () => ({
  useRouter: () => ({ push: mockPush, back: jest.fn(), canGoBack: () => false }),
  useLocalSearchParams: () => ({ id: "e1" }),
  router: { push: mockPush },
  Link: ({ children }: { children: React.ReactNode }) => children
}));
let mockSession: { user: { id: string; email: string } } | null = { user: { id: "u1", email: "d@example.test" } };
jest.mock("@/lib/auth", () => ({ useAuth: () => ({ session: mockSession }) }));
jest.mock("@/lib/publicDiscovery", () => ({
  getPublicStudiosForMobile: jest.fn(async () => [{}, {}]),
  getPublicEventsForMobile: jest.fn(async () => mockEvents),
  getPublicPartnerProfilesForMobile: jest.fn(async () => [{}]),
  getPublicJobPostingsForMobile: jest.fn(async () => []),
  setPublicFavoriteForMobile: (...args: unknown[]) => mockSetFavorite(...args),
  getPublicEventDetailForMobile: jest.fn(async () => ({
    ...mockEvents[0],
    summary: "A relaxed Saturday social.",
    accountRequiredForRegistration: true,
    registrationOpensAt: null,
    registrationClosesAt: null,
    capacity: null,
    waitlistEnabled: false,
    registerUrl: "",
    requiredDocuments: [],
    ticketTypes: [
      { id: "t1", name: "General admission", description: null, price: 18, regularPrice: 22, currency: "USD", isEarlyBird: true, earlyBirdEndsAt: null, attendeesPerTicket: 1, remainingAdmissionSpots: null },
      { id: "t2", name: "Couple pass", description: null, price: 38, regularPrice: 38, currency: "USD", isEarlyBird: false, earlyBirdEndsAt: null, attendeesPerTicket: 2, remainingAdmissionSpots: 0 }
    ]
  }))
}));

// eslint-disable-next-line import/first
import { EventArt } from "@/components/EventArt";
// eslint-disable-next-line import/first
import DiscoverScreen from "../../../app/(tabs)/discover";
// eslint-disable-next-line import/first
import EventDetailScreen from "../../../app/events/[id]";

import { WARM_UP_TIMEOUT_MS, warmUpRenderer } from "@/test/warmUpRenderer";

// One-off renderer load, outside the tests' own timeouts (see warmUpRenderer).
beforeAll(warmUpRenderer, WARM_UP_TIMEOUT_MS);

beforeEach(() => {
  mockPush.mockClear();
  mockSetFavorite.mockReset();
  mockSetFavorite.mockImplementation(async ({ favorited }: { favorited: boolean }) => favorited);
  mockSession = { user: { id: "u1", email: "d@example.test" } };
});

describe("EventArt", () => {
  it("uses the event's own photo when there is one", () => {
    render(<EventArt height={100} imageUrl="https://example.test/p.jpg" labels={["Salsa"]} />);
    expect(screen.getByTestId("event-art-photo")).toBeTruthy();
    expect(screen.queryByTestId("event-art-fallback")).toBeNull();
  });

  it("falls back to brand art with the style's initials, hidden from screen readers", () => {
    render(<EventArt height={100} labels={["Salsa & Bachata"]} />);
    expect(screen.getByTestId("event-art-fallback")).toBeTruthy();
    expect(screen.queryByText("SB")).toBeNull(); // not exposed to assistive tech
    const initials = screen.getByText("SB", { includeHiddenElements: true });
    expect(initials.props.importantForAccessibility).toBe("no-hide-descendants");
  });
});

describe("Discover", () => {
  it("features the first event and two more, with labels that read the whole card", async () => {
    render(<DiscoverScreen />);
    const featured = await screen.findByTestId("discover-featured");
    expect(featured.props.accessibilityLabel).toBe("Harvest Moon Social. Sat, Nov 14 · 7:30 PM. Harbor Lights. Port Ellery");
    expect(screen.getByText("Bachata Musicality")).toBeTruthy();
    expect(screen.getByText("Swing Night")).toBeTruthy();
    expect(screen.queryByText("Fourth")).toBeNull();
    fireEvent.press(featured);
    expect(mockPush).toHaveBeenCalledWith("/events/e1");
  });

  it("keeps every category reachable, with counts", async () => {
    render(<DiscoverScreen />);
    await waitFor(() => expect(screen.getByTestId("discover-chip-events").props.accessibilityLabel).toBe("Events, 4"));
    for (const [key, href] of [["studios", "/discover/studios"], ["partners", "/partners"], ["jobs", "/jobs"], ["marketplace", "/discover/marketplace"]]) {
      fireEvent.press(screen.getByTestId(`discover-chip-${key}`));
      expect(mockPush).toHaveBeenLastCalledWith(href);
    }
    fireEvent.press(screen.getByTestId("discover-search"));
    expect(mockPush).toHaveBeenLastCalledWith("/discover/events");
  });

  it("saves an event from its heart, a labelled toggle that shows its state", async () => {
    render(<DiscoverScreen />);
    const heart = await screen.findByRole("togglebutton", { name: "Save Harvest Moon Social" });
    expect(heart.props.accessibilityState).toMatchObject({ checked: false });
    await act(async () => {
      fireEvent.press(heart);
    });
    expect(mockSetFavorite).toHaveBeenCalledWith({ favorited: true, targetId: "e1", targetType: "event", userId: "u1" });
    expect(screen.getByRole("togglebutton", { name: "Save Harvest Moon Social" }).props.accessibilityState).toMatchObject({ checked: true });
    expect(mockPush).not.toHaveBeenCalled(); // the heart is not the card's open button
  });

  it("puts the heart back and says so when saving fails", async () => {
    mockSetFavorite.mockRejectedValueOnce(new Error("offline"));
    render(<DiscoverScreen />);
    const heart = await screen.findByRole("togglebutton", { name: "Save Bachata Musicality" });
    await act(async () => {
      fireEvent.press(heart);
    });
    expect(screen.getByRole("togglebutton", { name: "Save Bachata Musicality" }).props.accessibilityState).toMatchObject({ checked: false });
    expect(screen.getByText("That event could not be saved. Try again.")).toBeTruthy();
  });

  it("sends a signed-out dancer to sign-in from the heart, and loads events with no user", async () => {
    const { getPublicEventsForMobile } = jest.requireMock("@/lib/publicDiscovery") as { getPublicEventsForMobile: jest.Mock };
    getPublicEventsForMobile.mockClear();
    mockSession = null;
    render(<DiscoverScreen />);
    fireEvent.press(await screen.findByRole("togglebutton", { name: "Save Harvest Moon Social" }));
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith("/(auth)/sign-in"));
    expect(mockSetFavorite).not.toHaveBeenCalled();
    expect(getPublicEventsForMobile).toHaveBeenCalledWith(null);
    // After signing in the dancer comes back to Discover.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { takePostSignInRoute } = require("@/lib/postSignInRoute") as typeof import("@/lib/postSignInRoute");
    await expect(takePostSignInRoute()).resolves.toBe("/(tabs)/discover");
  });

  describe("guest discovery", () => {
    beforeEach(() => {
      mockSession = null;
    });

    it("shows a guest the public events and studios, and says they are a guest", async () => {
      render(<DiscoverScreen />);
      expect(await screen.findByText("You are exploring as a guest")).toBeTruthy();
      expect(await screen.findByText("Harvest Moon Social")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Sign in or create account" })).toBeTruthy();
    });

    it("does not load partner or job listings for a guest, and shows no counts for them", async () => {
      const discovery = jest.requireMock("@/lib/publicDiscovery") as {
        getPublicPartnerProfilesForMobile: jest.Mock;
        getPublicJobPostingsForMobile: jest.Mock;
      };
      discovery.getPublicPartnerProfilesForMobile.mockClear();
      discovery.getPublicJobPostingsForMobile.mockClear();
      render(<DiscoverScreen />);
      await waitFor(() => expect(screen.getByTestId("discover-chip-events").props.accessibilityLabel).toBe("Events, 4"));
      expect(discovery.getPublicPartnerProfilesForMobile).not.toHaveBeenCalled();
      expect(discovery.getPublicJobPostingsForMobile).not.toHaveBeenCalled();
      expect(screen.getByTestId("discover-chip-partners").props.accessibilityLabel).toBe("Partners");
      expect(screen.getByTestId("discover-chip-jobs").props.accessibilityLabel).toBe("Jobs");
    });

    it("opens Events and Studios for a guest directly", async () => {
      render(<DiscoverScreen />);
      await waitFor(() => expect(screen.getByTestId("discover-chip-events").props.accessibilityLabel).toBe("Events, 4"));
      fireEvent.press(screen.getByTestId("discover-chip-events"));
      expect(mockPush).toHaveBeenCalledWith("/discover/events");
      fireEvent.press(screen.getByTestId("discover-chip-studios"));
      expect(mockPush).toHaveBeenCalledWith("/discover/studios");
    });

    it.each([
      ["partners", "/partners"],
      ["jobs", "/jobs"],
      ["marketplace", "/discover/marketplace"],
    ])("asks a guest to sign in before %s, and remembers where they were going", async (key, href) => {
      render(<DiscoverScreen />);
      await waitFor(() => expect(screen.getByTestId("discover-chip-events").props.accessibilityLabel).toBe("Events, 4"));
      fireEvent.press(screen.getByTestId(`discover-chip-${key}`));
      await waitFor(() => expect(mockPush).toHaveBeenCalledWith("/(auth)/sign-in"));
      expect(mockPush).not.toHaveBeenCalledWith(href);
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { takePostSignInRoute } = require("@/lib/postSignInRoute") as typeof import("@/lib/postSignInRoute");
      await expect(takePostSignInRoute()).resolves.toBe(href);
    });

    it("sends a guest to sign-in from the banner button", async () => {
      render(<DiscoverScreen />);
      fireEvent.press(await screen.findByRole("button", { name: "Sign in or create account" }));
      await waitFor(() => expect(mockPush).toHaveBeenCalledWith("/(auth)/sign-in"));
    });
  });
});

describe("Event detail", () => {
  it("shows the lowest available price in the bar and registers from it", async () => {
    render(<EventDetailScreen />);
    await screen.findByTestId("event-bar");
    expect(screen.getByLabelText("Tickets from $18.00")).toBeTruthy();
    expect(screen.getByText("Sold out")).toBeTruthy();
    fireEvent.press(screen.getByText("Register in app"));
    expect(mockPush).toHaveBeenCalledWith("/events/e1/register");
  });

  it("sends a signed-out dancer to sign-in and remembers the event to return to", async () => {
    mockSession = null;
    render(<EventDetailScreen />);
    const button = await screen.findByRole("button", { name: "Sign in to register" });
    fireEvent.press(button);
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith("/(auth)/sign-in"));
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { takePostSignInRoute } = require("@/lib/postSignInRoute") as typeof import("@/lib/postSignInRoute");
    await expect(takePostSignInRoute()).resolves.toBe("/events/e1");
  });

  it("has a labelled back button", async () => {
    render(<EventDetailScreen />);
    const back = await screen.findByTestId("event-back");
    expect(back.props.accessibilityLabel).toBe("Back");
    fireEvent.press(back);
    expect(mockPush).toHaveBeenCalledWith("/(tabs)/discover");
  });
});
