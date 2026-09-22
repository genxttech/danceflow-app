/**
 * Pure builders for the studio marketing campaign email content (BR-3B2). Kept in its own file, with no
 * "use server" directive, because `actions.ts` is a Server Actions module -- Next.js requires every
 * export from a "use server" file to be an async function, so these synchronous builders cannot live
 * there directly. No behavior differs from having them inline. Uses the shared `escapeHtml` (not a new
 * local duplicate) since `actions.ts`'s own local copy is retained there for its unrelated
 * `plainTextToHtml` helper.
 */
import { renderStudioBrandedEmail } from "@/lib/notifications/email-branding";
import { escapeHtml } from "@/lib/email/brand";

export type CampaignEmailParams = {
  studioName: string;
  studioLogoUrl?: string | null;
  subject: string;
  previewText: string | null;
  bodyText: string;
  ctaLabel: string | null;
  ctaUrl: string | null;
  footerNote: string;
  unsubscribeUrl?: string | null;
};

export function buildCampaignEmailHtml(params: CampaignEmailParams) {
  // Footer hierarchy (locked): 1) the studio's actual message body (untouched, never overridden by the
  // compliance/unsubscribe block); 2) a compliance block (legal/business name + postal address + a
  // clickable unsubscribe link) via the shell's additive `footerHtml`; 3) the shell's own canonical
  // "Sent by {public_name} through DanceFlow." attribution (never overridden here); 4) the GenX legal line
  // (always appended by the shell). `params.footerNote` carries the legal-name+address compliance string.
  const complianceHtml = params.footerNote
    ? `<div style="margin:0 0 8px;">${escapeHtml(params.footerNote)}</div>`
    : "";
  const unsubscribeHtml = params.unsubscribeUrl
    ? `<div style="margin:0 0 8px;">You are receiving this because you shared your email with ${escapeHtml(
        params.studioName,
      )}. <a href="${escapeHtml(
        params.unsubscribeUrl,
      )}" style="color:#6d28d9;text-decoration:underline;">Unsubscribe</a>.</div>`
    : "";
  const footerHtml = complianceHtml || unsubscribeHtml
    ? `${complianceHtml}${unsubscribeHtml}`
    : undefined;

  return renderStudioBrandedEmail(
    {
      name: params.studioName,
      logoUrl: params.studioLogoUrl ?? null,
    },
    {
      previewText: params.previewText || params.subject,
      eyebrow: "Studio Update",
      heading: params.subject,
      bodyText: params.bodyText,
      actionLabel:
        params.ctaLabel && params.ctaUrl ? params.ctaLabel : null,
      actionUrl:
        params.ctaLabel && params.ctaUrl ? params.ctaUrl : null,
      footerHtml,
    },
  );
}

export function buildCampaignEmailText(params: CampaignEmailParams) {
  const cta =
    params.ctaLabel && params.ctaUrl
      ? `\n\n${params.ctaLabel}: ${params.ctaUrl}`
      : "";
  const unsubscribe = params.unsubscribeUrl
    ? `\n\nUnsubscribe: ${params.unsubscribeUrl}`
    : "";

  return `${params.studioName}\n\n${params.bodyText}${cta}\n\n${params.footerNote}${unsubscribe}`;
}
