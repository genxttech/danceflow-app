import { formatWalletDate, type StudentTicket } from "@/lib/studentWallet";
import { ticketPaymentLabel } from "@/lib/ticketFacts";

/** Pass colours: a ticket is shown at the door, so it reads the same in both themes (white body, dark text). */
export const PASS = { body: "#FFFFFF", text: "#2B1B2A", muted: "#6F5B6B", rule: "#EAD9CB", ok: "#1F6B45" } as const;

/** Who the pass is for: the attendee's name, else the ticket's place ("Ticket 2"). */
export function ticketHolder(ticket: StudentTicket) {
  return ticket.attendeeName ?? ticket.ticketName;
}

/** "2 of 4" when the registration admits more than one person; null for a single admission. */
export function admitLine(ticket: StudentTicket) {
  return ticket.admitTotal > 1 ? `${ticket.admitPosition} of ${ticket.admitTotal}` : null;
}

/** The event's start, as date and time; there is no separate doors time. */
export function ticketWhen(ticket: StudentTicket, separator = " · ") {
  return [formatWalletDate(ticket.eventDate), ticket.eventTime].filter(Boolean).join(separator);
}

/** What a screen reader hears for a ticket pass: the code is spelled out character by character. */
export function ticketAccessibilityLabel(ticket: StudentTicket) {
  const admits = admitLine(ticket);
  return [
    ticket.eventName,
    ticketWhen(ticket, " at "),
    ticketHolder(ticket),
    admits ? `Admission ${admits}` : null,
    ticketPaymentLabel(ticket.paymentState),
    ticket.ticketCode ? `Code ${ticket.ticketCode.split("").join(" ")}` : "Code not issued yet",
    ticket.checkedInAt ? "Checked in" : "Not checked in yet"
  ]
    .filter(Boolean)
    .join(". ");
}
