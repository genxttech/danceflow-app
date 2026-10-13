import { renderStudioBrandedEmail } from "@/lib/notifications/email-branding";

type TicketCodeLine = {
  name: string;
  code: string;
};

type TicketPurchaseLine = {
  name: string;
  quantity: number;
  totalPrice?: number;
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
  brandName?: string;
  brandLogoUrl?: string | null;
  ticketCodes?: TicketCodeLine[];
  purchasedItems?: TicketPurchaseLine[];
  /**
   * PAY-DC-3: the merchant sentence from `resolveEmailMerchantIdentity` (persisted payment facts only).
   * Omitted when the payment is free, pending, manual or its owner is unproven.
   */
  merchantLine?: string | null;
  /** PAY-DC-3: subject wording. The body and dedupe keys are unchanged. */
  subjectKind?: "confirmation" | "reminder";
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

function safeUrl(value: string) {
  try {
    const parsed = new URL(value);
    return ["http:", "https:"].includes(parsed.protocol) ? parsed.toString() : "";
  } catch {
    return "";
  }
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
    "",
    `Ticket check-in code${rows.length > 1 ? "s" : ""}:`,
    ...rows.map((ticket) => `${ticket.name || "Attendee"}: ${ticket.code}`),
    "",
    "Bring this code with you for faster check-in.",
  ].join("\n");
}

function eventBrand(params: EventOutboundTemplateParams) {
  return {
    name: params.brandName?.trim() || "DanceFlow Event Organizer",
    logoUrl: params.brandLogoUrl ?? null,
  };
}

function purchaseDetailsHtml(params: EventOutboundTemplateParams) {
  const purchased = params.purchasedItems ?? [];
  const rows = purchased.length
    ? purchased
    : [
        {
          name: params.ticketTypeName,
          quantity: params.quantity,
          totalPrice: params.totalPrice,
        },
      ];

  return `
    <div style="margin:0 0 18px;border:1px solid #e2e8f0;border-radius:16px;padding:16px;background:#f8fafc;">
      <div style="font-size:12px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#64748b;margin-bottom:8px;">Event</div>
      <div style="font-size:22px;line-height:1.3;font-weight:800;color:#0f172a;">${escapeHtml(params.eventName)}</div>
    </div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:0 0 20px;border-collapse:collapse;">
      ${rows
        .map((item) => {
          const itemTotal =
            typeof item.totalPrice === "number"
              ? money(item.totalPrice, params.currency)
              : "";
          return `<tr>
            <td style="padding:12px 0;border-bottom:1px solid #e2e8f0;">
              <div style="font-size:15px;font-weight:700;color:#0f172a;">${escapeHtml(item.name)}</div>
              <div style="font-size:13px;color:#64748b;">Quantity: ${Number(item.quantity || 0)}</div>
            </td>
            <td align="right" style="padding:12px 0;border-bottom:1px solid #e2e8f0;font-weight:700;color:#0f172a;">${escapeHtml(itemTotal)}</td>
          </tr>`;
        })
        .join("")}
    </table>`;
}

function ticketCardsHtml(params: EventOutboundTemplateParams) {
  const tickets = params.ticketCodes ?? [];
  if (!tickets.length) return "";

  return `
    <div style="margin:20px 0 0;">
      <div style="font-size:12px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#64748b;">Check-in code${tickets.length > 1 ? "s" : ""}</div>
      ${tickets
        .map((ticket) => {
          const qrUrl = safeUrl(buildTicketQrUrl(params.eventUrl, ticket.code));
          return `<div style="margin-top:10px;padding:15px;border:1px solid #e9d5ff;border-radius:16px;background:#faf5ff;">
            <div style="font-size:13px;color:#64748b;">${escapeHtml(ticket.name || "Attendee")}</div>
            <div style="margin-top:4px;font-size:22px;font-weight:800;letter-spacing:.08em;color:#6d28d9;">${escapeHtml(ticket.code)}</div>
            ${
              qrUrl
                ? `<img src="${escapeHtml(qrUrl)}" width="176" height="176" alt="Ticket QR code" style="display:block;margin:14px auto 0;border:1px solid #e2e8f0;border-radius:12px;background:#ffffff;padding:8px;" />`
                : ""
            }
          </div>`;
        })
        .join("")}
    </div>`;
}

/** PAY-DC-3 (D-F): brand identity in the subject; the brand is the organizer or studio shown in the email. */
export function buildEventEmailSubject(params: {
  eventName: string;
  brandName?: string | null;
  subjectKind?: "confirmation" | "reminder";
}) {
  const brand = params.brandName?.trim();
  const suffix = brand ? ` — ${brand}` : "";
  return params.subjectKind === "reminder"
    ? `Reminder: ${params.eventName}${suffix}`
    : `Registration confirmed for ${params.eventName}${suffix}`;
}

export function buildEventWaitlistEmailTemplate(
  params: EventOutboundTemplateParams,
) {
  const brand = eventBrand(params);
  const greeting = params.attendeeFirstName || attendeeName(params) || "there";
  const bodyText = [
    `Hi ${greeting},`,
    "",
    `You're now on the waitlist for ${params.eventName}.`,
    `Ticket: ${params.ticketTypeName}`,
    `Quantity: ${params.quantity}`,
    "",
    `${brand.name} will contact you if a spot opens up.`,
    `Event page: ${params.eventUrl}`,
    "",
    "Thanks,",
    brand.name,
  ].join("\n");

  return {
    subject: `You're on the waitlist for ${params.eventName}`,
    bodyText,
    bodyHtml: renderStudioBrandedEmail(brand, {
      previewText: `Waitlist confirmation for ${params.eventName}`,
      eyebrow: "Event Waitlist",
      heading: "You’re on the waitlist",
      greeting: `Hi ${greeting},`,
      intro: `${brand.name} has received your waitlist registration.`,
      bodyText,
      detailRows: [
        { label: "Event", value: params.eventName },
        { label: "Ticket", value: params.ticketTypeName },
        { label: "Quantity", value: String(params.quantity) },
      ],
      actionLabel: "View Event Details",
      actionUrl: params.eventUrl,
      footerText: `Sent by ${brand.name} through DanceFlow.`,
    }),
  };
}

export function buildEventWaitlistSmsTemplate(
  params: EventOutboundTemplateParams,
) {
  return `You're on the waitlist for ${params.eventName}. Ticket: ${params.ticketTypeName}. Qty: ${params.quantity}. Details: ${params.eventUrl}`;
}

export function buildEventConfirmedEmailTemplate(
  params: EventOutboundTemplateParams,
) {
  const brand = eventBrand(params);
  const greeting = params.attendeeFirstName || attendeeName(params) || "there";
  const totalLabel =
    params.totalPrice > 0 ? money(params.totalPrice, params.currency) : "Free";
  const merchantLine = params.merchantLine?.trim() || "";

  const purchaseRows = params.purchasedItems ?? [];
  const purchaseLines = purchaseRows.length
    ? [
        "Tickets and options purchased:",
        ...purchaseRows.map((item) => {
          const itemTotal =
            typeof item.totalPrice === "number"
              ? ` — ${money(item.totalPrice, params.currency)}`
              : "";
          return `- ${item.name} x ${item.quantity}${itemTotal}`;
        }),
      ]
    : [`Ticket: ${params.ticketTypeName}`, `Quantity: ${params.quantity}`];

  const bodyText = [
    `Hi ${greeting},`,
    "",
    `Your registration is confirmed for ${params.eventName}.`,
    ...purchaseLines,
    `Total: ${totalLabel}`,
    merchantLine,
    ticketCodeText(params),
    "",
    `Event page: ${params.eventUrl}`,
    "",
    "Thanks,",
    brand.name,
  ]
    .filter(Boolean)
    .join("\n");

  const customHtml = `
    ${purchaseDetailsHtml(params)}
    <div style="padding:13px 15px;border-radius:14px;background:#ecfdf5;border:1px solid #a7f3d0;font-size:15px;color:#065f46;">
      <strong>Total:</strong> ${escapeHtml(totalLabel)}
    </div>
    ${
      merchantLine
        ? `<p style="margin:10px 0 0;font-size:13px;line-height:1.6;color:#64748b;">${escapeHtml(merchantLine)}</p>`
        : ""
    }
    ${ticketCardsHtml(params)}
  `;

  return {
    subject: buildEventEmailSubject({
      eventName: params.eventName,
      brandName: params.brandName,
      subjectKind: params.subjectKind,
    }),
    bodyText,
    bodyHtml: renderStudioBrandedEmail(brand, {
      previewText: `Registration confirmed for ${params.eventName}`,
      eyebrow: "Event Registration",
      heading: "Registration Confirmed",
      greeting: `Hi ${greeting},`,
      intro: `${brand.name} has confirmed your registration.`,
      bodyText,
      contentHtml: customHtml,
      actionLabel: "View Event Details",
      actionUrl: params.eventUrl,
      footerText: `Sent by ${brand.name} through DanceFlow.`,
    }),
  };
}

export function buildEventConfirmedSmsTemplate(
  params: EventOutboundTemplateParams,
) {
  return `Confirmed: ${params.eventName}. Ticket: ${params.ticketTypeName}. Qty: ${
    params.quantity
  }. ${
    params.totalPrice > 0
      ? `Total ${money(params.totalPrice, params.currency)}.`
      : "Free registration."
  } Details: ${params.eventUrl}`;
}

/** PAY-WH-1A: what each payment exception means for staff (plain language; no internal codes in the headline). */
export const PAYMENT_EXCEPTION_LABELS: Record<string, string> = {
  late_payment_after_release: "A buyer paid after their ticket hold was released",
  duplicate_payment: "An order was paid twice",
  paid_capacity_unavailable: "A buyer paid but the tickets were no longer available",
  unknown_payment_reference: "A payment arrived that does not match any order",
  settlement_integrity_conflict: "A payment could not be applied to its order",
  terminal_paid_capacity_unavailable: "A card-reader sale was charged but the tickets were sold out",
  terminal_payment_unfulfilled: "A card-reader sale was charged but its tickets could not be issued",
  failure_after_settlement: "A completed payment later failed",
  settlement_effect_dead: "A follow-up step for a paid order keeps failing",
  reconcile_stuck: "A pending order cannot be reconciled with Stripe",
  mismatch_account: "A payment arrived on the wrong Stripe account",
  mismatch_session: "A payment did not match its checkout",
  mismatch_payment_intent: "A payment did not match its checkout",
  mismatch_amount: "A payment amount did not match its order",
  mismatch_currency: "A payment currency did not match its order",
};

export function paymentExceptionLabel(kind: string) {
  return PAYMENT_EXCEPTION_LABELS[kind] ?? kind.replaceAll("_", " ");
}

export function buildPaymentExceptionAlertEmailTemplate(params: {
  kind: string;
  moneyState: string;
  amountCents: number | null;
  currency: string | null;
  eventName: string | null;
  buyerEmail: string | null;
  stripePaymentIntentId: string | null;
  reviewUrl: string;
  brandName?: string | null;
  brandLogoUrl?: string | null;
}) {
  const brand = { name: params.brandName?.trim() || "DanceFlow", logoUrl: params.brandLogoUrl ?? null };
  const headline = paymentExceptionLabel(params.kind);
  const amount =
    typeof params.amountCents === "number" ? money(params.amountCents / 100, params.currency || "USD") : null;
  const moneyLine =
    params.moneyState === "captured"
      ? "The buyer was charged. Nothing was refunded or fulfilled automatically."
      : params.moneyState === "reversed"
        ? "A payment that had completed was reversed by the payment provider."
        : "No money moved automatically; the order needs a staff decision.";
  const details = [
    params.eventName ? `Event: ${params.eventName}` : "",
    amount ? `Amount: ${amount}` : "",
    params.buyerEmail ? `Buyer: ${params.buyerEmail}` : "",
    params.stripePaymentIntentId ? `Stripe payment: ${params.stripePaymentIntentId}` : "",
  ].filter(Boolean);
  const bodyText = [
    `${headline}.`,
    "",
    moneyLine,
    ...details,
    "",
    "Review it in DanceFlow, decide whether to issue tickets or refund the buyer in Stripe, then mark it resolved:",
    params.reviewUrl,
  ].join("\n");
  const contentHtml = `
    <div style="padding:13px 15px;border-radius:14px;background:#fef2f2;border:1px solid #fecaca;font-size:15px;color:#991b1b;">
      <strong>${escapeHtml(headline)}</strong><br />${escapeHtml(moneyLine)}
    </div>
    ${details.length ? `<p style="margin:12px 0 0;font-size:14px;line-height:1.7;color:#334155;">${details.map(escapeHtml).join("<br />")}</p>` : ""}
  `;
  return {
    subject: `Payment needs review: ${headline}`,
    bodyText,
    bodyHtml: renderStudioBrandedEmail(brand, {
      previewText: `Payment needs review: ${headline}`,
      eyebrow: "Payment exception",
      heading: "A payment needs your review",
      bodyText,
      contentHtml,
      actionLabel: "Review payment exception",
      actionUrl: safeUrl(params.reviewUrl) || undefined,
      footerText: `Sent to ${brand.name} staff by DanceFlow.`,
    }),
  };
}
