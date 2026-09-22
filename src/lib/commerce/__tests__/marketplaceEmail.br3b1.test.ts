import { describe, expect, it } from "vitest";
import { buildMarketplacePurchaseEmail } from "@/lib/commerce/studentMarketplace";

describe("buildMarketplacePurchaseEmail", () => {
  it("uses public_name, the canonical /account URL, and the canonical attribution", () => {
    const msg = buildMarketplacePurchaseEmail({
      studio: { name: "Acme Dance LLC", public_name: "Acme Dance", public_logo_url: null },
      firstName: "Jamie",
      itemName: "Technique Masterclass",
      orderNumber: "ORD-1001",
      total: "$49.00",
    });
    expect(msg.subject).toBe("Your Technique Masterclass purchase is ready");
    expect(msg.bodyHtml).toContain("https://www.idanceflow.com/account");
    expect(msg.bodyHtml).toContain("Sent by Acme Dance through DanceFlow.");
    expect(msg.bodyHtml).not.toContain("Acme Dance LLC");
  });

  it("has no duplicate greeting paragraph in the HTML", () => {
    const msg = buildMarketplacePurchaseEmail({
      studio: { name: "Riverside Ballroom", public_name: null, public_logo_url: null },
      firstName: null,
      itemName: "Warm-Up Series",
      orderNumber: "ORD-2002",
      total: "$19.00",
    });
    // The greeting is rendered once by the shell's identity header, not again in the body.
    expect(msg.bodyHtml.match(/Hi there,/g)?.length).toBe(1);
    // The shell intro ("...is complete.") and the body's detail line ("purchase of X...is complete.")
    // are distinct sentences by design, so both may legitimately appear.
    expect(msg.bodyHtml).toContain("Your purchase from Riverside Ballroom is complete.");
    expect(msg.bodyHtml).toContain("Your purchase of Warm-Up Series from Riverside Ballroom is complete.");
  });

  it("HTML and text are both present", () => {
    const msg = buildMarketplacePurchaseEmail({
      studio: { name: "Riverside Ballroom", public_name: null, public_logo_url: null },
      firstName: "Jamie",
      itemName: "Warm-Up Series",
      orderNumber: "ORD-2002",
      total: "$19.00",
    });
    expect(msg.bodyText).toContain("ORD-2002");
    expect(msg.bodyHtml).toContain("<!doctype html>");
  });
});
