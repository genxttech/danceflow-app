/**
 * Pure builders for the document-signing notification emails (BR-3B2). Kept in its own file, with no
 * "use server" directive, because `actions.ts` is a Server Actions module -- Next.js requires every
 * export from a "use server" file to be an async function, so these synchronous, dependency-light
 * builders cannot live there directly. No behavior differs from having them inline.
 */
import { renderStudioBrandedEmail } from "@/lib/notifications/email-branding";
import { buildAppUrl } from "@/lib/email/brand";

export type SigningEmailContext = {
  studioName: string;
  studioLogoUrl: string | null;
  studioSlug: string | null;
  studioEmail: string | null;
};

/** Pure builder: the signer-facing "your document is signed" email. Preserves the existing signer/client
 * destination (Student Portal documents page when a slug exists, otherwise no CTA at all -- never an
 * internal staff link). */
export function buildSigningCompletedSignerEmail(params: {
  context: SigningEmailContext;
  title: string;
  signerName: string;
}) {
  const { context } = params;
  const portalUrl = context.studioSlug
    ? buildAppUrl(`/portal/${encodeURIComponent(context.studioSlug)}/documents`)
    : null;
  const signerName = params.signerName || "there";
  const greeting = `Hi ${signerName},`;
  const intro = `Your signature for ${params.title} has been completed successfully.`;
  const subject = `${params.title} has been signed`;
  const bodyText = [
    greeting,
    "",
    intro,
    "",
    portalUrl ? `View your documents: ${portalUrl}` : "",
    "",
    `Questions? Reply to this email to contact ${context.studioName}.`,
    "",
    "Thanks,",
    context.studioName,
  ].join("\n");

  const bodyHtml = renderStudioBrandedEmail(
    { name: context.studioName, logoUrl: context.studioLogoUrl },
    {
      previewText: `${params.title} has been signed.`,
      eyebrow: "Signature Complete",
      heading: "Your document is signed",
      greeting,
      intro,
      bodyText,
      detailRows: [{ label: "Document", value: params.title }],
      actionLabel: portalUrl ? "View Documents" : null,
      actionUrl: portalUrl,
      footerText: `Sent by ${context.studioName} through DanceFlow.`,
      dedupeBodyLeadIn: true,
    },
  );

  return { subject, bodyText, bodyHtml };
}

/** Pure builder: the studio-facing "a document has been signed" notice. Staff destination only. */
export function buildSigningCompletedStudioEmail(params: {
  context: SigningEmailContext;
  title: string;
  signerName: string | null;
}) {
  const { context } = params;
  const signerName = params.signerName || "A signer";
  const intro = `${signerName} completed ${params.title}.`;
  const subject = `Signed: ${params.title}`;
  const bodyText = [
    intro,
    "",
    "The signed document is available in DanceFlow.",
  ].join("\n");

  const bodyHtml = renderStudioBrandedEmail(
    { name: context.studioName, logoUrl: context.studioLogoUrl },
    {
      previewText: intro,
      eyebrow: "Document Completed",
      heading: "A document has been signed",
      intro,
      bodyText,
      detailRows: [
        { label: "Document", value: params.title },
        { label: "Signer", value: params.signerName || "Signer" },
      ],
      actionLabel: "Open Documents",
      actionUrl: buildAppUrl("/app/documents"),
      dedupeBodyLeadIn: true,
    },
  );

  return { subject, bodyText, bodyHtml };
}

/** Pure builder: the studio-facing "a signer declined" notice. Staff destination only. */
export function buildSigningDeclinedStudioEmail(params: {
  context: SigningEmailContext;
  title: string;
  signerName: string | null;
  reason: string;
}) {
  const { context } = params;
  const intro = `${params.signerName || "The signer"} declined ${params.title}.`;
  const subject = `Declined: ${params.title}`;
  const bodyText = [
    intro,
    params.reason ? `Reason: ${params.reason}` : "",
    "",
    "Review the request in DanceFlow before deciding whether to revise or resend it.",
  ].join("\n");

  const bodyHtml = renderStudioBrandedEmail(
    { name: context.studioName, logoUrl: context.studioLogoUrl },
    {
      previewText: `${params.title} was declined.`,
      eyebrow: "Signature Declined",
      heading: "A signer declined a document",
      intro,
      bodyText,
      detailRows: [
        { label: "Document", value: params.title },
        { label: "Signer", value: params.signerName || "Signer" },
        ...(params.reason ? [{ label: "Reason", value: params.reason }] : []),
      ],
      actionLabel: "Open Documents",
      actionUrl: buildAppUrl("/app/documents"),
      dedupeBodyLeadIn: true,
    },
  );

  return { subject, bodyText, bodyHtml };
}
