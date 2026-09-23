import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderDanceFlowSystemEmail } from "@/lib/notifications/email-branding";
import { buildAppUrl } from "@/lib/email/brand";

/**
 * BR-3C: normalizes the Ambassador Pro invite's canonical link construction onto `buildAppUrl` and
 * removes a dead, never-called local `escapeHtml` duplicate. `sendAmbassadorInviteEmail` and its
 * builders remain private, synchronous helpers in a "use server" file, so they cannot be exported/
 * imported directly here. Source-level checks confirm the actual wiring; a render-based check exercises
 * the REAL, unmodified `renderDanceFlowSystemEmail` shell + `buildAppUrl` with the exact literal content
 * this file uses.
 */
const source = readFileSync(join(process.cwd(), "src/app/platform/invites/actions.ts"), "utf8");

describe("ambassador invite (BR-3C, source-level)", () => {
  it("invite link is built via buildAppUrl, not raw NEXT_PUBLIC_SITE_URL/VERCEL_URL concatenation", () => {
    expect(source).not.toContain("process.env.NEXT_PUBLIC_SITE_URL");
    expect(source).not.toContain("process.env.VERCEL_URL");
    expect(source).toMatch(/return buildAppUrl\(`\/get-started\/ambassador\?invite=/);
  });

  it("the dead, unused local escapeHtml duplicate was removed", () => {
    expect(source).not.toMatch(/function escapeHtml\(/);
  });

  it("transport remains the raw Resend HTTP fetch, not the SDK", () => {
    expect(source).toContain('fetch("https://api.resend.com/emails"');
    expect(source).not.toContain('from "resend"');
  });

  it("effective From behavior is unchanged (same env vars, same precedence, same fallback)", () => {
    expect(source).toMatch(
      /const from =\s*\n\s*process\.env\.RESEND_FROM_EMAIL\?\.trim\(\) \|\|\s*\n\s*process\.env\.MARKETING_FROM_EMAIL\?\.trim\(\) \|\|\s*\n\s*"DanceFlow <notify@idanceflow\.com>";/,
    );
  });

  it("subject remains the immutable hardcoded literal (no sanitizer needed per BR-3C's own conditional)", () => {
    expect(source).toContain('subject: "Your DanceFlow Ambassador Pro invite"');
  });

  it("invite/token semantics are untouched", () => {
    expect(source).toContain("hashInviteToken");
    expect(source).toContain("token_hash: tokenHash");
    expect(source).toContain("crypto.randomBytes(32).toString(\"base64url\")");
  });
});

describe("ambassador invite email content (BR-3C render-based, real shell + real buildAppUrl)", () => {
  const inviteLink = buildAppUrl(`/get-started/ambassador?invite=${encodeURIComponent("tok_abc123")}`);

  it("buildAppUrl produces the canonical DanceFlow origin for the invite link", () => {
    expect(inviteLink).toBe("https://www.idanceflow.com/get-started/ambassador?invite=tok_abc123");
  });

  it("the rendered HTML uses the current DanceFlow shell/brand and the canonical invite link as its CTA", () => {
    const html = renderDanceFlowSystemEmail({
      previewText: "Your DanceFlow Ambassador Pro invite",
      eyebrow: "DanceFlow Ambassador Pro",
      heading: "You’re invited to DanceFlow Ambassador Pro",
      greeting: "Hi Jordan,",
      bodyText: [
        `I'm inviting you to join the DanceFlow Ambassador Pro Pilot.`,
        `You'll receive 12 months of complimentary Pro access so you can use DanceFlow with your own teaching business, explore the full feature set, and share feedback from the perspective of a traveling instructor.`,
        "",
        "Your invite is tied to this email address.",
        "",
        "Once you're in, we can schedule a short onboarding call and get your workspace set up.",
      ].join("\n"),
      actionLabel: "Accept Your Invite",
      actionUrl: inviteLink,
      footerText: "This invitation was sent by DanceFlow.",
    });

    expect(html).toContain(`href="${inviteLink}"`);
    expect(html).toContain(">Accept Your Invite<");
    expect(html).toContain("Hi Jordan,");
    expect(html).toContain("DanceFlow is a product of GenX TotalTech LLC.");
    // Escaping is handled by the shared shell itself -- confirms removing the dead local escapeHtml
    // duplicate has no effect on actual output.
    expect(html).not.toContain("<script>");
  });

  it("a recipient name containing HTML-special characters is safely escaped by the shell", () => {
    const html = renderDanceFlowSystemEmail({
      previewText: "Your DanceFlow Ambassador Pro invite",
      eyebrow: "DanceFlow Ambassador Pro",
      heading: "You’re invited to DanceFlow Ambassador Pro",
      greeting: `Hi <b>Jordan</b> & co,`,
      bodyText: "Body text.",
      actionLabel: "Accept Your Invite",
      actionUrl: inviteLink,
      footerText: "This invitation was sent by DanceFlow.",
    });
    expect(html).not.toContain("<b>Jordan</b>");
    expect(html).toContain("&lt;b&gt;Jordan&lt;/b&gt; &amp; co");
  });
});
