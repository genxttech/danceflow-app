import { formatWalletDate, type StudentTicket } from "@/lib/studentWallet";

/** Pass colours: a ticket is shown at the door, so it reads the same in both themes (white body, dark text). */
export const PASS = { body: "#FFFFFF", text: "#2B1B2A", muted: "#6F5B6B", rule: "#EAD9CB", ok: "#1F6B45" } as const;

/** What a screen reader hears for a ticket pass: the code is spelled out character by character. */
export function ticketAccessibilityLabel(ticket: StudentTicket) {
  return [
    ticket.eventName,
    [formatWalletDate(ticket.eventDate), ticket.eventTime].filter(Boolean).join(" at "),
    ticket.ticketName,
    ticket.ticketCode ? `Code ${ticket.ticketCode.split("").join(" ")}` : "Code not issued yet",
    ticket.checkedInAt ? "Checked in" : "Not checked in yet"
  ]
    .filter(Boolean)
    .join(". ");
}
