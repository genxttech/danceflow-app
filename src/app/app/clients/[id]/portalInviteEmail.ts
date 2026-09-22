/**
 * Pure builder for the client/instructor portal invite email content (BR-3B2). Kept in its own file,
 * with no "use server" directive, because `actions.ts` is a Server Actions module -- Next.js requires
 * every export from a "use server" file to be an async function, so this synchronous builder cannot live
 * there directly. No behavior differs from having it inline.
 */
import { renderStudioBrandedEmail } from "@/lib/notifications/email-branding";
import { sanitizeEmailSubject } from "@/lib/email/brand";

/** Pure builder: the client/instructor portal invite email content. */
export function buildPortalInviteEmail(params: {
  actionLink: string;
  clientName?: string | null;
  studioName?: string | null;
  studioLogoUrl?: string | null;
  isIndependentInstructor?: boolean;
}) {
  const greetingName = params.clientName?.trim() || "there";
  const studioName = params.studioName?.trim() || "your studio";
  const studioLogoUrl = params.studioLogoUrl?.trim() || "";
  const isIndependentInstructor = params.isIndependentInstructor === true;

  const portalRoleLabel = isIndependentInstructor
    ? "instructor portal"
    : "student portal";

  const portalDescription = isIndependentInstructor
    ? "view your schedule, manage floor-rental activity, and stay connected with the studio"
    : "view your lessons, packages, payments, and studio updates";

  const subject = sanitizeEmailSubject(
    `${studioName} invited you to join their DanceFlow ${
      isIndependentInstructor ? "instructor" : "student"
    } portal`,
  );

  const greeting = `Hi ${greetingName},`;
  const intro = `${studioName} invited you to access your DanceFlow ${portalRoleLabel}.`;

  const text = [
    greeting,
    "",
    intro,
    "",
    `Through your portal, you can ${portalDescription}.`,
    "",
    "Use this secure link to accept the invite and go directly to your portal:",
    params.actionLink,
    "",
    "If the button does not work, copy and paste the link above into your browser.",
    "",
    `This invite was sent by ${studioName} through DanceFlow.`,
  ].join("\n");

  // HTML-rendering body text only: the raw callback URL is omitted here (it is rendered separately via
  // `fallbackLinkText`, which gets a stronger word-break so the long magic-link URL cannot inflate the
  // email table's intrinsic width past the viewport). The plain-text `text` above is unaffected -- it
  // keeps the URL inline exactly as before.
  const htmlBodyText = [
    greeting,
    "",
    intro,
    "",
    `Through your portal, you can ${portalDescription}.`,
    "",
    "Use this secure link to accept the invite and go directly to your portal:",
    "",
    "If the button does not work, copy and paste the link above into your browser.",
    "",
    `This invite was sent by ${studioName} through DanceFlow.`,
  ].join("\n");

  const html = renderStudioBrandedEmail(
    {
      name: studioName,
      logoUrl: studioLogoUrl || null,
    },
    {
      previewText: subject,
      eyebrow: "Portal Invitation",
      heading: `${studioName} invited you to their ${portalRoleLabel}`,
      greeting,
      intro,
      bodyText: htmlBodyText,
      fallbackLinkText: params.actionLink,
      actionLabel: "Accept Invite",
      actionUrl: params.actionLink,
      footerText: `This invite was sent by ${studioName} through DanceFlow.`,
      dedupeBodyLeadIn: true,
    },
  );

  return { subject, bodyText: text, bodyHtml: html };
}
