import { initStripe } from "@stripe/stripe-react-native";

/*
  Event tickets are direct charges: the PaymentIntent lives on the studio's
  connected account (src/lib/events/event-order-payment.ts on the server), and
  the Stripe SDK can only read it when initialized with that account. The account
  differs per event, so it is applied per payment rather than on the root
  StripeProvider (whose effect re-runs only when its own props change).

  A server response without the account (a server older than this app) returns
  an error instead of presenting a sheet that would fail with "No such payment_intent".
*/

const ACCOUNT_ID = /^acct_[A-Za-z0-9]+$/;

type ConnectedPaymentResponse = {
  publishableKey?: string;
  stripeAccountId?: string;
};

export async function prepareConnectedPaymentSheet(
  response: ConnectedPaymentResponse,
): Promise<{ error?: { message: string } }> {
  const publishableKey =
    response.publishableKey || process.env.EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY || "";
  const stripeAccountId = response.stripeAccountId ?? "";

  if (!publishableKey || !ACCOUNT_ID.test(stripeAccountId)) {
    return { error: { message: "Payment could not be prepared." } };
  }

  await initStripe({ publishableKey, stripeAccountId, urlScheme: "danceflow" });

  return {};
}
