import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Per-ticket-type availability for ONE event, counted with the service role so it reflects every registration (not just the caller's).
 * The counting rule is the one the database enforces in public.enforce_event_ticket_capacity_holds() (the student checkout mirrors it):
 * an admission is consumed by a registration that is paid, or confirmed/checked_in/attended, or a pending registration held by a still-live
 * pending order (order pending/pending and expires_at null or in the future), or an orderless pending/pending registration whose terminal_hold_until
 * is still in the future (a card-reader hold). One registration uses quantity * attendees_per_ticket admissions.
 * Returns ONLY ids and numbers: no registration, attendee, order or email data.
 */

export type TicketAvailability = {
  ticketTypeId: string;
  capacity: number | null;
  remaining: number | null;
  soldOut: boolean;
};

export type EventAvailability = { eventId: string; tickets: TicketAvailability[] };

const PAGE = 1000;
const COUNTED_STATUSES = new Set(["confirmed", "checked_in", "attended"]);

type RegistrationRow = { ticket_type_id: string | null; quantity: number | null; status: string | null; payment_status: string | null; order_id: string | null; terminal_hold_until: string | null };
type OrderRow = { id: string; status: string | null; payment_status: string | null; expires_at: string | null };
type PageResult<T> = { data: T[] | null; error: { message: string } | null };

/** Only events the public event page shows: published and public/unlisted. */
export function eventIsPubliclyListed(event: { status?: string | null; visibility?: string | null } | null | undefined) {
  return Boolean(event && event.status === "published" && (event.visibility === "public" || event.visibility === "unlisted"));
}

async function pageAll<T>(fetchPage: (from: number, to: number) => PromiseLike<PageResult<T>>): Promise<T[]> {
  const out: T[] = [];
  // Advance by the rows actually returned and stop only on an empty page: if the API layer caps a response below PAGE (PostgREST max-rows),
  // a short page is not the last page, and stepping by PAGE would skip rows and under-count (overstating spots left).
  for (let from = 0; ; ) {
    const { data, error } = await fetchPage(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const rows = data ?? [];
    if (!rows.length) return out;
    out.push(...rows);
    from += rows.length;
  }
}

export async function loadEventAvailability(admin: SupabaseClient, eventId: string, now: Date = new Date()): Promise<EventAvailability | null> {
  const { data: event, error: eventError } = await admin.from("events").select("id, status, visibility").eq("id", eventId).maybeSingle();
  if (eventError) throw new Error(eventError.message);
  if (!event || !eventIsPubliclyListed(event as { status: string | null; visibility: string | null })) return null;

  const { data: ticketRows, error: ticketError } = await admin
    .from("event_ticket_types")
    .select("id, capacity, attendees_per_ticket")
    .eq("event_id", eventId)
    .eq("active", true)
    .order("id", { ascending: true });
  if (ticketError) throw new Error(ticketError.message);
  const tickets = (ticketRows ?? []) as { id: string; capacity: number | null; attendees_per_ticket: number | null }[];
  if (!tickets.length) return { eventId, tickets: [] };

  const perTicket = new Map(tickets.map((t) => [t.id, Math.max(1, Number(t.attendees_per_ticket ?? 1) || 1)]));
  const limited = tickets.filter((t) => t.capacity != null);
  const used = new Map<string, number>();

  if (limited.length) {
    const limitedIds = limited.map((t) => t.id);
    const regs = await pageAll<RegistrationRow>(
      (from, to) =>
        admin
          .from("event_registrations")
          .select("ticket_type_id, quantity, status, payment_status, order_id, terminal_hold_until")
          .in("ticket_type_id", limitedIds)
          .order("id", { ascending: true })
          .range(from, to) as unknown as PromiseLike<PageResult<RegistrationRow>>,
    );

    const heldOrderIds = Array.from(
      new Set(regs.filter((r) => r.status === "pending" && r.payment_status === "pending" && r.order_id).map((r) => r.order_id as string)),
    );
    const liveOrders = new Set<string>();
    for (let i = 0; i < heldOrderIds.length; i += 200) {
      const { data, error } = await admin.from("event_orders").select("id, status, payment_status, expires_at").in("id", heldOrderIds.slice(i, i + 200));
      if (error) throw new Error(error.message);
      for (const order of (data ?? []) as OrderRow[]) {
        if (order.status === "pending" && order.payment_status === "pending" && (!order.expires_at || new Date(order.expires_at).getTime() > now.getTime())) {
          liveOrders.add(order.id);
        }
      }
    }

    for (const r of regs) {
      if (!r.ticket_type_id) continue;
      const counted =
        r.payment_status === "paid" ||
        (r.status != null && COUNTED_STATUSES.has(r.status)) ||
        (r.status === "pending" && r.payment_status === "pending" && r.order_id != null && liveOrders.has(r.order_id)) ||
        (r.status === "pending" && r.payment_status === "pending" && r.order_id == null && r.terminal_hold_until != null && new Date(r.terminal_hold_until).getTime() > now.getTime());
      if (!counted) continue;
      const units = Math.max(1, Number(r.quantity ?? 1) || 1) * (perTicket.get(r.ticket_type_id) ?? 1);
      used.set(r.ticket_type_id, (used.get(r.ticket_type_id) ?? 0) + units);
    }
  }

  return {
    eventId,
    tickets: tickets.map((t) => {
      if (t.capacity == null) return { ticketTypeId: t.id, capacity: null, remaining: null, soldOut: false };
      const capacity = Number(t.capacity);
      const remaining = Math.max(0, capacity - (used.get(t.id) ?? 0));
      return { ticketTypeId: t.id, capacity, remaining, soldOut: remaining <= 0 };
    }),
  };
}
