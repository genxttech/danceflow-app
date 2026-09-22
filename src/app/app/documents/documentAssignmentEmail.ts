/**
 * Pure builder for the document assignment / manual-reminder email (BR-3B2). Kept in its own file, with
 * no "use server" directive, because `actions.ts` is a Server Actions module -- Next.js requires every
 * export from a "use server" file to be an async function, so this synchronous builder cannot live there
 * directly. No behavior differs from having it inline.
 */
import { renderStudioBrandedEmail } from "@/lib/notifications/email-branding";
import { buildAppUrl, resolveStudioDisplayName, sanitizeEmailSubject } from "@/lib/email/brand";

/** Pure builder: the document assignment / manual-reminder email sent to a client. */
export function buildDocumentAssignmentEmail(params: {
  studio: { public_name?: string | null; name?: string | null; public_logo_url?: string | null; slug?: string | null } | null;
  clientName: string | null;
  documentTitle: string | null;
  isReminder: boolean;
}) {
  const studioName = resolveStudioDisplayName(params.studio);
  const clientName = params.clientName?.trim() || "there";
  const documentTitle = params.documentTitle || "a document";
  // Only a real portal slug produces a client CTA. No slug -> no CTA at all: never a staff-only `/app`
  // fallback, and never a malformed `/portal//documents` link.
  const portalUrl = params.studio?.slug
    ? buildAppUrl(`/portal/${encodeURIComponent(params.studio.slug)}/documents`)
    : null;
  const isReminder = params.isReminder;
  const subject = sanitizeEmailSubject(
    isReminder
      ? `Reminder: ${documentTitle} needs your signature`
      : `${studioName} assigned a document for your review`,
  );
  const greeting = `${clientName || "Hello"},`;
  const intro = `${studioName} ${isReminder ? "is reminding you to review" : "assigned"} ${documentTitle}.`;
  const actionLine = portalUrl
    ? `Open your DanceFlow portal to review and sign it: ${portalUrl}`
    : `Contact ${studioName} for next steps on reviewing and signing it.`;
  const bodyText = [
    greeting,
    "",
    intro,
    "",
    actionLine,
    "",
    "Thank you,",
    studioName,
  ].join("\n");
  const bodyHtml = renderStudioBrandedEmail(
    {
      name: studioName,
      logoUrl: params.studio?.public_logo_url ?? null,
    },
    {
      previewText: subject,
      eyebrow: isReminder ? "Signature Reminder" : "Document Request",
      heading: isReminder ? "Your signature is still needed" : "A document is ready for review",
      greeting,
      intro,
      bodyText,
      detailRows: [{ label: "Document", value: documentTitle }],
      actionLabel: portalUrl ? "Review and Sign" : null,
      actionUrl: portalUrl,
      dedupeBodyLeadIn: true,
    },
  );

  return { subject, bodyText, bodyHtml };
}
