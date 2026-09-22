/**
 * Pure builder for the accountant secure-delivery email, kept in its own file (no `./reports` or `./tokens`
 * imports) so it can be unit-tested without pulling in `server-only`-gated accounting modules.
 */
import { renderStudioBrandedEmail } from "@/lib/notifications/email-branding";

export function buildAccountantDeliveryEmail(params: {
  studio: { name: string; logoUrl: string | null };
  accountantName: string;
  link: string;
}) {
  const studioName = params.studio.name;
  const greeting = `Hi ${params.accountantName},`;
  const intro = `${studioName} has prepared a secure accounting report package for you.`;

  const bodyText = [
    greeting,
    "",
    intro,
    "",
    "The link expires in 7 days.",
    "",
    params.link,
    "",
    "For security, do not forward this link.",
    "",
    "Thanks,",
    studioName,
  ].join("\n");

  const bodyHtml = renderStudioBrandedEmail(
    { name: studioName, logoUrl: params.studio.logoUrl },
    {
      previewText: `Secure accounting reports from ${studioName}`,
      eyebrow: "Accountant Delivery",
      heading: "Your secure report package is ready",
      greeting,
      intro,
      bodyText,
      actionLabel: "Open secure report package",
      actionUrl: params.link,
      footerNote: "This secure link expires in 7 days.",
      dedupeBodyLeadIn: true,
    },
  );

  return { subject: `Secure accounting reports from ${studioName}`, bodyText, bodyHtml };
}
