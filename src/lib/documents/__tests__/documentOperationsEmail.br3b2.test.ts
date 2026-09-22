import { describe, expect, it } from "vitest";
import { buildDocumentReminderEmail } from "../operations";

const STUDIO_WITH_SLUG = {
  name: "Acme Dance LLC",
  public_name: "Acme Dance",
  public_logo_url: "https://cdn.example.com/logo.png",
  slug: "acme-dance",
};
const STUDIO_NO_SLUG = {
  name: "Riverside Ballroom",
  public_name: null,
  public_logo_url: null,
  slug: null,
};

describe("buildDocumentReminderEmail", () => {
  it("slug present -> a correct, absolute client documents URL as the CTA (due-soon)", () => {
    const msg = buildDocumentReminderEmail({
      studio: STUDIO_WITH_SLUG,
      clientName: "Riley Chen",
      documentTitle: "Waiver",
      overdue: false,
    });
    expect(msg.bodyHtml).toContain('href="https://www.idanceflow.com/portal/acme-dance/documents"');
    expect(msg.bodyHtml).toContain("Open Documents");
    expect(msg.bodyText).toContain("https://www.idanceflow.com/portal/acme-dance/documents");
  });

  it("slug present -> a correct, absolute client documents URL as the CTA (overdue)", () => {
    const msg = buildDocumentReminderEmail({
      studio: STUDIO_WITH_SLUG,
      clientName: "Riley Chen",
      documentTitle: "Waiver",
      overdue: true,
    });
    expect(msg.bodyHtml).toContain('href="https://www.idanceflow.com/portal/acme-dance/documents"');
    expect(msg.subject).toBe("Past due: Waiver needs your signature");
  });

  it("slug absent -> no CTA at all, never a malformed /portal//documents URL", () => {
    const msg = buildDocumentReminderEmail({
      studio: STUDIO_NO_SLUG,
      clientName: "Riley",
      documentTitle: "Waiver",
      overdue: false,
    });
    expect(msg.bodyHtml).not.toContain("Open Documents");
    expect(msg.bodyHtml).not.toContain("/portal//documents");
    expect(msg.bodyText).not.toContain("/portal//documents");
    expect(msg.bodyText).not.toMatch(/https:\/\/www\.idanceflow\.com\/app\b/);
  });

  it("slug absent -> body text still tells the recipient what happened and what to do next", () => {
    const msg = buildDocumentReminderEmail({
      studio: STUDIO_NO_SLUG,
      clientName: "Riley",
      documentTitle: "Waiver",
      overdue: true,
    });
    expect(msg.bodyText).toContain("Riverside Ballroom is reminding you to review and sign Waiver.");
    expect(msg.bodyText).toContain("Contact Riverside Ballroom for next steps");
  });

  it("due-soon vs overdue produce distinct subjects and headings", () => {
    const dueSoon = buildDocumentReminderEmail({
      studio: STUDIO_WITH_SLUG,
      clientName: "Riley",
      documentTitle: "Waiver",
      overdue: false,
    });
    const overdue = buildDocumentReminderEmail({
      studio: STUDIO_WITH_SLUG,
      clientName: "Riley",
      documentTitle: "Waiver",
      overdue: true,
    });
    expect(dueSoon.subject).toBe("Reminder: Waiver is due soon");
    expect(overdue.subject).toBe("Past due: Waiver needs your signature");
    expect(dueSoon.bodyHtml).toContain("Your document is due soon");
    expect(overdue.bodyHtml).toContain("Your document is past due");
  });

  it("no duplicate greeting/intro in the visible HTML body (dedupeBodyLeadIn fires)", () => {
    const msg = buildDocumentReminderEmail({
      studio: STUDIO_WITH_SLUG,
      clientName: "Riley Chen",
      documentTitle: "Waiver",
      overdue: false,
    });
    const visible = msg.bodyHtml.replace(/<div style="display:none;[^"]*">[\s\S]*?<\/div>/, "");
    expect(visible.match(/Riley Chen,/g)?.length).toBe(1);
    expect(visible.match(/reminding you to review and sign Waiver\./g)?.length).toBe(1);
  });
});
