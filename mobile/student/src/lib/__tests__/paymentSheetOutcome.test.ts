import { isPaymentCancelled, PAYMENT_CANCELLED_MESSAGE, paymentSheetError } from "@/lib/paymentSheetOutcome";

describe("paymentSheetError", () => {
  it("keeps a cancel distinguishable from a failure", () => {
    const cancelled = paymentSheetError({ code: "Canceled", message: "x" });
    expect(isPaymentCancelled(cancelled)).toBe(true);
    expect(cancelled.message).toBe(PAYMENT_CANCELLED_MESSAGE);
  });

  it("passes the sheet's own message for a failure, with a fallback", () => {
    expect(paymentSheetError({ code: "Failed", message: "Card declined." }).message).toBe("Card declined.");
    expect(paymentSheetError({ code: "Failed" }).message).toBe("Payment was not completed.");
    expect(isPaymentCancelled(paymentSheetError(undefined))).toBe(false);
  });
});
