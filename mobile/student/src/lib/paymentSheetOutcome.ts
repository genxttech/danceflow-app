/*
  What the Stripe payment sheet reported, in words for a dancer. Cancelling the sheet is not a
  failure: nothing was charged and the order is still held, so it is shown as a notice with a way
  to try again, not as "Checkout needs attention".
*/

import { UserFacingError } from "@/lib/userFacingError";

export const PAYMENT_CANCELLED_MESSAGE =
  "Payment cancelled. You have not been charged. Continue to checkout when you are ready; your selection is saved.";

export const PAYMENT_NOT_COMPLETED_MESSAGE = "Your payment was not completed. Check your payment details or try another card, then try again.";

export class PaymentCancelledError extends UserFacingError {
  constructor() {
    super(PAYMENT_CANCELLED_MESSAGE);
    this.name = "PaymentCancelledError";
  }
}

export function isPaymentCancelled(error: unknown): error is PaymentCancelledError {
  return error instanceof PaymentCancelledError;
}

/** Converts the sheet's `error` into a thrown value: a cancel stays distinguishable from a failure. */
export function paymentSheetError(error: { code?: string; message?: string } | null | undefined): Error {
  if (error?.code === "Canceled") return new PaymentCancelledError();

  // The SDK's message is developer text (codes, request ids); the dancer gets plain wording instead.
  return new UserFacingError(PAYMENT_NOT_COMPLETED_MESSAGE);
}
