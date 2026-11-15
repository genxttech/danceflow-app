/**
 * G-02 -- which paid event ticket kinds represent a prospective student and may create/refresh a studio CRM lead.
 *
 * The same list lives in SQL as public.event_ticket_kind_creates_lead (migration 20270219090000); a test pins the two
 * together. Default policy (audit D5): general admission and workshop yes; spectator, vendor, staff, table, pass, VIP,
 * competitor, other, unknown and "no ticket type" no (fail closed). Changing the policy is an owner decision: edit BOTH.
 */
export const LEAD_ELIGIBLE_TICKET_KINDS = ["general_admission", "workshop"] as const;

export function ticketKindCreatesLead(kind: string | null | undefined): boolean {
  const normalized = (kind ?? "").trim().toLowerCase();
  return (LEAD_ELIGIBLE_TICKET_KINDS as readonly string[]).includes(normalized);
}
