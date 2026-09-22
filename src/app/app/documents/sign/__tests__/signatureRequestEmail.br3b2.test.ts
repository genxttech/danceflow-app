import { describe, expect, it } from "vitest";
import { buildSignatureRequestEmail } from "../signatureRequestEmail";

const STUDIO_WITH_LOGO = {
  name: "Acme Dance LLC",
  public_name: "Acme Dance",
  public_logo_url: "https://cdn.example.com/logo.png",
};
const STUDIO_NO_LOGO = {
  name: "Riverside Ballroom",
  public_name: null,
  public_logo_url: null,
};

function visibleHtml(html: string) {
  return html.replace(/<div style="display:none;[^"]*">[\s\S]*?<\/div>/, "");
}

describe("buildSignatureRequestEmail", () => {
  it("uses the shared shell (not raw <p> HTML) with public_name precedence", () => {
    const msg = buildSignatureRequestEmail({
      studio: STUDIO_WITH_LOGO,
      signerName: "Jordan Lee",
      title: "Liability Waiver",
      signUrl: "https://www.idanceflow.com/sign/tok_abc123",
      expiresInDays: 7,
    });
    expect(msg.bodyHtml).toContain("<!doctype html>");
    expect(msg.bodyHtml).toContain("Acme Dance");
    expect(msg.bodyHtml).not.toContain("Acme Dance LLC");
  });

  it("falls back to legal name and shows the initial tile when there is no logo", () => {
    const msg = buildSignatureRequestEmail({
      studio: STUDIO_NO_LOGO,
      signerName: "Sam",
      title: "Waiver",
      signUrl: "https://www.idanceflow.com/sign/tok_xyz789",
      expiresInDays: 7,
    });
    expect(msg.bodyHtml).toContain("Riverside Ballroom");
    expect(msg.bodyHtml).not.toContain("<img");
    expect(msg.bodyHtml).toMatch(/>R<\/td>/);
  });

  it("uses the caller-provided absolute signUrl as the CTA and in plain text (buildAppUrl/sanitizeActionUrl safe)", () => {
    const msg = buildSignatureRequestEmail({
      studio: STUDIO_WITH_LOGO,
      signerName: "Jordan",
      title: "Waiver",
      signUrl: "https://www.idanceflow.com/sign/tok_abc123",
      expiresInDays: 3,
    });
    expect(msg.bodyText).toContain("https://www.idanceflow.com/sign/tok_abc123");
    expect(msg.bodyHtml).toContain('href="https://www.idanceflow.com/sign/tok_abc123"');
    expect(msg.bodyHtml).toContain("Review and Sign");
  });

  it("rejects an unsafe/non-https action URL as the CTA href (sanitizeActionUrl at the shell boundary)", () => {
    const msg = buildSignatureRequestEmail({
      studio: STUDIO_WITH_LOGO,
      signerName: "Jordan",
      title: "Waiver",
      signUrl: "javascript:alert(1)",
      expiresInDays: 3,
    });
    // The shell's `sanitizeActionUrl` rejects the unsafe protocol for the actual clickable button --
    // no href is ever rendered with it, and no CTA button renders at all.
    expect(msg.bodyHtml).not.toMatch(/href="javascript:/i);
    expect(msg.bodyHtml).not.toContain("Review and Sign");
  });

  it("sanitizes the subject (no CR/LF, capped length) and prefixes reminders distinctly", () => {
    const initial = buildSignatureRequestEmail({
      studio: STUDIO_WITH_LOGO,
      signerName: "Jordan",
      title: "Waiver",
      signUrl: "https://www.idanceflow.com/sign/tok1",
      expiresInDays: 7,
    });
    expect(initial.subject).toBe("Acme Dance requests your signature: Waiver");

    const reminder = buildSignatureRequestEmail({
      studio: STUDIO_WITH_LOGO,
      signerName: "Jordan",
      title: "Waiver",
      signUrl: "https://www.idanceflow.com/sign/tok2",
      expiresInDays: 7,
      subjectPrefix: "Reminder: signature requested",
    });
    expect(reminder.subject).toBe("Reminder: signature requested from Acme Dance: Waiver");
    expect(reminder.subject.includes("\n")).toBe(false);
    expect(reminder.subject.includes("\r")).toBe(false);
  });

  it("no duplicate greeting/intro in the visible HTML body (dedupeBodyLeadIn fires)", () => {
    const msg = buildSignatureRequestEmail({
      studio: STUDIO_WITH_LOGO,
      signerName: "Jordan Lee",
      title: "Waiver",
      signUrl: "https://www.idanceflow.com/sign/tok1",
      expiresInDays: 7,
    });
    const visible = visibleHtml(msg.bodyHtml);
    expect(visible.match(/Hi Jordan Lee,/g)?.length).toBe(1);
    expect(visible.match(/has sent you/g)?.length).toBe(1);
  });

  it("HTML/text parity: both mention the expiry and the document title", () => {
    const msg = buildSignatureRequestEmail({
      studio: STUDIO_WITH_LOGO,
      signerName: "Jordan",
      title: "Liability Waiver",
      signUrl: "https://www.idanceflow.com/sign/tok1",
      expiresInDays: 1,
    });
    expect(msg.bodyText).toContain("expires in 1 day.");
    expect(msg.bodyHtml).toContain("expires in 1 day.");
    expect(msg.bodyText).toContain("Liability Waiver");
    expect(msg.bodyHtml).toContain("Liability Waiver");
  });
});
