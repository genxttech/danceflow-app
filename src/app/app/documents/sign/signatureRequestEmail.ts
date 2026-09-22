/**
 * Pure builder for the signature-request email (BR-3B2). Kept in its own file, with no "use server"
 * directive, because `actions.ts` is a Server Actions module -- Next.js requires every export from a
 * "use server" file to be an async function, so this synchronous builder cannot live there directly.
 * No behavior differs from having it inline.
 */
import { renderStudioBrandedEmail } from "@/lib/notifications/email-branding";
import { resolveStudioDisplayName, sanitizeEmailSubject } from "@/lib/email/brand";

/** Pure builder: the signature-request email sent to the signer. */
export function buildSignatureRequestEmail(params: {
  studio: { public_name?: string | null; name?: string | null; public_logo_url?: string | null } | null;
  signerName: string | null;
  title: string | null;
  signUrl: string;
  expiresInDays: number;
  subjectPrefix?: string;
}) {
  const studioName = resolveStudioDisplayName(params.studio);
  const signerName = String(params.signerName ?? "there").trim() || "there";
  const title = String(params.title ?? "document").trim() || "document";
  const subjectLead = params.subjectPrefix
    ? `${params.subjectPrefix} from ${studioName}`
    : `${studioName} requests your signature`;
  const subject = sanitizeEmailSubject(`${subjectLead}: ${title}`);
  const expiryLine = `This secure link expires in ${params.expiresInDays} day${params.expiresInDays === 1 ? "" : "s"}.`;
  const greeting = `Hi ${signerName},`;
  const intro = `${studioName} has sent you "${title}" for review and signature.`;

  const bodyText = [
    greeting,
    "",
    intro,
    "",
    `Review and sign securely: ${params.signUrl}`,
    "",
    expiryLine,
    "",
    "Thanks,",
    studioName,
  ].join("\n");

  const bodyHtml = renderStudioBrandedEmail(
    { name: studioName, logoUrl: params.studio?.public_logo_url ?? null },
    {
      previewText: `${studioName} sent you a document to sign.`,
      eyebrow: "Signature Requested",
      heading: "A document needs your signature",
      greeting,
      intro,
      bodyText,
      actionLabel: "Review and Sign",
      actionUrl: params.signUrl,
      footerNote: expiryLine,
      dedupeBodyLeadIn: true,
    },
  );

  return { subject, bodyText, bodyHtml };
}
