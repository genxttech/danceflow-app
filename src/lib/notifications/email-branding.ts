type EmailBranding = {
  name: string;
  logoUrl?: string | null;
};

type BrandedEmailParams = {
  previewText: string;
  eyebrow?: string;
  heading: string;
  greeting?: string | null;
  intro?: string | null;
  bodyText: string;
  actionLabel?: string | null;
  actionUrl?: string | null;
  detailRows?: Array<{ label: string; value: string }>;
  footerText?: string | null;
};

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function safeHttpUrl(value: string | null | undefined) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;

  try {
    const parsed = new URL(raw);
    if (!["http:", "https:"].includes(parsed.protocol)) return null;
    if (parsed.username || parsed.password) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

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
      return `<p style="margin:0 0 16px;font-size:15px;line-height:1.7;color:#334155;">${lines}</p>`;
    })
    .join("");
}

function emailShell(params: {
  brandName: string;
  logoUrl?: string | null;
  isDanceFlowSystem: boolean;
  content: BrandedEmailParams;
}) {
  const logoUrl = safeHttpUrl(params.logoUrl);
  const actionUrl = safeHttpUrl(params.content.actionUrl);
  const brandName = params.brandName.trim() || "DanceFlow";
  const headerGradient = params.isDanceFlowSystem
    ? "linear-gradient(135deg,#2e1065 0%,#4c1d95 58%,#f97316 100%)"
    : "linear-gradient(135deg,#1e1b4b 0%,#4c1d95 55%,#be185d 100%)";
  const eyebrow =
    params.content.eyebrow?.trim() ||
    (params.isDanceFlowSystem ? "DanceFlow" : brandName);
  const footer =
    params.content.footerText?.trim() ||
    (params.isDanceFlowSystem
      ? "This is a system message from DanceFlow."
      : `Sent by ${brandName} through DanceFlow.`);

  const logoHtml = logoUrl
    ? `<img src="${escapeHtml(logoUrl)}" alt="${escapeHtml(
        brandName,
      )} logo" style="display:block;max-width:220px;max-height:76px;object-fit:contain;background:#ffffff;border-radius:14px;padding:8px;margin:0 0 18px;" />`
    : `<div style="display:inline-block;background:rgba(255,255,255,0.14);border:1px solid rgba(255,255,255,0.22);border-radius:999px;padding:8px 13px;margin:0 0 18px;font-size:13px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;">${escapeHtml(
        brandName,
      )}</div>`;

  const greetingHtml = params.content.greeting
    ? `<p style="margin:0 0 16px;font-size:16px;line-height:1.7;color:#0f172a;">${escapeHtml(
        params.content.greeting,
      )}</p>`
    : "";

  const introHtml = params.content.intro
    ? `<p style="margin:0 0 18px;font-size:16px;line-height:1.7;color:#334155;">${escapeHtml(
        params.content.intro,
      )}</p>`
    : "";

  const detailRows = params.content.detailRows ?? [];
  const detailsHtml = detailRows.length
    ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:20px 0;border-collapse:separate;border-spacing:0 10px;">
        ${detailRows
          .map(
            (row) => `<tr>
              <td style="width:34%;padding:13px 15px;border:1px solid #e2e8f0;border-right:0;border-radius:14px 0 0 14px;background:#f8fafc;font-size:12px;font-weight:800;letter-spacing:0.07em;text-transform:uppercase;color:#64748b;">${escapeHtml(
                row.label,
              )}</td>
              <td style="padding:13px 15px;border:1px solid #e2e8f0;border-radius:0 14px 14px 0;background:#ffffff;font-size:15px;font-weight:700;color:#0f172a;">${escapeHtml(
                row.value,
              )}</td>
            </tr>`,
          )
          .join("")}
      </table>`
    : "";

  const actionHtml =
    actionUrl && params.content.actionLabel
      ? `<div style="margin:26px 0 8px;text-align:center;">
          <a href="${escapeHtml(actionUrl)}" style="display:inline-block;background:#4c1d95;color:#ffffff;text-decoration:none;font-weight:800;border-radius:14px;padding:14px 22px;">${escapeHtml(
            params.content.actionLabel,
          )}</a>
        </div>`
      : "";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>${escapeHtml(params.content.heading)}</title>
  </head>
  <body style="margin:0;padding:0;background:#f5f3f7;font-family:Arial,Helvetica,sans-serif;color:#0f172a;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(
      params.content.previewText,
    )}</div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%;background:#f5f3f7;padding:24px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:660px;background:#ffffff;border:1px solid #e9e2ec;border-radius:24px;overflow:hidden;box-shadow:0 18px 45px rgba(30,27,75,0.10);">
            <tr>
              <td style="padding:28px 26px;background:${headerGradient};color:#ffffff;">
                ${logoHtml}
                <div style="font-size:12px;font-weight:800;letter-spacing:0.16em;text-transform:uppercase;color:#fed7aa;">${escapeHtml(
                  eyebrow,
                )}</div>
                <h1 style="margin:9px 0 0;font-size:30px;line-height:1.2;font-weight:800;color:#ffffff;">${escapeHtml(
                  params.content.heading,
                )}</h1>
              </td>
            </tr>
            <tr>
              <td style="padding:28px 26px;">
                ${greetingHtml}
                ${introHtml}
                ${detailsHtml}
                ${textToHtmlParagraphs(params.content.bodyText)}
                ${actionHtml}
              </td>
            </tr>
            <tr>
              <td style="padding:18px 26px;background:#0f172a;color:#cbd5e1;font-size:12px;line-height:1.7;">
                ${escapeHtml(footer)}
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
  return emailShell({
    brandName: "DanceFlow",
    isDanceFlowSystem: true,
    content: params,
  });
}

export function renderStudioBrandedEmail(
  branding: EmailBranding,
  params: BrandedEmailParams,
) {
  return emailShell({
    brandName: branding.name,
    logoUrl: branding.logoUrl,
    isDanceFlowSystem: false,
    content: params,
  });
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
      footerText: `Sent by ${params.studioName} through DanceFlow.`,
    },
  );
}
