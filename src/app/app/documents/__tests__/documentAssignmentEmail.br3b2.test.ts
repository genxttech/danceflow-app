import { describe, expect, it } from "vitest";
import { buildDocumentAssignmentEmail } from "../documentAssignmentEmail";

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

describe("buildDocumentAssignmentEmail", () => {
  it("slug present -> a correct, absolute client documents URL as the CTA", () => {
    const msg = buildDocumentAssignmentEmail({
      studio: STUDIO_WITH_SLUG,
      clientName: "Riley Chen",
      documentTitle: "Liability Waiver",
      isReminder: false,
    });
    expect(msg.bodyHtml).toContain('href="https://www.idanceflow.com/portal/acme-dance/documents"');
    expect(msg.bodyHtml).toContain("Review and Sign");
    expect(msg.bodyText).toContain("https://www.idanceflow.com/portal/acme-dance/documents");
  });

  it("slug absent -> no CTA at all, and no client fallback to the staff /app URL", () => {
    const msg = buildDocumentAssignmentEmail({
      studio: STUDIO_NO_SLUG,
      clientName: "Riley",
      documentTitle: "Liability Waiver",
      isReminder: false,
    });
    expect(msg.bodyHtml).not.toContain("Review and Sign");
    expect(msg.bodyHtml).not.toMatch(/href="[^"]*\/app"/);
    expect(msg.bodyText).not.toMatch(/https:\/\/www\.idanceflow\.com\/app\b/);
  });

  it("slug absent -> never emits a malformed /portal//documents URL", () => {
    const msg = buildDocumentAssignmentEmail({
      studio: STUDIO_NO_SLUG,
      clientName: "Riley",
      documentTitle: "Liability Waiver",
      isReminder: true,
    });
    expect(msg.bodyHtml).not.toContain("/portal//documents");
    expect(msg.bodyText).not.toContain("/portal//documents");
  });

  it("slug absent -> body text still tells the recipient what happened and what to do next", () => {
    const msg = buildDocumentAssignmentEmail({
      studio: STUDIO_NO_SLUG,
      clientName: "Riley",
      documentTitle: "Liability Waiver",
      isReminder: false,
    });
    expect(msg.bodyText).toContain("Riverside Ballroom assigned Liability Waiver.");
    expect(msg.bodyText).toContain("Contact Riverside Ballroom for next steps");
  });

  it("reminder vs initial assignment produce distinct subjects and headings", () => {
    const initial = buildDocumentAssignmentEmail({
      studio: STUDIO_WITH_SLUG,
      clientName: "Riley",
      documentTitle: "Waiver",
      isReminder: false,
    });
    const reminder = buildDocumentAssignmentEmail({
      studio: STUDIO_WITH_SLUG,
      clientName: "Riley",
      documentTitle: "Waiver",
      isReminder: true,
    });
    expect(initial.subject).toBe("Acme Dance assigned a document for your review");
    expect(reminder.subject).toBe("Reminder: Waiver needs your signature");
    expect(initial.bodyHtml).toContain("A document is ready for review");
    expect(reminder.bodyHtml).toContain("Your signature is still needed");
  });

  it("uses resolveStudioDisplayName precedence (public_name over legal name)", () => {
    const msg = buildDocumentAssignmentEmail({
      studio: STUDIO_WITH_SLUG,
      clientName: "Riley",
      documentTitle: "Waiver",
      isReminder: false,
    });
    expect(msg.bodyHtml).toContain("Acme Dance");
    expect(msg.bodyHtml).not.toContain("Acme Dance LLC");
  });

  it("no duplicate greeting/intro in the visible HTML body (dedupeBodyLeadIn fires)", () => {
    const msg = buildDocumentAssignmentEmail({
      studio: STUDIO_WITH_SLUG,
      clientName: "Riley Chen",
      documentTitle: "Waiver",
      isReminder: false,
    });
    const visible = msg.bodyHtml.replace(/<div style="display:none;[^"]*">[\s\S]*?<\/div>/, "");
    expect(visible.match(/Riley Chen,/g)?.length).toBe(1);
    expect(visible.match(/assigned Waiver\./g)?.length).toBe(1);
  });
});
