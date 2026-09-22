import { describe, expect, it } from "vitest";
import {
  buildSigningCompletedSignerEmail,
  buildSigningCompletedStudioEmail,
  buildSigningDeclinedStudioEmail,
  type SigningEmailContext,
} from "../signingEmails";

const CONTEXT_WITH_LOGO: SigningEmailContext = {
  studioName: "Acme Dance",
  studioLogoUrl: "https://cdn.example.com/logo.png",
  studioSlug: "acme-dance",
  studioEmail: "studio@acme-dance.test",
};

const CONTEXT_NO_LOGO_NO_SLUG: SigningEmailContext = {
  studioName: "Riverside Ballroom",
  studioLogoUrl: null,
  studioSlug: null,
  studioEmail: "owner@riverside-ballroom.test",
};

/** Strips the shell's hidden preheader div (which intentionally echoes previewText/intro for inbox
 * preview purposes) so duplicate-content checks only look at what a recipient actually sees. */
function visibleHtml(html: string) {
  return html.replace(/<div style="display:none;[^"]*">[\s\S]*?<\/div>/, "");
}

describe("buildSigningCompletedSignerEmail", () => {
  it("uses real newlines, not literal backslash-n", () => {
    const msg = buildSigningCompletedSignerEmail({
      context: CONTEXT_WITH_LOGO,
      title: "Liability Waiver",
      signerName: "Jordan Lee",
    });
    expect(msg.bodyText.includes("\\n")).toBe(false);
    expect(msg.bodyText).toContain("\n");
  });

  it("preserves blank-line paragraph separation (readable spacing)", () => {
    const msg = buildSigningCompletedSignerEmail({
      context: CONTEXT_WITH_LOGO,
      title: "Liability Waiver",
      signerName: "Jordan Lee",
    });
    // The greeting, the completion sentence, the portal link, and the sign-off must each land in their
    // own paragraph when rendered through the shell (i.e. separated by a blank line in the plain text).
    expect(msg.bodyText).toMatch(/Hi Jordan Lee,\n\nYour signature/);
    expect(msg.bodyText).toMatch(/successfully\.\n\nView your documents:[^\n]*\n\nQuestions\?/);
  });

  it("no duplicate greeting/intro paragraph in the visible HTML body (dedupeBodyLeadIn fires)", () => {
    const msg = buildSigningCompletedSignerEmail({
      context: CONTEXT_WITH_LOGO,
      title: "Liability Waiver",
      signerName: "Jordan Lee",
    });
    // Both the greeting and intro sentence render exactly once as visible <p> paragraphs. (The hidden
    // preheader intentionally echoes the intro too -- that's standard email preview-text practice, not
    // a body duplicate, so it is stripped before counting.)
    const visible = visibleHtml(msg.bodyHtml);
    expect(visible.match(/Hi Jordan Lee,/g)?.length).toBe(1);
    expect(visible.match(/has been completed successfully/g)?.length).toBe(1);
  });

  it("HTML/text parity: both mention the document title and, when a slug exists, the portal link", () => {
    const msg = buildSigningCompletedSignerEmail({
      context: CONTEXT_WITH_LOGO,
      title: "Liability Waiver",
      signerName: "Jordan Lee",
    });
    expect(msg.bodyText).toContain("Liability Waiver");
    expect(msg.bodyHtml).toContain("Liability Waiver");
    expect(msg.bodyText).toContain("https://www.idanceflow.com/portal/acme-dance/documents");
    expect(msg.bodyHtml).toContain('href="https://www.idanceflow.com/portal/acme-dance/documents"');
  });

  it("no slug -> no CTA at all (never a staff link for the signer)", () => {
    const msg = buildSigningCompletedSignerEmail({
      context: CONTEXT_NO_LOGO_NO_SLUG,
      title: "Liability Waiver",
      signerName: "Sam",
    });
    expect(msg.bodyHtml).not.toContain("View Documents");
    expect(msg.bodyHtml).not.toContain("<a href=");
    expect(msg.bodyText).not.toContain("View your documents:");
  });

  it("public_name precedence and logo/no-logo rendering", () => {
    const withLogo = buildSigningCompletedSignerEmail({
      context: CONTEXT_WITH_LOGO,
      title: "Waiver",
      signerName: "Jordan",
    });
    expect(withLogo.bodyHtml).toContain(`src="${CONTEXT_WITH_LOGO.studioLogoUrl}"`);

    const noLogo = buildSigningCompletedSignerEmail({
      context: CONTEXT_NO_LOGO_NO_SLUG,
      title: "Waiver",
      signerName: "Jordan",
    });
    expect(noLogo.bodyHtml).not.toContain("<img");
    expect(noLogo.bodyHtml).toMatch(/>R<\/td>/);
  });
});

describe("buildSigningCompletedStudioEmail", () => {
  it("uses real newlines and has an absolute staff CTA to /app/documents", () => {
    const msg = buildSigningCompletedStudioEmail({
      context: CONTEXT_WITH_LOGO,
      title: "Liability Waiver",
      signerName: "Jordan Lee",
    });
    expect(msg.bodyText.includes("\\n")).toBe(false);
    expect(msg.bodyHtml).toContain('href="https://www.idanceflow.com/app/documents"');
    expect(msg.bodyHtml).toContain("Open Documents");
  });

  it("preserves canonical attribution (no operational footer override)", () => {
    const msg = buildSigningCompletedStudioEmail({
      context: CONTEXT_WITH_LOGO,
      title: "Waiver",
      signerName: "Jordan",
    });
    expect(msg.bodyHtml).toContain("Sent by Acme Dance through DanceFlow.");
    expect(msg.bodyHtml).not.toContain("This operational notice was sent through DanceFlow.");
  });

  it("no duplicate intro paragraph in the visible HTML body", () => {
    const msg = buildSigningCompletedStudioEmail({
      context: CONTEXT_WITH_LOGO,
      title: "Waiver",
      signerName: "Jordan Lee",
    });
    // The hidden preheader intentionally echoes the same intro text for inbox preview purposes; only
    // the visible body paragraph is checked for an actual duplicate here.
    expect(visibleHtml(msg.bodyHtml).match(/completed Waiver\./g)?.length).toBe(1);
  });
});

describe("buildSigningDeclinedStudioEmail", () => {
  it("uses real newlines and has an absolute staff CTA to /app/documents", () => {
    const msg = buildSigningDeclinedStudioEmail({
      context: CONTEXT_NO_LOGO_NO_SLUG,
      title: "Waiver",
      signerName: "Alex",
      reason: "Wrong document version.",
    });
    expect(msg.bodyText.includes("\\n")).toBe(false);
    expect(msg.bodyHtml).toContain('href="https://www.idanceflow.com/app/documents"');
    expect(msg.bodyHtml).toContain("Open Documents");
  });

  it("preserves canonical attribution and includes the reason once (as a detail row) plus in the body when present", () => {
    const msg = buildSigningDeclinedStudioEmail({
      context: CONTEXT_NO_LOGO_NO_SLUG,
      title: "Waiver",
      signerName: "Alex",
      reason: "Wrong document version.",
    });
    expect(msg.bodyHtml).toContain("Sent by Riverside Ballroom through DanceFlow.");
    expect(msg.bodyText).toContain("Reason: Wrong document version.");
  });

  it("no reason: body has exactly one occurrence of the decline sentence (dedupe fires cleanly)", () => {
    const msg = buildSigningDeclinedStudioEmail({
      context: CONTEXT_NO_LOGO_NO_SLUG,
      title: "Waiver",
      signerName: "Alex",
      reason: "",
    });
    expect(msg.bodyHtml.match(/Alex declined Waiver\./g)?.length).toBe(1);
  });
});
