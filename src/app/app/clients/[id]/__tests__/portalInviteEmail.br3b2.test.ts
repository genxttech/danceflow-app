import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildPortalInviteEmail } from "../portalInviteEmail";
import { normalizeEmail, resolveOutboundFromEmail } from "@/lib/notifications/outbound";

function visibleHtml(html: string) {
  return html.replace(/<div style="display:none;[^"]*">[\s\S]*?<\/div>/, "");
}

describe("buildPortalInviteEmail", () => {
  it("sanitizes the subject (no CR/LF) and distinguishes instructor vs student portals", () => {
    const student = buildPortalInviteEmail({
      actionLink: "https://www.idanceflow.com/callback?token_hash=abc&type=magiclink&next=%2Fstudio-invites%2Ftok",
      clientName: "Riley Chen",
      studioName: "Acme Dance",
      studioLogoUrl: null,
    });
    expect(student.subject).toBe("Acme Dance invited you to join their DanceFlow student portal");
    expect(student.subject.includes("\n")).toBe(false);
    expect(student.subject.includes("\r")).toBe(false);

    const instructor = buildPortalInviteEmail({
      actionLink: "https://www.idanceflow.com/callback?token_hash=abc&type=magiclink&next=%2Fstudio-invites%2Ftok",
      clientName: "Sam",
      studioName: "Acme Dance",
      studioLogoUrl: null,
      isIndependentInstructor: true,
    });
    expect(instructor.subject).toBe("Acme Dance invited you to join their DanceFlow instructor portal");
  });

  it("no duplicate greeting/intro in the visible HTML body (dedupeBodyLeadIn fires)", () => {
    const msg = buildPortalInviteEmail({
      actionLink: "https://www.idanceflow.com/callback?token_hash=abc&type=magiclink&next=%2Fstudio-invites%2Ftok",
      clientName: "Riley Chen",
      studioName: "Acme Dance",
      studioLogoUrl: "https://cdn.example.com/logo.png",
    });
    const visible = visibleHtml(msg.bodyHtml);
    expect(visible.match(/Hi Riley Chen,/g)?.length).toBe(1);
    expect(visible.match(/invited you to access your DanceFlow student portal/g)?.length).toBe(1);
  });

  it("HTML/text parity: both carry the exact action link", () => {
    const actionLink = "https://www.idanceflow.com/callback?token_hash=abc123&type=magiclink&next=%2Fstudio-invites%2Ftok_xyz";
    const msg = buildPortalInviteEmail({
      actionLink,
      clientName: "Riley",
      studioName: "Acme Dance",
      studioLogoUrl: null,
    });
    expect(msg.bodyText).toContain(actionLink);
    // The HTML attribute is (correctly) HTML-escaped, so `&` becomes `&amp;` in the rendered href.
    expect(msg.bodyHtml).toContain(`href="${actionLink.replaceAll("&", "&amp;")}"`);
  });

  it("logo/no-logo rendering", () => {
    const withLogo = buildPortalInviteEmail({
      actionLink: "https://www.idanceflow.com/callback",
      studioName: "Acme Dance",
      studioLogoUrl: "https://cdn.example.com/logo.png",
    });
    expect(withLogo.bodyHtml).toContain('src="https://cdn.example.com/logo.png"');

    const noLogo = buildPortalInviteEmail({
      actionLink: "https://www.idanceflow.com/callback",
      studioName: "Riverside Ballroom",
      studioLogoUrl: null,
    });
    expect(noLogo.bodyHtml).not.toContain("<img");
    expect(noLogo.bodyHtml).toMatch(/>R<\/td>/);
  });
});

describe("fallback-link overflow fix (BR-3B2 owner-QA Option B revision)", () => {
  const actionLink =
    "https://www.idanceflow.com/callback?token_hash=proof_hash_abc&type=magiclink&next=%2Fstudio-invites%2Fproof-token-abc";

  it("the callback URL appears exactly twice in the HTML -- once as the CTA href, once as the visible fallback text -- and never as a third, redundant copy inside normal body prose", () => {
    const msg = buildPortalInviteEmail({
      actionLink,
      clientName: "Riley Chen",
      studioName: "Acme Dance",
      studioLogoUrl: null,
    });
    const escaped = "token_hash=proof_hash_abc&amp;type=magiclink";
    const pattern = new RegExp(escaped.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
    expect(msg.bodyHtml.match(pattern)?.length).toBe(2);
    // Exactly one of those two occurrences is the href attribute; the other is the fallback-link paragraph.
    expect(msg.bodyHtml.match(new RegExp(`href="[^"]*${escaped.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^"]*"`, "g"))?.length).toBe(1);
    expect(
      msg.bodyHtml.match(
        new RegExp(`word-break:break-all;overflow-wrap:break-word;">[^<]*${escaped.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "g"),
      )?.length,
    ).toBe(1);
    // It must not also appear inside a normal (non-fallback) body paragraph -- that was the original bug.
    expect(
      msg.bodyHtml.match(
        new RegExp(`overflow-wrap:break-word;word-wrap:break-word;">[^<]*${escaped.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "g"),
      ),
    ).toBeNull();
  });

  it("the CTA href remains exactly the action link, unchanged", () => {
    const msg = buildPortalInviteEmail({
      actionLink,
      clientName: "Riley Chen",
      studioName: "Acme Dance",
      studioLogoUrl: null,
    });
    expect(msg.bodyHtml).toContain(`href="${actionLink.replaceAll("&", "&amp;")}"`);
    expect(msg.bodyHtml).toContain(">Accept Invite<");
  });

  it("the fallback link renders with word-break:break-all, scoped only to that element", () => {
    const msg = buildPortalInviteEmail({
      actionLink,
      clientName: "Riley Chen",
      studioName: "Acme Dance",
      studioLogoUrl: null,
    });
    expect(msg.bodyHtml).toMatch(
      new RegExp(`word-break:break-all;overflow-wrap:break-word;">${actionLink.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replaceAll("&", "&amp;")}</p>`),
    );
    expect(msg.bodyHtml.match(/word-break:break-all/g)?.length).toBe(1);
  });

  it("the fallback visible text is the exact, unmodified action link (no zero-width characters, no mutation)", () => {
    const msg = buildPortalInviteEmail({
      actionLink,
      clientName: "Riley Chen",
      studioName: "Acme Dance",
      studioLogoUrl: null,
    });
    const match = msg.bodyHtml.match(/word-break:break-all;overflow-wrap:break-word;">([^<]*)<\/p>/);
    expect(match?.[1]).toBe(actionLink.replaceAll("&", "&amp;"));
  });

  it("the plain-text email is byte-identical to the expected pre-change output (URL still inline)", () => {
    const msg = buildPortalInviteEmail({
      actionLink,
      clientName: "Riley Chen",
      studioName: "Acme Dance",
      studioLogoUrl: null,
    });
    const expectedText = [
      "Hi Riley Chen,",
      "",
      "Acme Dance invited you to access your DanceFlow student portal.",
      "",
      "Through your portal, you can view your lessons, packages, payments, and studio updates.",
      "",
      "Use this secure link to accept the invite and go directly to your portal:",
      actionLink,
      "",
      "If the button does not work, copy and paste the link above into your browser.",
      "",
      "This invite was sent by Acme Dance through DanceFlow.",
    ].join("\n");
    expect(msg.bodyText).toBe(expectedText);
  });

  it("token/auth query parameters remain intact in both the fallback text and the CTA href", () => {
    const msg = buildPortalInviteEmail({
      actionLink,
      clientName: "Riley Chen",
      studioName: "Acme Dance",
      studioLogoUrl: null,
    });
    expect(msg.bodyText).toContain("token_hash=proof_hash_abc");
    expect(msg.bodyText).toContain("type=magiclink");
    expect(msg.bodyText).toContain("next=%2Fstudio-invites%2Fproof-token-abc");
    expect(msg.bodyHtml).toContain("token_hash=proof_hash_abc");
    expect(msg.bodyHtml).toContain("type=magiclink");
    expect(msg.bodyHtml).toContain("next=%2Fstudio-invites%2Fproof-token-abc");
  });
});

describe("portal invite Reply-To resolution", () => {
  it("a valid studio email normalizes to itself", () => {
    expect(normalizeEmail("owner@acme-dance.test")).toBe("owner@acme-dance.test");
    expect(normalizeEmail("  Owner@Acme-Dance.TEST  ")).toBe("owner@acme-dance.test");
  });

  it("a missing/invalid studio email normalizes to null (Reply-To omitted, not fabricated)", () => {
    expect(normalizeEmail(null)).toBeNull();
    expect(normalizeEmail("")).toBeNull();
    expect(normalizeEmail("not-an-email")).toBeNull();
  });
});

describe("From value characterization (shared resolver, behavior-preserving)", () => {
  const originalNotificationFrom = process.env.NOTIFICATION_FROM_EMAIL;
  const originalOutboundFrom = process.env.OUTBOUND_EMAIL_FROM;

  it("preserves the exact existing fallback precedence", () => {
    delete process.env.NOTIFICATION_FROM_EMAIL;
    delete process.env.OUTBOUND_EMAIL_FROM;
    expect(resolveOutboundFromEmail()).toBe("DanceFlow <notify@idanceflow.com>");

    process.env.OUTBOUND_EMAIL_FROM = "Studio Relay <relay@example.test>";
    expect(resolveOutboundFromEmail()).toBe("Studio Relay <relay@example.test>");

    process.env.NOTIFICATION_FROM_EMAIL = "Primary <primary@example.test>";
    expect(resolveOutboundFromEmail()).toBe("Primary <primary@example.test>");

    if (originalNotificationFrom === undefined) delete process.env.NOTIFICATION_FROM_EMAIL;
    else process.env.NOTIFICATION_FROM_EMAIL = originalNotificationFrom;
    if (originalOutboundFrom === undefined) delete process.env.OUTBOUND_EMAIL_FROM;
    else process.env.OUTBOUND_EMAIL_FROM = originalOutboundFrom;
  });
});

describe("magic-link/token semantics characterization (source-level, read-only)", () => {
  const source = readFileSync(
    join(process.cwd(), "src/app/app/clients/[id]/actions.ts"),
    "utf8",
  );

  it("still hashes/validates the client-invitation token via the lifecycle module, untouched", () => {
    expect(source).toContain("createOrRefreshClientInvitation");
    expect(source).toContain("lifecycleInvite.token");
    expect(source).toContain("client_account_invite_token");
  });

  it("still generates a Supabase magic link and embeds its token_hash, untouched", () => {
    expect(source).toContain('type: "magiclink"');
    expect(source).toContain("adminSupabase.auth.admin.generateLink");
    expect(source).toContain("magicLinkData.properties?.hashed_token");
    expect(source).toContain("token_hash=");
    expect(source).toContain("type=magiclink");
  });

  it("the auth callback/redirect origin still uses getBaseUrl, not the canonical buildAppUrl helper", () => {
    // Deliberate: the magic-link redirect must resolve to whatever origin this request's Supabase
    // session actually validates against, not the canonical marketing/email origin -- canonicalizing
    // it could send the browser to a different environment/Supabase project than the one that issued
    // the token. Only the plain, non-auth portal link is canonicalized via buildAppUrl.
    expect(source).toContain("const baseUrl = await getBaseUrl();");
    expect(source).toContain("const portalUrl = buildAppUrl(portalPath);");
    expect(source).toMatch(/redirectTo = `\$\{baseUrl\}\/callback\?next=/);
    expect(source).toMatch(/actionLink = tokenHash\s*\n\s*\? `\$\{baseUrl\}\/callback\?token_hash=/);
  });
});
