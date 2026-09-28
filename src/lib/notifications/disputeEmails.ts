import { buildAppUrl } from "@/lib/email/brand";
import { renderStudioBrandedEmail } from "@/lib/notifications/email-branding";

/**
 * PAY-DC-2C: studio-staff notice that a customer disputed a payment. Contains only
 * operational facts (amount, Stripe's reason category, response due date). No card
 * data, customer identity, evidence or Stripe account/charge ids.
 */

const REASON_LABELS: Record<string, string> = {
  bank_cannot_process: "Bank could not process",
  check_returned: "Check returned",
  credit_not_processed: "Credit not processed",
  customer_initiated: "Customer initiated",
  debit_not_authorized: "Debit not authorized",
  duplicate: "Duplicate charge",
  fraudulent: "Fraudulent",
  general: "General",
  incorrect_account_details: "Incorrect account details",
  insufficient_funds: "Insufficient funds",
  noncompliant: "Noncompliant",
  product_not_received: "Product not received",
  product_unacceptable: "Product unacceptable",
  subscription_canceled: "Subscription canceled",
  unrecognized: "Unrecognized",
};

export function formatDisputeReason(reason: string | null | undefined) {
  if (!reason) return "Not provided";
  return REASON_LABELS[reason] ?? "Other";
}

export function formatDisputeAmount(amountCents: number, currency: string) {
  const code = (currency || "usd").toUpperCase();
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: code }).format(
      amountCents / 100,
    );
  } catch {
    return `${(amountCents / 100).toFixed(2)} ${code}`;
  }
}

function formatDueDate(value: Date | null) {
  if (!value) return "See your Stripe Dashboard";
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "long",
    timeZone: "UTC",
  }).format(value);
}

export function buildPaymentDisputeOpenedStudioEmail(params: {
  studioName: string;
  studioLogoUrl?: string | null;
  amountCents: number;
  currency: string;
  reason: string | null;
  evidenceDueBy: Date | null;
}) {
  const amount = formatDisputeAmount(params.amountCents, params.currency);
  const reason = formatDisputeReason(params.reason);
  const dueDate = formatDueDate(params.evidenceDueBy);
  const subject = `Payment dispute opened: ${amount}`;
  const intro = `A customer disputed a ${amount} payment to ${params.studioName}.`;
  const bodyText = [
    intro,
    "",
    `Reason: ${reason}`,
    `Response due: ${dueDate}`,
    "",
    "Review and respond in your Stripe Dashboard before the due date. DanceFlow does not submit dispute evidence on your behalf.",
  ].join("\n");

  const bodyHtml = renderStudioBrandedEmail(
    { name: params.studioName, logoUrl: params.studioLogoUrl },
    {
      previewText: intro,
      eyebrow: "Payment dispute",
      heading: "A payment was disputed",
      intro,
      bodyText,
      detailRows: [
        { label: "Amount", value: amount },
        { label: "Reason", value: reason },
        { label: "Response due", value: dueDate },
      ],
      actionLabel: "Open Payments",
      actionUrl: buildAppUrl("/app/payments"),
      footerNote: `Internal notification for ${params.studioName} staff.`,
      dedupeBodyLeadIn: true,
    },
  );

  return { subject, bodyText, bodyHtml };
}
