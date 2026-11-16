import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { AppState, Linking } from "react-native";
import PaymentRequestsScreen from "../../../app/wallet/payment-requests";
import { WARM_UP_TIMEOUT_MS, warmUpRenderer } from "@/test/warmUpRenderer";

jest.mock("@react-native-async-storage/async-storage", () =>
  jest.requireActual("@react-native-async-storage/async-storage/jest/async-storage-mock"),
);
jest.mock("expo-router", () => ({ router: { push: jest.fn() }, useRouter: () => ({ push: jest.fn() }) }));
jest.mock("@/lib/auth", () => ({ useAuth: () => ({ session: { user: { id: "u1", email: "d@example.test" } } }) }));
jest.mock("@/lib/studentAccess", () => ({
  getStudentAccess: jest.fn(async () => ({ linkedStudios: [{ clientId: "c1", studioId: "s1", studioName: "Studio" }] })),
}));
const mockLoadWallet = jest.fn();
jest.mock("@/lib/studentWallet", () => ({
  formatCurrency: (n: number) => `$${n}`,
  formatWalletDate: () => "Nov 1",
  loadStudentWallet: (...args: unknown[]) => mockLoadWallet(...args),
}));

const request = (id: string) => ({
  id,
  amount: 40,
  studioName: "Studio",
  paymentType: "lesson",
  notes: null,
  createdAt: "2026-11-01",
  checkoutUrl: `https://pay.example.test/${id}`,
});

const appState: { listener?: (state: string) => void } = {};

beforeAll(warmUpRenderer, WARM_UP_TIMEOUT_MS);
beforeEach(() => {
  appState.listener = undefined;
  jest.spyOn(AppState, "addEventListener").mockImplementation(((_: string, cb: (s: string) => void) => {
    appState.listener = cb;
    return { remove: jest.fn() };
  }) as never);
  mockLoadWallet.mockReset().mockResolvedValue({ paymentRequests: [request("p1")] });
});
afterEach(() => jest.restoreAllMocks());

describe("Pay Now (payment happens in the browser)", () => {
  it("re-reads the requests when the dancer returns, so a paid request is gone", async () => {
    jest.spyOn(Linking, "openURL").mockResolvedValue(undefined);
    render(<PaymentRequestsScreen />);
    fireEvent.press(await screen.findByText("Pay Now"));
    expect(Linking.openURL).toHaveBeenCalledWith("https://pay.example.test/p1");

    mockLoadWallet.mockResolvedValue({ paymentRequests: [] }); // paid while away
    await act(async () => {
      appState.listener?.("active");
    });
    await waitFor(() => expect(screen.queryByText("Pay Now")).toBeNull());
    expect(screen.getByText("Payment requests are up to date.")).toBeTruthy();
    expect(mockLoadWallet).toHaveBeenCalledTimes(2);
  });

  it("opens only the request that was pressed, never another request's page", async () => {
    mockLoadWallet.mockResolvedValue({ paymentRequests: [request("p1"), request("p2")] });
    const open = jest.spyOn(Linking, "openURL").mockResolvedValue(undefined);
    render(<PaymentRequestsScreen />);
    const buttons = await screen.findAllByText("Pay Now");
    expect(buttons).toHaveLength(2);
    fireEvent.press(buttons[1]);
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith("https://pay.example.test/p2");
  });

  it("does not refetch on foregrounding when no payment was started", async () => {
    render(<PaymentRequestsScreen />);
    await screen.findByText("Pay Now");
    await act(async () => {
      appState.listener?.("active");
    });
    expect(mockLoadWallet).toHaveBeenCalledTimes(1);
  });

  it("says so when the payment page cannot be opened, and does not wait for a return", async () => {
    jest.spyOn(Linking, "openURL").mockRejectedValue(new Error("no browser"));
    render(<PaymentRequestsScreen />);
    fireEvent.press(await screen.findByText("Pay Now"));
    expect(await screen.findByText("We could not open the payment page. Try again in a moment.")).toBeTruthy();
    await act(async () => {
      appState.listener?.("active");
    });
    expect(mockLoadWallet).toHaveBeenCalledTimes(1);
  });
});
