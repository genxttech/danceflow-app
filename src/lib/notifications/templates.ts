type TicketCodeLine = {
  name: string;
  code: string;
};

type EventOutboundTemplateParams = {
  eventName: string;
  attendeeFirstName: string;
  attendeeLastName: string;
  ticketTypeName: string;
  quantity: number;
  totalPrice: number;
  currency: string;
  eventUrl: string;
  ticketCodes?: TicketCodeLine[];
};

function money(value: number, currency: string) {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: (currency || "USD").toUpperCase(),
    }).format(value);
  } catch {
    return `${value.toFixed(2)} ${currency || "USD"}`;
  }
}

function attendeeName(params: EventOutboundTemplateParams) {
  return `${params.attendeeFirstName} ${params.attendeeLastName}`.trim();
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escapeHtmlAttribute(value: string) {
  return escapeHtml(value);
}

function buildTicketQrUrl(eventUrl: string, ticketCode: string) {
  try {
    const url = new URL(eventUrl);
    url.pathname = "/api/tickets/qr";
    url.search = "";
    url.searchParams.set("code", ticketCode);
    return url.toString();
  } catch {
    return "";
  }
}

function ticketCodeText(params: EventOutboundTemplateParams) {
  const rows = params.ticketCodes ?? [];
  if (!rows.length) return "";

  return [
    ``,
    `Ticket check-in code${rows.length > 1 ? "s" : ""}:`,
    ...rows.map((ticket) => `${ticket.name || "Attendee"}: ${ticket.code}`),
    ``,
    `Bring this code with you for faster check-in.`,
  ].join("\n");
}

function brandedEmailShell(params: {
  previewLabel: string;
  headline: string;
  intro: string;
  eventName: string;
  ticketTypeName: string;
  quantity: number;
  totalLabel: string;
  eventUrl: string;
  ticketCodes?: TicketCodeLine[];
}) {
  const ticketRows = params.ticketCodes ?? [];

  const ticketCodeCards = ticketRows.length
    ? ticketRows
        .map((ticket) => {
          const qrUrl = buildTicketQrUrl(params.eventUrl, ticket.code);

          return `
            <div style="padding:14px;border:1px solid #f3d4e6;background:#fff7fb;border-radius:14px;margin-top:10px;">
              <div style="font-size:13px;color:#6b7280;margin-bottom:4px;">${escapeHtml(
                ticket.name || "Attendee"
              )}</div>

              <div style="font-size:22px;line-height:1.1;font-weight:800;letter-spacing:0.08em;color:#be185d;">${escapeHtml(
                ticket.code
              )}</div>

              ${
                qrUrl
                  ? `
                    <div style="margin-top:12px;text-align:center;">
                      <img
                        src="${escapeHtmlAttribute(qrUrl)}"
                        width="180"
                        height="180"
                        alt="QR code for ticket ${escapeHtmlAttribute(
                          ticket.code
                        )}"
                        style="display:block;margin:0 auto;border:1px solid #f3d4e6;border-radius:12px;background:#ffffff;padding:8px;"
                      />
                      <div style="margin-top:8px;font-size:12px;line-height:1.5;color:#6b7280;">
                        Show this QR code or the ticket code above at check-in.
                      </div>
                    </div>
                  `
                  : ""
              }
            </div>
          `;
        })
        .join("")
    : `<div style="padding:12px 14px;border:1px solid #e5e7eb;background:#f9fafb;border-radius:14px;color:#6b7280;">Your check-in code will be available in your registration details.</div>`;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(params.previewLabel)}</title>
  </head>
  <body style="margin:0;padding:0;background:#f6f3f7;font-family:Arial,Helvetica,sans-serif;color:#111827;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(
      params.previewLabel
    )}</div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f6f3f7;margin:0;padding:24px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:640px;background:#ffffff;border-radius:22px;overflow:hidden;border:1px solid #eaddec;box-shadow:0 18px 40px rgba(17,24,39,0.08);">
            <tr>
              <td style="background:linear-gradient(135deg,#111827 0%,#7f1d1d 45%,#be185d 100%);padding:28px 26px;color:#ffffff;">
                <div style="font-size:14px;letter-spacing:0.16em;text-transform:uppercase;font-weight:800;color:#fed7aa;">DanceFlow</div>
                <h1 style="margin:10px 0 0;font-size:30px;line-height:1.15;font-weight:800;">${escapeHtml(
                  params.headline
                )}</h1>
                <p style="margin:10px 0 0;font-size:15px;line-height:1.6;color:#ffe4ef;">${escapeHtml(
                  params.intro
                )}</p>
              </td>
            </tr>
            <tr>
              <td style="padding:26px;">
                <div style="border:1px solid #eee3ef;border-radius:18px;padding:18px;background:#fffafc;">
                  <div style="font-size:13px;text-transform:uppercase;letter-spacing:0.1em;font-weight:800;color:#be185d;margin-bottom:6px;">Event</div>
                  <div style="font-size:24px;line-height:1.2;font-weight:800;color:#111827;">${escapeHtml(
                    params.eventName
                  )}</div>
                </div>

                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:16px;">
                  <tr>
                    <td style="padding:12px;border:1px solid #eee3ef;border-radius:14px;background:#ffffff;">
                      <div style="font-size:12px;text-transform:uppercase;letter-spacing:0.08em;font-weight:800;color:#6b7280;">Ticket</div>
                      <div style="font-size:16px;font-weight:700;color:#111827;margin-top:4px;">${escapeHtml(
                        params.ticketTypeName
                      )}</div>
                    </td>
                  </tr>
                </table>

                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:12px;">
                  <tr>
                    <td width="50%" style="padding:12px;border:1px solid #eee3ef;border-radius:14px;background:#ffffff;">
                      <div style="font-size:12px;text-transform:uppercase;letter-spacing:0.08em;font-weight:800;color:#6b7280;">Quantity</div>
                      <div style="font-size:16px;font-weight:700;color:#111827;margin-top:4px;">${params.quantity}</div>
                    </td>
                    <td width="12"></td>
                    <td width="50%" style="padding:12px;border:1px solid #eee3ef;border-radius:14px;background:#ffffff;">
                      <div style="font-size:12px;text-transform:uppercase;letter-spacing:0.08em;font-weight:800;color:#6b7280;">Total</div>
                      <div style="font-size:16px;font-weight:700;color:#111827;margin-top:4px;">${escapeHtml(
                        params.totalLabel
                      )}</div>
                    </td>
                  </tr>
                </table>

                <div style="margin-top:20px;">
                  <div style="font-size:13px;text-transform:uppercase;letter-spacing:0.1em;font-weight:800;color:#be185d;margin-bottom:8px;">Check-in code${
                    ticketRows.length > 1 ? "s" : ""
                  }</div>
                  ${ticketCodeCards}
                  <p style="margin:12px 0 0;font-size:14px;line-height:1.6;color:#4b5563;">Bring your check-in code or QR code with you for faster event entry. Staff can also look you up by name or email.</p>
                </div>

                <div style="margin-top:26px;text-align:center;">
                  <a href="${escapeHtml(
                    params.eventUrl
                  )}" style="display:inline-block;background:#be185d;color:#ffffff;text-decoration:none;font-weight:800;border-radius:999px;padding:14px 22px;">View Event Details</a>
                </div>
              </td>
            </tr>
            <tr>
              <td style="padding:18px 26px;background:#111827;color:#d1d5db;font-size:13px;line-height:1.6;">
                Sent by DanceFlow. You are receiving this because an event registration was completed with this email address.<br />
                <span style="color:#f9a8d4;font-weight:700;">DanceFlow</span> helps dancers, studios, and organizers stay connected.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

export function buildEventWaitlistEmailTemplate(
  params: EventOutboundTemplateParams
) {
  return {
    subject: `You're on the waitlist for ${params.eventName}`,
    bodyText: [
      `Hi ${params.attendeeFirstName || attendeeName(params)},`,
      ``,
      `You're now on the waitlist for ${params.eventName}.`,
      `Ticket: ${params.ticketTypeName}`,
      `Quantity: ${params.quantity}`,
      ``,
      `If a spot opens up, the organizer can contact you with next steps.`,
      `Event page: ${params.eventUrl}`,
      ``,
      `Thanks,`,
      `DanceFlow`,
    ].join("\n"),
  };
}

export function buildEventWaitlistSmsTemplate(
  params: EventOutboundTemplateParams
) {
  return `You're on the waitlist for ${params.eventName}. Ticket: ${params.ticketTypeName}. Qty: ${params.quantity}. Details: ${params.eventUrl}`;
}

export function buildEventConfirmedEmailTemplate(
  params: EventOutboundTemplateParams
) {
  const totalLabel =
    params.totalPrice > 0 ? money(params.totalPrice, params.currency) : "Free";

  const bodyText = [
    `Hi ${params.attendeeFirstName || attendeeName(params)},`,
    ``,
    `Your registration is confirmed for ${params.eventName}.`,
    `Ticket: ${params.ticketTypeName}`,
    `Quantity: ${params.quantity}`,
    `Total: ${totalLabel}`,
    ticketCodeText(params),
    ``,
    `Event page: ${params.eventUrl}`,
    ``,
    `Thanks,`,
    `DanceFlow`,
  ]
    .filter((line) => line !== null && line !== undefined)
    .join("\n");

  const bodyHtml = brandedEmailShell({
    previewLabel: `Registration confirmed for ${params.eventName}`,
    headline: "Registration Confirmed",
    intro: "You are registered. Save your check-in code for faster entry.",
    eventName: params.eventName,
    ticketTypeName: params.ticketTypeName,
    quantity: params.quantity,
    totalLabel,
    eventUrl: params.eventUrl,
    ticketCodes: params.ticketCodes,
  });

  return {
    subject: `Registration confirmed for ${params.eventName}`,
    bodyText,
    bodyHtml,
  };
}

export function buildEventConfirmedSmsTemplate(
  params: EventOutboundTemplateParams
) {
  return `Confirmed: ${params.eventName}. Ticket: ${params.ticketTypeName}. Qty: ${
    params.quantity
  }. ${
    params.totalPrice > 0
      ? `Total ${money(params.totalPrice, params.currency)}.`
      : `Free registration.`
  } Details: ${params.eventUrl}`;
}
