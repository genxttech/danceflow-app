/**
 * G-02 (owner decision A1, "Rule 1") -- a paid event registration creates a studio CRM lead only when the studio has
 * explicitly flagged the registration's ticket type (event_ticket_types.creates_prospect_lead, default false).
 *
 * The database enforces the same rule: capture_event_registration_lead (migration 20270219090000) reads the flag, and a
 * CHECK makes the flag impossible for every kind except general_admission. A test pins the two together.
 * Pending owner decisions (A3: vip/other flaggable?) change ONLY LEAD_FLAGGABLE_TICKET_KINDS and the SQL CHECK.
 */
export const LEAD_FLAGGABLE_TICKET_KINDS = ["general_admission"] as const;

/** May a ticket of this kind be flagged "creates prospect lead"? (UI visibility and server-side normalisation) */
export function ticketKindMayCreateLeads(kind: string | null | undefined): boolean {
  const normalized = (kind ?? "").trim().toLowerCase();
  return (LEAD_FLAGGABLE_TICKET_KINDS as readonly string[]).includes(normalized);
}

/** The lead decision: flag set AND kind flaggable (defence in depth, mirrors the SQL CHECK + function). */
export function ticketCreatesLead(ticket: {
  ticket_kind?: string | null;
  creates_prospect_lead?: boolean | null;
} | null | undefined): boolean {
  return ticket?.creates_prospect_lead === true && ticketKindMayCreateLeads(ticket.ticket_kind);
}
