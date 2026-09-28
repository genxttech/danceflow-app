import { describe, expect, it } from "vitest";
import {
  buildPaymentDisputeOpenedStudioEmail,
  formatDisputeAmount,
  formatDisputeReason,
} from "@/lib/notifications/disputeEmails";

/** PAY-DC-2C: branded, minimal studio dispute notice. */

describe("buildPaymentDisputeOpenedStudioEmail", () => {
  const email = buildPaymentDisputeOpenedStudioEmail({
    studioName: "Harbor Dance Studio",
    studioLogoUrl: null,
    amountCents: 4500,
    currency: "usd",
    reason: "fraudulent",
    evidenceDueBy: new Date(Date.UTC(2027, 0, 15)),
  });

  it("renders the branded studio HTML with amount, reason and due date", () => {
    expect(email.subject).toBe("Payment dispute opened: $45.00");
    expect(email.bodyHtml).toContain("<html");
    expect(email.bodyHtml).toContain("Harbor Dance Studio");
    expect(email.bodyHtml).toContain("Payment dispute");
    expect(email.bodyHtml).toContain("$45.00");
    expect(email.bodyHtml).toContain("Fraudulent");
    expect(email.bodyHtml).toContain("January 15, 2027");
    expect(email.bodyText).toContain("Review and respond in your Stripe Dashboard");
  });

  it("contains no card, customer or Stripe identifiers", () => {
    const content = email.subject + email.bodyText + email.bodyHtml;
    expect(content).not.toMatch(/acct_|ch_|pi_|du_|@example|last4|cardholder/i);
  });

  it("formats unknown reasons and currencies safely", () => {
    expect(formatDisputeReason("something_new")).toBe("Other");
    expect(formatDisputeReason(null)).toBe("Not provided");
    expect(formatDisputeAmount(1234, "eur")).toContain("12.34");
  });
});
