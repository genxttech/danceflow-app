import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import {
  createTicketTypeAction,
  updateTicketTypeAction,
} from "./tickets/actions";

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
  attendees_per_ticket: number | null;
};

type EventRow = {
  id: string;
  studio_id: string;
  organizer_id: string | null;
  name: string;
  slug: string;
  status: string;
  visibility: string;
};

function canManageTickets(params: {
  isPlatformAdmin: boolean;
  organizerUserRole: string | null;
  studioRole: string | null;
  isStudioHosted: boolean;
}) {
  const { isPlatformAdmin, organizerUserRole, studioRole, isStudioHosted } = params;

  if (isPlatformAdmin) return true;

  if (["organizer_owner", "organizer_admin", "organizer_staff"].includes(organizerUserRole ?? "")) {
    return true;
  }

  if (isStudioHosted && ["studio_owner", "studio_admin"].includes(studioRole ?? "")) {
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

function ticketStatusLabel(ticket: TicketTypeRow) {
  const now = Date.now();

  if (!ticket.active) {
    return {
      label: "Inactive",
      className: "bg-slate-100 text-slate-700 border border-slate-200",
    };
  }

  if (ticket.sale_starts_at && new Date(ticket.sale_starts_at).getTime() > now) {
    return {
      label: "Scheduled",
      className: "bg-blue-50 text-blue-700 border border-blue-200",
    };
  }

  if (ticket.sale_ends_at && new Date(ticket.sale_ends_at).getTime() < now) {
    return {
      label: "Ended",
      className: "bg-slate-100 text-slate-700 border border-slate-200",
    };
  }

  return {
    label: "On sale",
    className: "bg-emerald-50 text-emerald-700 border border-emerald-200",
  };
}

function formatTicketKind(value: string) {
  return value
    .replaceAll("_", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function formatDateTime(value: string | null) {
  if (!value) return "Not set";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not set";

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

export default async function EventTicketsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const context = await getCurrentStudioContext();

  if (!context) {
    notFound();
  }

  const { studioId, studioRole, isPlatformAdmin } = context;

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

  const typedEvent = event as EventRow;
  const isStudioHosted = !typedEvent.organizer_id;

  let organizerUserRole: string | null = null;

  if (typedEvent.organizer_id) {
    const { data: organizerUser } = await supabase
      .from("organizer_users")
      .select("role")
      .eq("organizer_id", typedEvent.organizer_id)
      .eq("user_id", user.id)
      .eq("active", true)
      .maybeSingle();

    organizerUserRole = organizerUser?.role ?? null;
  }

  const canManage = canManageTickets({
    isPlatformAdmin: Boolean(isPlatformAdmin),
    organizerUserRole,
    studioRole: studioRole ?? null,
    isStudioHosted,
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
      sale_ends_at,
      attendees_per_ticket
    `)
    .eq("event_id", typedEvent.id)
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true });

  if (ticketsError) {
    throw new Error(`Failed to load tickets: ${ticketsError.message}`);
  }

  const ticketRows = (tickets ?? []) as TicketTypeRow[];
  const activeCount = ticketRows.filter((ticket) => ticket.active).length;

  return (
    <div className="space-y-6">
      <section className="overflow-hidden rounded-[28px] border border-[#E9D5FF] bg-gradient-to-r from-[#2D0B45] via-[#5B197A] to-[#7C2D92] text-white shadow-sm">
        <div className="flex flex-col gap-6 px-6 py-6 md:flex-row md:items-start md:justify-between md:px-8">
          <div className="max-w-3xl">
            <p className="text-xs font-semibold uppercase tracking-[0.28em] text-[#F3D7FF]">
              Event ticket setup
            </p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight md:text-4xl">
              Manage tickets for {typedEvent.name}
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-white/85 md:text-base">
              Build ticket options, set pricing, and control when sales open and close so your
              public registration flow is ready for dancers.
            </p>
          </div>

          <div className="flex flex-wrap gap-3">
            <Link
              href="/app/events"
              className="inline-flex items-center rounded-xl border border-white/20 bg-white/10 px-4 py-2 text-sm font-medium text-white transition hover:bg-white/20"
            >
              Back to Events
            </Link>
            <Link
              href={`/app/events/${typedEvent.id}/edit`}
              className="inline-flex items-center rounded-xl border border-white/20 bg-white/10 px-4 py-2 text-sm font-medium text-white transition hover:bg-white/20"
            >
              Edit Event
            </Link>
            <Link
              href={`/app/events/${typedEvent.id}/tickets`}
              className="inline-flex items-center rounded-xl border border-white/20 bg-white/10 px-4 py-2 text-sm font-medium text-white transition hover:bg-white/20"
            >
              Manage Tickets
            </Link>
            <Link
              href={`/app/events/${typedEvent.id}/registrations`}
              className="inline-flex items-center rounded-xl border border-white/20 bg-white/10 px-4 py-2 text-sm font-medium text-white transition hover:bg-white/20"
            >
              Manage registrations
            </Link>
            <Link
              href={`/events/${typedEvent.slug}`}
              className="inline-flex items-center rounded-xl bg-white px-4 py-2 text-sm font-semibold text-[#5B197A] transition hover:bg-[#F9F1FF]"
            >
              View public page
            </Link>
          </div>
        </div>

        <div className="grid gap-3 border-t border-white/10 bg-black/10 px-6 py-4 md:grid-cols-4 md:px-8">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-white/65">Event status</p>
            <p className="mt-1 text-sm font-semibold capitalize">{typedEvent.status}</p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-white/65">Visibility</p>
            <p className="mt-1 text-sm font-semibold capitalize">
              {typedEvent.visibility.replaceAll("_", " ")}
            </p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-white/65">Ticket types</p>
            <p className="mt-1 text-sm font-semibold">{ticketRows.length}</p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-white/65">Currently active</p>
            <p className="mt-1 text-sm font-semibold">{activeCount}</p>
          </div>
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
        <div className="rounded-3xl border border-[#E9D5FF] bg-[#FCF8FF] p-5 shadow-sm">
          <h2 className="text-lg font-semibold text-slate-900">Quick tips</h2>
          <div className="mt-4 grid gap-3 md:grid-cols-3">
            <div className="rounded-2xl border border-[#E9D5FF] bg-white p-4">
              <p className="text-sm font-semibold text-slate-900">Keep pricing simple</p>
              <p className="mt-2 text-sm leading-6 text-slate-600">
                Start with your main ticket first. Add VIP, package, or pass options only when they
                make the buying flow clearer.
              </p>
            </div>
            <div className="rounded-2xl border border-[#E9D5FF] bg-white p-4">
              <p className="text-sm font-semibold text-slate-900">Use sale windows</p>
              <p className="mt-2 text-sm leading-6 text-slate-600">
                Set open and close dates if you want early access, presale timing, or ticket sales
                to stop before the event starts.
              </p>
            </div>
            <div className="rounded-2xl border border-[#E9D5FF] bg-white p-4">
              <p className="text-sm font-semibold text-slate-900">Control availability</p>
              <p className="mt-2 text-sm leading-6 text-slate-600">
                Use capacity and the active toggle to control what dancers can buy without deleting
                older ticket types.
              </p>
            </div>
          </div>
        </div>

        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="text-lg font-semibold text-slate-900">Access</h2>
          {canManage ? (
            <p className="mt-2 text-sm leading-6 text-slate-600">
              You can manage ticket types for this event. Changes here update what dancers see when
              they register on the public event page.
            </p>
          ) : (
            <p className="mt-2 text-sm leading-6 text-slate-600">
              You can view ticket setup for this event, but your current role does not have
              permission to make changes.
            </p>
          )}

          <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
            <p>
              <span className="font-medium text-slate-900">Hosted as:</span>{" "}
              {isStudioHosted ? "Studio-hosted event" : "Organizer-hosted event"}
            </p>
            <p className="mt-2">
              <span className="font-medium text-slate-900">Current role:</span>{" "}
              {isPlatformAdmin
                ? "Platform admin"
                : organizerUserRole ?? studioRole ?? "Viewer"}
            </p>
          </div>
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
              Update pricing, availability, and sales timing for each ticket option.
            </p>
          </div>
        </div>

        {ticketRows.length === 0 ? (
          <div className="mt-6 rounded-2xl border border-dashed border-[#D8B4FE] bg-[#FCF8FF] px-4 py-8 text-sm text-slate-600">
            No ticket types yet. Add your first ticket option below to start selling registrations.
          </div>
        ) : (
          <div className="mt-6 space-y-4">
            {ticketRows.map((ticket) => {
              const status = ticketStatusLabel(ticket);

              return (
                <form
                  key={ticket.id}
                  action={updateTicketTypeAction}
                  className="rounded-2xl border border-slate-200 p-4"
                >
                  <input type="hidden" name="ticketId" value={ticket.id} />
                  <input type="hidden" name="eventId" value={typedEvent.id} />

                  <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded-full bg-[#F3E8FF] px-3 py-1 text-xs font-medium text-[#6B21A8]">
                        {formatTicketKind(ticket.ticket_kind)}
                      </span>
                      <span className={`rounded-full px-3 py-1 text-xs font-medium ${status.className}`}>
                        {status.label}
                      </span>
                    </div>

                    <p className="text-sm text-slate-500">
                      Current price: {formatPrice(ticket.price, ticket.currency)}
                    </p>
                  </div>

                  <div className="mb-4 grid gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-4 md:grid-cols-4">
                    <div>
                      <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Capacity</p>
                      <p className="mt-1 text-sm font-medium text-slate-900">
                        {ticket.capacity ?? "Unlimited"}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Admits</p>
                      <p className="mt-1 text-sm font-medium text-slate-900">
                        {Math.max(1, Number(ticket.attendees_per_ticket ?? 1) || 1)}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Sale starts</p>
                      <p className="mt-1 text-sm font-medium text-slate-900">
                        {formatDateTime(ticket.sale_starts_at)}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Sale ends</p>
                      <p className="mt-1 text-sm font-medium text-slate-900">
                        {formatDateTime(ticket.sale_ends_at)}
                      </p>
                    </div>
                  </div>

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
                      <span className="font-medium text-slate-700">Ticket type</span>
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
                      <span className="font-medium text-slate-700">Attendees per ticket</span>
                      <input
                        name="attendeesPerTicket"
                        type="number"
                        min="1"
                        max="20"
                        defaultValue={Math.max(1, Number(ticket.attendees_per_ticket ?? 1) || 1)}
                        disabled={!canManage}
                        className="w-full rounded-xl border border-slate-300 px-3 py-2 outline-none ring-0"
                      />
                      <span className="block text-xs text-slate-500">
                        Use 2 for couple tickets, 8 for a table of 8, etc.
                      </span>
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

                  <div className="mt-4 flex flex-wrap items-center justify-end gap-3">
                    {canManage ? (
                      <button
                        type="submit"
                        className="inline-flex items-center rounded-xl bg-[#5B197A] px-4 py-2 text-sm font-medium text-white transition hover:bg-[#4A1363]"
                      >
                        Save changes
                      </button>
                    ) : null}
                  </div>
                </form>
              );
            })}
          </div>
        )}
      </section>

      {canManage ? (
        <section className="rounded-3xl border border-[#E9D5FF] bg-[#FCF8FF] p-6 shadow-sm">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#7C2D92]">
              Create ticket option
            </p>
            <h2 className="mt-1 text-xl font-semibold text-slate-900">Add ticket type</h2>
            <p className="mt-1 text-sm text-slate-600">
              Create pricing options for registration on the public event page.
            </p>
          </div>

          <form action={createTicketTypeAction} className="mt-6 grid gap-4 md:grid-cols-2">
            <input type="hidden" name="eventId" value={typedEvent.id} />

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
              <span className="font-medium text-slate-700">Ticket type</span>
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
              <span className="font-medium text-slate-700">Attendees per ticket</span>
              <input
                name="attendeesPerTicket"
                type="number"
                min="1"
                max="20"
                defaultValue="1"
                className="w-full rounded-xl border border-slate-300 px-3 py-2 outline-none ring-0"
              />
              <span className="block text-xs text-slate-500">
                Use 2 for couple tickets, 8 for a table of 8, etc.
              </span>
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

            <div className="md:col-span-2 flex justify-end">
              <button
                type="submit"
                className="inline-flex items-center rounded-xl bg-[#5B197A] px-4 py-2 text-sm font-medium text-white transition hover:bg-[#4A1363]"
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

