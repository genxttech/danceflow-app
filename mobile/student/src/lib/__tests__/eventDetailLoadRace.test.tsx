import { render, screen, waitFor } from "@testing-library/react-native";
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
jest.mock("expo-router", () => ({
  useRouter: () => ({ push: jest.fn(), back: jest.fn(), canGoBack: () => false }),
  useLocalSearchParams: () => ({ id: "e1" }),
  router: { push: jest.fn() },
}));

let mockSession: { user: { id: string; email: string } } | null = null;
jest.mock("@/lib/auth", () => ({ useAuth: () => ({ session: mockSession }) }));

const mockDetail = jest.fn();
jest.mock("@/lib/publicDiscovery", () => ({
  getPublicEventDetailForMobile: (...a: unknown[]) => mockDetail(...a),
}));

const detail = {
  id: "e1", studioId: "s1", slug: "qa", name: "QA Social Dance Night", eventType: "social", imageUrl: null, hostName: "QA Dance Studio",
  categoryLabel: "Social", schedule: "Dec 1", location: "Austin", latitude: null, longitude: null, summary: "A relaxed social.",
  beginnerFriendly: true, registrationRequired: true, favorited: false, webUrl: "", accountRequiredForRegistration: true,
  registrationOpensAt: null, registrationClosesAt: null, capacity: null, waitlistEnabled: false, registerUrl: "", requiredDocuments: [],
  ticketTypes: [{ id: "t1", name: "General admission", description: null, price: 18, regularPrice: 18, currency: "USD", isEarlyBird: false, earlyBirdEndsAt: null, attendeesPerTicket: 1, remainingAdmissionSpots: null }],
};

import EventDetailScreen from "../../../app/events/[id]";

beforeAll(warmUpRenderer, WARM_UP_TIMEOUT_MS);
beforeEach(() => {
  mockDetail.mockReset();
  mockSession = null;
});

describe("Event detail load right after a sign-in deep link", () => {
  it("one quiet automatic retry: a first transient failure does not show Event unavailable", async () => {
    mockDetail.mockRejectedValueOnce(new Error("Network request failed"));
    mockDetail.mockResolvedValueOnce(detail);
    render(<EventDetailScreen />);
    expect(await screen.findByText("QA Social Dance Night", {}, { timeout: 8000 })).toBeTruthy();
    expect(screen.queryByText("Event unavailable")).toBeNull();
    expect(mockDetail).toHaveBeenCalledTimes(2);
  });

  it("an error from the load before the session arrived is cleared when the signed-in load succeeds", async () => {
    // First load (no session) fails twice (initial + the automatic retry), so the error state shows.
    mockDetail.mockRejectedValueOnce(new Error("401"));
    mockDetail.mockRejectedValueOnce(new Error("401"));
    const view = render(<EventDetailScreen />);
    expect(await screen.findByText("Event unavailable", {}, { timeout: 8000 })).toBeTruthy();

    // The session arrives (sign-in finishes): the reload succeeds and must replace the stale error.
    mockSession = { user: { id: "u1", email: "d@example.test" } };
    mockDetail.mockResolvedValue(detail);
    view.rerender(<EventDetailScreen />);
    expect(await screen.findByText("QA Social Dance Night", {}, { timeout: 8000 })).toBeTruthy();
    expect(screen.queryByText("Event unavailable")).toBeNull();
  });

  it("a persistent failure still ends in the error state, with Try again, after exactly one automatic retry", async () => {
    mockDetail.mockRejectedValue(new Error("down"));
    render(<EventDetailScreen />);
    expect(await screen.findByText("Event unavailable", {}, { timeout: 8000 })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    await waitFor(() => expect(mockDetail).toHaveBeenCalledTimes(2));
  });
});
