/*
  Facts a ticket pass shows, derived from fields the wallet already reads. Pure, so they are unit
  tested on their own.
*/

export type TicketPaymentState = "paid" | "pending" | "free";

const PENDING_STATUSES = new Set(["pending", "unpaid", "partial", "due", "past_due"]);
const FREE_STATUSES = new Set(["waived", "no_payment_required"]);

/**
 * event_registrations.payment_status as the pass shows it. A zero total is free whatever the status.
 * Refunded, failed and unknown statuses return null: the pass then claims nothing about payment.
 */
export function ticketPaymentState(paymentStatus: string | null, totalAmount: number | null): TicketPaymentState | null {
  if (totalAmount === 0) return "free";
  const status = (paymentStatus ?? "").trim().toLowerCase();
  if (status === "paid") return "paid";
  if (FREE_STATUSES.has(status)) return "free";
  if (PENDING_STATUSES.has(status)) return "pending";
  return null;
}

export function ticketPaymentLabel(state: TicketPaymentState | null) {
  if (state === "paid") return "Paid";
  if (state === "pending") return "Payment pending";
  if (state === "free") return "Free";
  return null;
}

/** People a registration admits: quantity × attendees_per_ticket, each at least 1 (the checkout's rule). */
export function admitCount(quantity: number | null, attendeesPerTicket: number | null) {
  const perTicket = Math.max(1, Math.floor(Number(attendeesPerTicket ?? 1)) || 1);
  return Math.max(1, Math.floor(Number(quantity ?? 1)) || 1) * perTicket;
}

/** "First Last", or null when neither is set (the pass then names the ticket by its place). */
export function attendeeDisplayName(firstName: string | null, lastName: string | null) {
  const name = [firstName, lastName]
    .map((part) => (part ?? "").trim())
    .filter(Boolean)
    .join(" ");
  return name || null;
}
