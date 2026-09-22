import {
  EMAIL_FONT_STACK,
  EMAIL_LEGAL_LINE,
  EMAIL_SYSTEM_FOOTER_TEXT,
  EMAIL_TOKENS,
  ORGANIZER_NAME_FALLBACK,
  STUDIO_NAME_FALLBACK,
  emailAssetUrl,
  emailAttribution,
  escapeHtml,
  resolveInitial,
  sanitizeActionUrl,
  sanitizeEmailSubject,
  sanitizePublicImageUrl,
} from "@/lib/email/brand";

const T = EMAIL_TOKENS;

type EmailBranding = {
  name: string;
  logoUrl?: string | null;
};

export type BrandedEmailMode = "system" | "studio" | "organizer";

export type BrandedEmailParams = {
  previewText: string;
  eyebrow?: string;
  heading: string;
  greeting?: string | null;
  intro?: string | null;
  bodyText: string;
  contentHtml?: string | null;
  actionLabel?: string | null;
  actionUrl?: string | null;
  detailRows?: Array<{ label: string; value: string }>;
  /**
   * Optional, default absent. A single long/unbreakable line (typically a fallback URL) rendered in its
   * own paragraph after the normal body content and before the CTA button. Escaped like any other text
   * field, but given a stronger `word-break:break-all` wrapping rule (in addition to the normal body's
   * `overflow-wrap`) so a long, punctuation-dense token cannot inflate the email table's intrinsic width
   * past the viewport. Scoped to only this element -- normal body paragraphs are never affected. Absent
   * by default; when omitted, every existing caller renders exactly as before.
   */
  fallbackLinkText?: string | null;
  /** Overrides the attribution line (kept for existing callers). The legal line is always appended. */
  footerText?: string | null;
  /** Optional extra line above the attribution (address, expiry, and similar). */
  footerNote?: string | null;
  /**
   * Optional, default absent. Raw, caller-supplied HTML rendered in the footer band, below any `footerNote`
   * and above the canonical attribution/legal lines. Never escaped and never merged into `bodyText`/`contentHtml`
   * — the caller is responsible for safely constructing/escaping whatever it passes here (e.g. a compliance
   * block with an already-escaped studio name and a clickable unsubscribe link). Absent by default; when
   * omitted, every existing caller renders exactly as before.
   */
  footerHtml?: string | null;
  /**
   * Opt-in, default off. When true, the HTML body omits (exact matches only) a leading paragraph equal to
   * `greeting`, then one equal to `intro`, then a final `<label>: <url>` or `<url>` line whose URL equals the
   * rendered CTA. The plain-text body is never modified and no prose is rewritten.
   */
  dedupeBodyLeadIn?: boolean;
};

/** Explicit, test/proof-only switches. Never derived from the environment by production callers. */
export type RenderBrandedEmailOptions = {
  assetBaseUrl?: string;
  allowInsecureImageUrls?: boolean;
  allowLocalActionUrls?: boolean;
};

function textToHtmlParagraphs(value: string) {
  return value
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const lines = block
        .split("\n")
        .map((line) => escapeHtml(line))
        .join("<br />");
      return `<p style="margin:0 0 16px;font-size:15px;line-height:1.7;color:${T.text};overflow-wrap:break-word;word-wrap:break-word;">${lines}</p>`;
    })
    .join("");
}

/**
 * Exact-match removal of the lead-in that callers repeat inside `bodyText` when they also pass `greeting`/`intro`
 * (and of a trailing CTA URL line). Pure string comparison: anything that does not match exactly is left alone.
 */
export function stripBodyLeadIn(
  bodyText: string,
  parts: { greeting?: string | null; intro?: string | null; ctaUrls?: string[] },
) {
  const paragraphs = bodyText
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);

  let changed = false;

  const greeting = parts.greeting?.trim();
  if (greeting && paragraphs[0] === greeting) {
    paragraphs.shift();
    changed = true;
  }

  const intro = parts.intro?.trim();
  if (intro && paragraphs[0] === intro) {
    paragraphs.shift();
    changed = true;
  }

  const urls = (parts.ctaUrls ?? []).map((url) => url.trim()).filter(Boolean);
  if (urls.length && paragraphs.length) {
    const lines = paragraphs[paragraphs.length - 1].split("\n");
    const last = lines[lines.length - 1].trim();
    const matches = urls.some(
      (url) =>
        last === url ||
        (last.endsWith(`: ${url}`) && last.length - url.length - 2 > 0 && last.length - url.length - 2 <= 80),
    );
    if (matches) {
      lines.pop();
      if (lines.length) paragraphs[paragraphs.length - 1] = lines.join("\n").trim();
      else paragraphs.pop();
      changed = true;
    }
  }

  // Preserve the caller's original text exactly when nothing matched, rather than silently
  // re-normalizing paragraph spacing.
  return changed ? paragraphs.join("\n\n") : bodyText;
}

const RESPONSIVE_STYLE = `
      @media only screen and (max-width:480px) {
        .df-outer { padding: 12px 8px !important; }
        .df-pad { padding-left: 18px !important; padding-right: 18px !important; }
        .df-h1 { font-size: 24px !important; }
        .df-stack { display: block !important; width: 100% !important; box-sizing: border-box !important; }
        .df-stack-label { border-right-width: 1px !important; border-bottom-width: 0 !important; border-radius: 12px 12px 0 0 !important; }
        .df-stack-value { border-radius: 0 0 12px 12px !important; }
      }`;

function systemHeader(
  content: BrandedEmailParams,
  options: RenderBrandedEmailOptions,
) {
  const logoSrc = emailAssetUrl("primary-white", { baseUrl: options.assetBaseUrl });
  const eyebrow = content.eyebrow?.trim();
  const eyebrowHtml = eyebrow
    ? `<div style="font-size:12px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:${T.accentSoft};">${escapeHtml(
        eyebrow,
      )}</div>`
    : "";

  return `<tr>
              <td class="df-pad" bgcolor="${T.primary}" style="padding:28px 26px;background-color:${T.primary};background-image:linear-gradient(135deg,${T.primary} 0%,${T.primaryDark} 100%);color:${T.white};">
                <img src="${escapeHtml(logoSrc)}" width="180" height="45" alt="DanceFlow" style="display:block;width:180px;height:45px;border:0;outline:none;text-decoration:none;margin:0 0 18px;" />
                ${eyebrowHtml}
                <h1 class="df-h1" style="margin:${eyebrow ? "9px" : "0"} 0 0;font-size:28px;line-height:1.25;font-weight:700;color:${T.white};">${escapeHtml(
                  content.heading,
                )}</h1>
              </td>
            </tr>`;
}

function identityBand(params: {
  name: string;
  logoUrl: string | null;
}) {
  const nameHtml = escapeHtml(params.name);
  const mark = params.logoUrl
    ? `<img src="${escapeHtml(params.logoUrl)}" alt="" style="display:block;width:auto;height:auto;max-width:140px;max-height:48px;border:0;outline:none;text-decoration:none;" />`
    : `<table role="presentation" cellspacing="0" cellpadding="0" aria-hidden="true"><tr><td width="48" height="48" align="center" valign="middle" bgcolor="${T.primarySoft}" style="width:48px;height:48px;background-color:${T.primarySoft};border-radius:12px;color:${T.primary};font-size:22px;font-weight:700;line-height:48px;text-align:center;">${escapeHtml(
        resolveInitial(params.name),
      )}</td></tr></table>`;

  // The display name is always visible text beside the mark (logo or initial tile); the logo is decorative.
  const nameCell = `<td valign="middle" style="padding-left:14px;font-size:18px;font-weight:700;line-height:1.3;color:${T.text};overflow-wrap:break-word;word-wrap:break-word;">${nameHtml}</td>`;

  return `<tr>
              <td height="4" bgcolor="${T.primary}" style="height:4px;line-height:4px;font-size:0;background-color:${T.primary};">&nbsp;</td>
            </tr>
            <tr>
              <td class="df-pad" style="padding:22px 26px 6px;background-color:${T.white};">
                <table role="presentation" cellspacing="0" cellpadding="0"><tr>
                  <td valign="middle">${mark}</td>
                  ${nameCell}
                </tr></table>
              </td>
            </tr>`;
}

function studioOrgHeading(content: BrandedEmailParams) {
  const eyebrow = content.eyebrow?.trim();
  const eyebrowHtml = eyebrow
    ? `<div style="font-size:12px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:${T.primary};margin:0 0 8px;">${escapeHtml(
        eyebrow,
      )}</div>`
    : "";
  return `${eyebrowHtml}<h1 class="df-h1" style="margin:0 0 18px;font-size:26px;line-height:1.25;font-weight:700;color:${T.text};">${escapeHtml(
    content.heading,
  )}</h1>`;
}

/**
 * Single renderer for all DanceFlow HTML email.
 * - `system`: DanceFlow primary (approved white primary logo on brand primary).
 * - `studio`: studio identity leads (validated logo, else initial tile + name); DanceFlow only in the footer.
 * - `organizer`: organizer name leads with an initial tile; the studio logo is never borrowed automatically.
 */
export function renderBrandedEmail(
  mode: BrandedEmailMode,
  identity: EmailBranding | null,
  content: BrandedEmailParams,
  options: RenderBrandedEmailOptions = {},
) {
  const isSystem = mode === "system";
  const identityName = isSystem
    ? "DanceFlow"
    : identity?.name?.trim() ||
      (mode === "organizer" ? ORGANIZER_NAME_FALLBACK : STUDIO_NAME_FALLBACK);

  const logoUrl =
    mode === "studio"
      ? sanitizePublicImageUrl(identity?.logoUrl, {
          allowInsecureImageUrls: options.allowInsecureImageUrls,
        })
      : null;

  const actionUrl = sanitizeActionUrl(content.actionUrl, {
    allowLocalHttp: options.allowLocalActionUrls,
  });

  const attribution =
    content.footerText?.trim() ||
    (isSystem ? EMAIL_SYSTEM_FOOTER_TEXT : emailAttribution(identityName));
  const footerNote = content.footerNote?.trim();

  const headerRows = isSystem
    ? systemHeader(content, options)
    : identityBand({ name: identityName, logoUrl });
  const headingHtml = isSystem ? "" : studioOrgHeading(content);

  const greetingHtml = content.greeting
    ? `<p style="margin:0 0 16px;font-size:16px;line-height:1.7;color:${T.text};">${escapeHtml(
        content.greeting,
      )}</p>`
    : "";

  const introHtml = content.intro
    ? `<p style="margin:0 0 18px;font-size:16px;line-height:1.7;color:${T.text};">${escapeHtml(
        content.intro,
      )}</p>`
    : "";

  const detailRows = content.detailRows ?? [];
  const detailsHtml = detailRows.length
    ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:20px 0;border-collapse:separate;border-spacing:0 10px;">
        ${detailRows
          .map(
            (row) => `<tr>
              <td class="df-stack df-stack-label" style="width:34%;padding:13px 15px;border:1px solid ${T.border};border-right:0;border-radius:12px 0 0 12px;background-color:${T.primarySoft};font-size:12px;font-weight:700;letter-spacing:0.07em;text-transform:uppercase;color:${T.muted};">${escapeHtml(
                row.label,
              )}</td>
              <td class="df-stack df-stack-value" style="padding:13px 15px;border:1px solid ${T.border};border-radius:0 12px 12px 0;background-color:${T.white};font-size:15px;font-weight:700;color:${T.text};">${escapeHtml(
                row.value,
              )}</td>
            </tr>`,
          )
          .join("")}
      </table>`
    : "";

  const actionHtml =
    actionUrl && content.actionLabel
      ? `<table role="presentation" align="center" cellspacing="0" cellpadding="0" style="margin:26px auto 8px;"><tr>
          <td bgcolor="${T.primary}" style="background-color:${T.primary};border-radius:12px;">
            <a href="${escapeHtml(actionUrl)}" style="display:inline-block;padding:14px 24px;font-family:${EMAIL_FONT_STACK};font-size:16px;font-weight:700;line-height:1.2;color:${T.white};text-decoration:none;border-radius:12px;">${escapeHtml(
              content.actionLabel,
            )}</a>
          </td>
        </tr></table>`
      : "";

  // A single long/unbreakable line (e.g. a fallback URL). Stronger word-break than normal body paragraphs,
  // scoped to only this element, rendered after the body and before the CTA button.
  const fallbackLinkHtml = content.fallbackLinkText
    ? `<p style="margin:0 0 16px;font-size:15px;line-height:1.7;color:${T.text};word-break:break-all;overflow-wrap:break-word;">${escapeHtml(
        content.fallbackLinkText,
      )}</p>`
    : "";

  const footerNoteHtml = footerNote
    ? `<div style="margin:0 0 8px;">${escapeHtml(footerNote)}</div>`
    : "";
  // Raw, caller-escaped HTML (e.g. a campaign compliance/unsubscribe block). Never escaped here, never
  // merged into the body — purely additive, and absent by default.
  const footerHtml = content.footerHtml ?? "";

  const bodyForHtml = content.dedupeBodyLeadIn
    ? stripBodyLeadIn(content.bodyText, {
        greeting: content.greeting,
        intro: content.intro,
        ctaUrls:
          actionUrl && content.actionLabel
            ? [actionUrl, content.actionUrl ?? ""]
            : [],
      })
    : content.bodyText;

  const title = escapeHtml(sanitizeEmailSubject(content.heading, "DanceFlow"));
  const preview = escapeHtml(sanitizeEmailSubject(content.previewText, ""));

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <meta name="color-scheme" content="light" />
    <meta name="supported-color-schemes" content="light" />
    <title>${title}</title>
    <style>${RESPONSIVE_STYLE}
    </style>
  </head>
  <body style="margin:0;padding:0;background-color:${T.surface};font-family:${EMAIL_FONT_STACK};color:${T.text};">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${preview}</div>
    <table role="presentation" class="df-outer" width="100%" cellspacing="0" cellpadding="0" style="width:100%;background-color:${T.surface};padding:24px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:660px;background-color:${T.white};border:1px solid ${T.border};border-radius:16px;overflow:hidden;">
            ${headerRows}
            <tr>
              <td class="df-pad" style="padding:${isSystem ? "28px" : "16px"} 26px 28px;">
                ${headingHtml}
                ${greetingHtml}
                ${introHtml}
                ${detailsHtml}
                ${content.contentHtml ? content.contentHtml : textToHtmlParagraphs(bodyForHtml)}
                ${fallbackLinkHtml}
                ${actionHtml}
              </td>
            </tr>
            <tr>
              <td class="df-pad" bgcolor="${T.surface}" style="padding:18px 26px;background-color:${T.surface};border-top:1px solid ${T.border};color:${T.muted};font-size:12px;line-height:1.7;">
                ${footerNoteHtml}${footerHtml}<div>${escapeHtml(attribution)}</div>
                <div>${escapeHtml(EMAIL_LEGAL_LINE)}</div>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

export function renderDanceFlowSystemEmail(params: BrandedEmailParams) {
  return renderBrandedEmail("system", null, params);
}

export function renderStudioBrandedEmail(
  branding: EmailBranding,
  params: BrandedEmailParams,
) {
  return renderBrandedEmail("studio", branding, params);
}

export function renderPlainTextAsStudioEmail(params: {
  studioName: string;
  studioLogoUrl?: string | null;
  subject: string;
  bodyText: string;
}) {
  return renderStudioBrandedEmail(
    {
      name: params.studioName,
      logoUrl: params.studioLogoUrl,
    },
    {
      previewText: params.subject,
      heading: params.subject,
      bodyText: params.bodyText,
    },
  );
}
