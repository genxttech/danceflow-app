import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { createTicketTypeAction, updateTicketTypeAction } from "./actions";

type TicketTypeRow = {
  id: string;
  name: string;
  description: string | null;
  ticket_kind: string;
  price: number | string;
  currency: string;
  capacity: number | null;
  sort_order: number;
  active: boolean;
  sale_starts_at: string | null;
  sale_ends_at: string | null;
};

function canManageTickets(params: {
    isPlatformAdmin: boolean;
  organizerUserRole: string | null;
}) {
  const {  isPlatformAdmin, organizerUserRole } = params;

  if (isPlatformAdmin) return true;

  if (organizerUserRole === "organizer_admin" || organizerUserRole === "organizer_staff") {
    return true;
  }

  return false;
}

function formatPrice(value: number | string, currency: string) {
  const amount = typeof value === "number" ? value : Number(value ?? 0);
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency || "USD",
  }).format(Number.isFinite(amount) ? amount : 0);
}

export default async function EventTicketsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const supabase = await createClient();
  const context = await getCurrentStudioContext();

  if (!context) {
    notFound();
  }

  const { studioId, isPlatformAdmin } = context;

  const { data: event, error: eventError } = await supabase
    .from("events")
    .select(`
      id,
      studio_id,
      organizer_id,
      name,
      slug,
      status,
      visibility
    `)
    .eq("id", id)
    .eq("studio_id", studioId)
    .single();

  if (eventError || !event) {
    notFound();
  }

  let organizerUserRole: string | null = null;

  if (event.organizer_id) {
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (user) {
      const { data: organizerUser } = await supabase
        .from("organizer_users")
        .select("role")
        .eq("organizer_id", event.organizer_id)
        .eq("user_id", user.id)
        .eq("active", true)
        .maybeSingle();

      organizerUserRole = organizerUser?.role ?? null;
    }
  }

  const canManage = canManageTickets({

    isPlatformAdmin: Boolean(isPlatformAdmin),
    organizerUserRole,
  });

  const { data: tickets, error: ticketsError } = await supabase
    .from("event_ticket_types")
    .select(`
      id,
      name,
      description,
      ticket_kind,
      price,
      currency,
      capacity,
      sort_order,
      active,
      sale_starts_at,
      sale_ends_at
    `)
    .eq("event_id", event.id)
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true });

  if (ticketsError) {
    throw new Error(`Failed to load tickets: ${ticketsError.message}`);
  }

  const ticketRows = (tickets ?? []) as TicketTypeRow[];

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
            Event Tickets
          </p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight text-slate-900">
            {event.name}
          </h1>
          <p className="mt-2 text-sm text-slate-600">
            Manage ticket types for this event.
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <Link
            href={`/app/events/${event.id}`}
            className="inline-flex items-center rounded-xl border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
          >
            Back to event
          </Link>
          <Link
            href={`/events/${event.slug}`}
            className="inline-flex items-center rounded-xl border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
          >
            View public page
          </Link>
        </div>
      </div>

      {!canManage ? (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-4 text-sm text-amber-900">
          You can view tickets, but your current role does not have permission to manage them.
        </div>
      ) : null}

      <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Current ticket types</h2>
            <p className="mt-1 text-sm text-slate-600">
              Add, reorder, and update pricing for public registration.
            </p>
          </div>
        </div>

        {ticketRows.length === 0 ? (
          <div className="mt-6 rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-4 py-8 text-sm text-slate-600">
            No ticket types yet.
          </div>
        ) : (
          <div className="mt-6 space-y-4">
            {ticketRows.map((ticket) => (
              <form
                key={ticket.id}
                action={updateTicketTypeAction}
                className="rounded-2xl border border-slate-200 p-4"
              >
                <input type="hidden" name="ticketId" value={ticket.id} />
                <input type="hidden" name="eventId" value={event.id} />

                <div className="grid gap-4 md:grid-cols-2">
                  <label className="space-y-2 text-sm">
                    <span className="font-medium text-slate-700">Ticket name</span>
                    <input
                      name="name"
                      defaultValue={ticket.name}
                      disabled={!canManage}
                      className="w-full rounded-xl border border-slate-300 px-3 py-2 outline-none ring-0"
                    />
                  </label>

                  <label className="space-y-2 text-sm">
                    <span className="font-medium text-slate-700">Ticket kind</span>
                    <select
                      name="ticketKind"
                      defaultValue={ticket.ticket_kind}
                      disabled={!canManage}
                      className="w-full rounded-xl border border-slate-300 px-3 py-2 outline-none ring-0"
                    >
                      <option value="general_admission">General admission</option>
                      <option value="vip">VIP</option>
                      <option value="package">Package</option>
                      <option value="pass">Pass</option>
                      <option value="other">Other</option>
                    </select>
                  </label>

                  <label className="space-y-2 text-sm md:col-span-2">
                    <span className="font-medium text-slate-700">Description</span>
                    <textarea
                      name="description"
                      defaultValue={ticket.description ?? ""}
                      disabled={!canManage}
                      rows={3}
                      className="w-full rounded-xl border border-slate-300 px-3 py-2 outline-none ring-0"
                    />
                  </label>

                  <label className="space-y-2 text-sm">
                    <span className="font-medium text-slate-700">Price</span>
                    <input
                      name="price"
                      type="number"
                      min="0"
                      step="0.01"
                      defaultValue={ticket.price}
                      disabled={!canManage}
                      className="w-full rounded-xl border border-slate-300 px-3 py-2 outline-none ring-0"
                    />
                  </label>

                  <label className="space-y-2 text-sm">
                    <span className="font-medium text-slate-700">Currency</span>
                    <input
                      name="currency"
                      defaultValue={ticket.currency}
                      disabled={!canManage}
                      className="w-full rounded-xl border border-slate-300 px-3 py-2 outline-none ring-0"
                    />
                  </label>

                  <label className="space-y-2 text-sm">
                    <span className="font-medium text-slate-700">Capacity</span>
                    <input
                      name="capacity"
                      type="number"
                      min="0"
                      defaultValue={ticket.capacity ?? ""}
                      disabled={!canManage}
                      className="w-full rounded-xl border border-slate-300 px-3 py-2 outline-none ring-0"
                    />
                  </label>

                  <label className="space-y-2 text-sm">
                    <span className="font-medium text-slate-700">Sort order</span>
                    <input
                      name="sortOrder"
                      type="number"
                      min="0"
                      defaultValue={ticket.sort_order}
                      disabled={!canManage}
                      className="w-full rounded-xl border border-slate-300 px-3 py-2 outline-none ring-0"
                    />
                  </label>

                  <label className="space-y-2 text-sm">
                    <span className="font-medium text-slate-700">Sale starts</span>
                    <input
                      name="saleStartsAt"
                      type="datetime-local"
                      defaultValue={ticket.sale_starts_at?.slice(0, 16) ?? ""}
                      disabled={!canManage}
                      className="w-full rounded-xl border border-slate-300 px-3 py-2 outline-none ring-0"
                    />
                  </label>

                  <label className="space-y-2 text-sm">
                    <span className="font-medium text-slate-700">Sale ends</span>
                    <input
                      name="saleEndsAt"
                      type="datetime-local"
                      defaultValue={ticket.sale_ends_at?.slice(0, 16) ?? ""}
                      disabled={!canManage}
                      className="w-full rounded-xl border border-slate-300 px-3 py-2 outline-none ring-0"
                    />
                  </label>

                  <label className="inline-flex items-center gap-2 text-sm text-slate-700">
                    <input
                      name="active"
                      type="checkbox"
                      defaultChecked={ticket.active}
                      disabled={!canManage}
                      className="h-4 w-4 rounded border-slate-300"
                    />
                    Active
                  </label>
                </div>

                <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                  <p className="text-sm text-slate-500">
                    Current price: {formatPrice(ticket.price, ticket.currency)}
                  </p>

                  {canManage ? (
                    <button
                      type="submit"
                      className="inline-flex items-center rounded-xl bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-800"
                    >
                      Save changes
                    </button>
                  ) : null}
                </div>
              </form>
            ))}
          </div>
        )}
      </section>

      {canManage ? (
        <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Add ticket type</h2>
            <p className="mt-1 text-sm text-slate-600">
              Create pricing options for registration on the public event page.
            </p>
          </div>

          <form action={createTicketTypeAction} className="mt-6 grid gap-4 md:grid-cols-2">
            <input type="hidden" name="eventId" value={event.id} />

            <label className="space-y-2 text-sm">
              <span className="font-medium text-slate-700">Ticket name</span>
              <input
                name="name"
                required
                className="w-full rounded-xl border border-slate-300 px-3 py-2 outline-none ring-0"
                placeholder="General Admission"
              />
            </label>

            <label className="space-y-2 text-sm">
              <span className="font-medium text-slate-700">Ticket kind</span>
              <select
                name="ticketKind"
                defaultValue="general_admission"
                className="w-full rounded-xl border border-slate-300 px-3 py-2 outline-none ring-0"
              >
                <option value="general_admission">General admission</option>
                <option value="vip">VIP</option>
                <option value="package">Package</option>
                <option value="pass">Pass</option>
                <option value="other">Other</option>
              </select>
            </label>

            <label className="space-y-2 text-sm md:col-span-2">
              <span className="font-medium text-slate-700">Description</span>
              <textarea
                name="description"
                rows={3}
                className="w-full rounded-xl border border-slate-300 px-3 py-2 outline-none ring-0"
                placeholder="Optional details about this ticket"
              />
            </label>

            <label className="space-y-2 text-sm">
              <span className="font-medium text-slate-700">Price</span>
              <input
                name="price"
                type="number"
                min="0"
                step="0.01"
                defaultValue="0"
                className="w-full rounded-xl border border-slate-300 px-3 py-2 outline-none ring-0"
              />
            </label>

            <label className="space-y-2 text-sm">
              <span className="font-medium text-slate-700">Currency</span>
              <input
                name="currency"
                defaultValue="USD"
                className="w-full rounded-xl border border-slate-300 px-3 py-2 outline-none ring-0"
              />
            </label>

            <label className="space-y-2 text-sm">
              <span className="font-medium text-slate-700">Capacity</span>
              <input
                name="capacity"
                type="number"
                min="0"
                className="w-full rounded-xl border border-slate-300 px-3 py-2 outline-none ring-0"
                placeholder="Optional"
              />
            </label>

            <label className="space-y-2 text-sm">
              <span className="font-medium text-slate-700">Sort order</span>
              <input
                name="sortOrder"
                type="number"
                min="0"
                defaultValue="0"
                className="w-full rounded-xl border border-slate-300 px-3 py-2 outline-none ring-0"
              />
            </label>

            <label className="space-y-2 text-sm">
              <span className="font-medium text-slate-700">Sale starts</span>
              <input
                name="saleStartsAt"
                type="datetime-local"
                className="w-full rounded-xl border border-slate-300 px-3 py-2 outline-none ring-0"
              />
            </label>

            <label className="space-y-2 text-sm">
              <span className="font-medium text-slate-700">Sale ends</span>
              <input
                name="saleEndsAt"
                type="datetime-local"
                className="w-full rounded-xl border border-slate-300 px-3 py-2 outline-none ring-0"
              />
            </label>

            <label className="inline-flex items-center gap-2 text-sm text-slate-700 md:col-span-2">
              <input
                name="active"
                type="checkbox"
                defaultChecked
                className="h-4 w-4 rounded border-slate-300"
              />
              Active
            </label>

            <div className="md:col-span-2">
              <button
                type="submit"
                className="inline-flex items-center rounded-xl bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-800"
              >
                Add ticket type
              </button>
            </div>
          </form>
        </section>
      ) : null}
    </div>
  );
}