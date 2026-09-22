import { describe, expect, it } from "vitest";
import { buildAccountantDeliveryEmail } from "@/lib/accountant-deliveries/deliveryEmail";

describe("buildAccountantDeliveryEmail", () => {
  it("uses the canonical URL, footerNote for the expiry, and the canonical attribution", () => {
    const msg = buildAccountantDeliveryEmail({
      studio: { name: "Acme Dance", logoUrl: "https://cdn.example.com/logo.png" },
      accountantName: "Taylor Reyes",
      link: "https://www.idanceflow.com/accountant-delivery/tok_abc123",
    });
    expect(msg.subject).toBe("Secure accounting reports from Acme Dance");
    expect(msg.bodyHtml).toContain('href="https://www.idanceflow.com/accountant-delivery/tok_abc123"');
    expect(msg.bodyHtml).toContain("This secure link expires in 7 days.");
    expect(msg.bodyHtml).toContain("Sent by Acme Dance through DanceFlow.");
  });

  it("has no duplicate greeting/intro paragraph in the HTML", () => {
    const msg = buildAccountantDeliveryEmail({
      studio: { name: "Riverside Ballroom", logoUrl: null },
      accountantName: "Taylor Reyes",
      link: "https://www.idanceflow.com/accountant-delivery/tok_xyz789",
    });
    expect(msg.bodyHtml.match(/Hi Taylor Reyes,/g)?.length).toBe(1);
    expect(msg.bodyHtml.match(/prepared a secure accounting report package/g)?.length).toBe(1);
  });

  it("HTML and text are both present, and the link is not forwarded/repeated oddly", () => {
    const msg = buildAccountantDeliveryEmail({
      studio: { name: "Riverside Ballroom", logoUrl: null },
      accountantName: "Taylor Reyes",
      link: "https://www.idanceflow.com/accountant-delivery/tok_xyz789",
    });
    expect(msg.bodyText).toContain("do not forward this link");
    expect(msg.bodyHtml).toContain("<!doctype html>");
  });
});
