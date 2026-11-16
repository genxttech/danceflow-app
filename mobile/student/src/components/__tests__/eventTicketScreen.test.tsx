import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import EventTicketsScreen from "../../../app/wallet/event-tickets";
import { WARM_UP_TIMEOUT_MS, warmUpRenderer } from "@/test/warmUpRenderer";

jest.mock("@react-native-async-storage/async-storage", () =>
  jest.requireActual("@react-native-async-storage/async-storage/jest/async-storage-mock"),
);
jest.mock("expo-router", () => ({ router: { push: jest.fn(), back: jest.fn() }, useFocusEffect: jest.fn() }));
jest.mock("@/lib/supabase", () => ({ supabase: {} }));
jest.mock("@/lib/auth", () => ({ useAuth: () => ({ session: { user: { id: "u1", email: "dana@example.test" } } }) }));
jest.mock("@/lib/studentAccess", () => ({ getStudentAccess: async () => ({ linkedStudios: [] }) }));

const mockLoad = jest.fn();
jest.mock("@/lib/studentWallet", () => ({ ...jest.requireActual("@/lib/studentWallet"), loadStudentWallet: (...a: unknown[]) => mockLoad(...a) }));

const ticket = {
  id: "t1", registrationId: "r1", eventId: "e1", studioId: "s1", studioName: "QA Dance Studio", hostName: "QA Dance Studio",
  eventName: "QA Social Dance Night", eventSlug: "qa", ticketName: "General Admission", attendeeName: "Dana Dancer", paymentState: "paid",
  admitPosition: 1, admitTotal: 1, ticketCode: "QA-DANA-0001", qrImageUrl: "https://example.test/api/tickets/qr?code=QA-DANA-0001",
  checkedInAt: null, waiverSignedAt: null, eventDate: "2026-12-01", eventTime: "19:00", venue: "QA Ballroom", city: "Austin", state: "TX",
};

beforeAll(warmUpRenderer, WARM_UP_TIMEOUT_MS);
beforeEach(() => mockLoad.mockReset());

describe("Wallet ticket screen, for a screen reader", () => {
  it("is one stop per ticket, named with the event, holder and the code spelled out; the QR image is not a second unnamed stop", async () => {
    mockLoad.mockResolvedValue({ tickets: [ticket], registrations: [] });
    render(<EventTicketsScreen />);
    const pass = await screen.findByTestId("ticket-pass");
    expect(pass.props.accessible).toBe(true);
    const label = pass.props.accessibilityLabel as string;
    expect(label).toContain("QA Social Dance Night");
    expect(label).toContain("Dana Dancer");
    expect(label).toContain("Q A - D A N A - 0 0 0 1");
    // The QR image sits inside the accessible pass, so a screen reader reads the pass once, not an unnamed image.
    expect(screen.getByTestId("ticket-qr")).toBeTruthy();
  });

  it("has a screen heading", async () => {
    mockLoad.mockResolvedValue({ tickets: [], registrations: [] });
    render(<EventTicketsScreen />);
    expect(await screen.findByRole("header", { name: "Your tickets" })).toBeTruthy();
  });

  it("a failed load is an alert with Try again, and Try again reloads", async () => {
    mockLoad.mockRejectedValueOnce(new Error("Network request failed"));
    mockLoad.mockResolvedValueOnce({ tickets: [ticket], registrations: [] });
    render(<EventTicketsScreen />);
    const retry = await screen.findByRole("button", { name: "Try again" });
    expect(screen.getByTestId("error-state-unknown").props.accessibilityRole).toBe("alert");
    fireEvent.press(retry);
    await waitFor(() => expect(screen.getByTestId("ticket-pass")).toBeTruthy());
    expect(mockLoad).toHaveBeenCalledTimes(2);
  });
});
