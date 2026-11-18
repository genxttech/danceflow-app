import { isPaymentCancelled, PAYMENT_CANCELLED_MESSAGE, PAYMENT_NOT_COMPLETED_MESSAGE, paymentSheetError } from "@/lib/paymentSheetOutcome";

describe("paymentSheetError", () => {
  it("keeps a cancel distinguishable from a failure", () => {
    const cancelled = paymentSheetError({ code: "Canceled", message: "x" });
    expect(isPaymentCancelled(cancelled)).toBe(true);
    expect(cancelled.message).toBe(PAYMENT_CANCELLED_MESSAGE);
  });

  it("a failure shows plain wording, never the sheet's own developer text", () => {
    expect(paymentSheetError({ code: "Failed", message: "Card declined. req_abc123" }).message).toBe(PAYMENT_NOT_COMPLETED_MESSAGE);
    expect(paymentSheetError({ code: "Failed" }).message).toBe(PAYMENT_NOT_COMPLETED_MESSAGE);
    expect(isPaymentCancelled(paymentSheetError(undefined))).toBe(false);
  });
});
