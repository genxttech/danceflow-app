import { initStripe } from "@stripe/stripe-react-native";
import { prepareConnectedPaymentSheet } from "@/lib/stripeConnect";

jest.mock("@stripe/stripe-react-native", () => ({ initStripe: jest.fn(async () => undefined) }));

const mockInit = initStripe as jest.Mock;

describe("prepareConnectedPaymentSheet", () => {
  it("initializes Stripe with the connected account that owns the PaymentIntent", async () => {
    await expect(
      prepareConnectedPaymentSheet({ publishableKey: "pk_test_server", stripeAccountId: "acct_1Abc" }),
    ).resolves.toEqual({});

    expect(mockInit).toHaveBeenCalledWith({
      publishableKey: "pk_test_server",
      stripeAccountId: "acct_1Abc",
      urlScheme: "danceflow",
    });
  });

  it("switches account for the next studio's event", async () => {
    await prepareConnectedPaymentSheet({ publishableKey: "pk_test_server", stripeAccountId: "acct_1" });
    await prepareConnectedPaymentSheet({ publishableKey: "pk_test_server", stripeAccountId: "acct_2" });

    expect(mockInit).toHaveBeenLastCalledWith(expect.objectContaining({ stripeAccountId: "acct_2" }));
  });

  it("falls back to the app's key when the server sends none", async () => {
    await prepareConnectedPaymentSheet({ stripeAccountId: "acct_1Abc" });

    expect(mockInit).toHaveBeenCalledWith(expect.objectContaining({ publishableKey: "pk_test_env" }));
  });

  it.each([{}, { stripeAccountId: "" }, { stripeAccountId: "not-an-account" }])(
    "returns an error and never initializes for a response of %j",
    async (response) => {
      await expect(
        prepareConnectedPaymentSheet({ publishableKey: "pk_test_server", ...response }),
      ).resolves.toEqual({ error: { message: "Payment could not be prepared." } });

      expect(mockInit).not.toHaveBeenCalled();
    },
  );
});
