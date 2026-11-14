/*
  The registration screen's payment states against a mocked Stripe sheet. A real sheet needs a
  Stripe TEST publishable key and a connected account, which this environment does not have; this
  proves everything up to that boundary: cancel, decline, retry with the same idempotency key, and
  the return to Wallet.
*/
jest.mock("@react-native-async-storage/async-storage", () =>
  jest.requireActual("@react-native-async-storage/async-storage/jest/async-storage-mock"),
);

import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { WARM_UP_TIMEOUT_MS, warmUpRenderer } from "@/test/warmUpRenderer";

const mockSheet = { initPaymentSheet: jest.fn(), presentPaymentSheet: jest.fn() };
const mockRouter = { replace: jest.fn(), push: jest.fn() };

jest.mock("expo-router", () => ({
  useLocalSearchParams: () => ({ id: "ev1" }),
  useRouter: () => mockRouter,
}));
jest.mock("@stripe/stripe-react-native", () => ({ useStripe: () => mockSheet }));
jest.mock("@/lib/auth", () => ({ useAuth: () => ({ session: { user: { id: "u1", email: "d@example.test" } } }) }));
jest.mock("@/components/Screen", () => ({ Screen: ({ children }: { children: React.ReactNode }) => children }));
jest.mock("@/lib/stripeConnect", () => ({ prepareConnectedPaymentSheet: jest.fn(async () => ({})) }));
jest.mock("@/lib/publicDiscovery", () => ({
  getPublicEventDetailForMobile: jest.fn(async () => ({
    id: "ev1",
    name: "Spring Social",
    requiredDocuments: [],
    ticketTypes: [
      {
        id: "tt1", name: "General", description: null, ticketKind: "general", price: 20, priceCents: 2000,
        regularPrice: 20, currency: "USD", capacity: null, remainingAdmissionSpots: null, active: true,
        saleStartsAt: null, saleEndsAt: null, isEarlyBird: false, earlyBirdEndsAt: null, attendeesPerTicket: 1,
      },
    ],
  })),
}));
jest.mock("@/lib/eventCheckout", () => ({
  ...jest.requireActual("@/lib/eventCheckout"),
  createStudentEventCheckout: jest.fn(),
  confirmStudentEventOrder: jest.fn(async () => ({})),
  getStudentEventOrderStatus: jest.fn(async () => ({ ticketsReady: true, paymentStatus: "paid" })),
}));

import RegisterScreen from "../../../app/events/[id]/register";
import { createStudentEventCheckout, confirmStudentEventOrder } from "@/lib/eventCheckout";

const create = createStudentEventCheckout as jest.Mock;
const CONTINUE = "Continue to secure checkout";

beforeAll(warmUpRenderer, WARM_UP_TIMEOUT_MS);
beforeEach(() => {
  jest.clearAllMocks();
  process.env.EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY = "pk_test_mock";
  create.mockResolvedValue({ orderId: "o1", clientSecret: "cs_mock", registrationIds: [] });
  mockSheet.initPaymentSheet.mockResolvedValue({});
});

async function fillAndContinue() {
  render(<RegisterScreen />);
  await screen.findByText("Spring Social");
  fireEvent.changeText(screen.getByPlaceholderText("Quantity"), "1");
  fireEvent.changeText(screen.getByPlaceholderText("First name"), "Dana");
  fireEvent.changeText(screen.getByPlaceholderText("Last name"), "Dancer");
  fireEvent.press(screen.getByText(CONTINUE));
}

describe("event registration payment states", () => {
  it("treats cancelling the sheet as a notice, keeps the attempt, and retries the same order key", async () => {
    mockSheet.presentPaymentSheet.mockResolvedValueOnce({ error: { code: "Canceled", message: "canceled" } });
    await fillAndContinue();

    await waitFor(() => expect(screen.getByText(/Payment cancelled\. You have not been charged/)).toBeTruthy());
    expect(screen.queryByText("Checkout needs attention")).toBeNull();
    expect(mockRouter.replace).not.toHaveBeenCalled();

    mockSheet.presentPaymentSheet.mockResolvedValueOnce({});
    await waitFor(() => expect(screen.getByText(CONTINUE)).toBeTruthy());
    fireEvent.press(screen.getByText(CONTINUE));

    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalled());
    const [first, second] = create.mock.calls.map((call) => call[0].clientRequestId);
    expect(first).toBeTruthy();
    expect(second).toBe(first);
    expect(confirmStudentEventOrder).toHaveBeenCalledWith("o1");
    expect(mockRouter.replace).toHaveBeenCalledWith({
      pathname: "/wallet",
      params: { checkout: "event", orderId: "o1" },
    });
  });

  it("shows a declined payment as an error that needs attention, and does not leave for Wallet", async () => {
    mockSheet.presentPaymentSheet.mockResolvedValueOnce({ error: { code: "Failed", message: "Your card was declined." } });
    await fillAndContinue();

    await waitFor(() => expect(screen.getByText("Checkout needs attention")).toBeTruthy());
    expect(screen.getByText("Your card was declined.")).toBeTruthy();
    expect(mockRouter.replace).not.toHaveBeenCalled();
    expect(confirmStudentEventOrder).not.toHaveBeenCalled();
  });

  it("goes to Wallet after payment even when ticket confirmation fails (the webhook finishes it)", async () => {
    mockSheet.presentPaymentSheet.mockResolvedValueOnce({});
    (confirmStudentEventOrder as jest.Mock).mockRejectedValueOnce(new Error("timeout"));
    await fillAndContinue();

    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalled(), { timeout: 5000 });
  });

  it("surfaces a checkout that could not be created without opening the sheet", async () => {
    create.mockRejectedValueOnce(new Error("Tickets are sold out."));
    await fillAndContinue();

    await waitFor(() => expect(screen.getByText("Tickets are sold out.")).toBeTruthy());
    expect(mockSheet.presentPaymentSheet).not.toHaveBeenCalled();
  });
});
