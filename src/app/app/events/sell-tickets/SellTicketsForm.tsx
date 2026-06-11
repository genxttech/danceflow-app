"use client";

import { useActionState, useEffect, useMemo, useState } from "react";
import { sellTicketsAction, type SellTicketsState } from "./actions";

type TicketTypeOption = {
  id: string;
  event_id: string;
  name: string;
  price: number | string;
  currency: string;
  capacity: number | null;
  active: boolean;
  soldQuantity: number;
  attendees_per_ticket: number | null;
};

type EventOption = {
  id: string;
  name: string;
  status: string;
  start_date: string;
  start_time: string | null;
  ticketTypes: TicketTypeOption[];
};

type ClientOption = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
};

type AttendeeDraft = {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
};

const emptyAttendee = (): AttendeeDraft => ({
  firstName: "",
  lastName: "",
  email: "",
  phone: "",
});

function formatMoney(value: number | string, currency: string) {
  const amount =
    typeof value === "number" ? value : Number.parseFloat(String(value ?? "0"));

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency || "USD",
  }).format(Number.isFinite(amount) ? amount : 0);
}

function formatEventDate(event: EventOption) {
  const dateLabel = event.start_date
    ? new Intl.DateTimeFormat("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      }).format(new Date(`${event.start_date}T00:00:00`))
    : "Date not set";

  return event.start_time ? `${dateLabel} at ${event.start_time}` : dateLabel;
}

function clientLabel(client: ClientOption) {
  const name = [client.first_name, client.last_name].filter(Boolean).join(" ");
  return name || client.email || "Unnamed client";
}

function remainingLabel(ticket: TicketTypeOption) {
  if (ticket.capacity === null || ticket.capacity === undefined) {
    return "Unlimited";
  }

  return `${Math.max(Number(ticket.capacity) - ticket.soldQuantity, 0)} remaining`;
}

export default function SellTicketsForm({
  events,
  clients,
}: {
  events: EventOption[];
  clients: ClientOption[];
}) {
  const [state, formAction, pending] = useActionState<SellTicketsState, FormData>(
    sellTicketsAction,
    {}
  );

  const [eventId, setEventId] = useState(events[0]?.id ?? "");
  const [ticketTypeId, setTicketTypeId] = useState("");
  const [clientId, setClientId] = useState("");
  const [quantity, setQuantity] = useState(1);
  const [paymentMethod, setPaymentMethod] = useState("cash");
  const [attendees, setAttendees] = useState<AttendeeDraft[]>([emptyAttendee()]);

  const selectedEvent = useMemo(
    () => events.find((event) => event.id === eventId) ?? null,
    [events, eventId]
  );

  const ticketTypes = selectedEvent?.ticketTypes ?? [];

  const selectedTicket = useMemo(
    () => ticketTypes.find((ticket) => ticket.id === ticketTypeId) ?? null,
    [ticketTypes, ticketTypeId]
  );

  const selectedClient = useMemo(
    () => clients.find((client) => client.id === clientId) ?? null,
    [clients, clientId]
  );

  const unitPrice =
    selectedTicket && paymentMethod !== "comp"
      ? Number.parseFloat(String(selectedTicket.price ?? "0"))
      : 0;

  const total = Number.isFinite(unitPrice) ? unitPrice * quantity : 0;
  const attendeesPerTicket = Math.max(
    1,
    Number(selectedTicket?.attendees_per_ticket ?? 1) || 1
  );
  const totalAttendees = Math.max(1, quantity * attendeesPerTicket);

  useEffect(() => {
    setAttendees((current) => {
      const next = [...current];

      while (next.length < totalAttendees) {
        next.push(emptyAttendee());
      }

      return next.slice(0, totalAttendees);
    });
  }, [totalAttendees]);

  function updateAttendee(
    index: number,
    field: keyof AttendeeDraft,
    value: string
  ) {
    setAttendees((current) => {
      const next = [...current];
      next[index] = { ...(next[index] ?? emptyAttendee()), [field]: value };
      return next;
    });
  }

  function applyClient(nextClientId: string) {
    setClientId(nextClientId);

    const client = clients.find((item) => item.id === nextClientId);

    if (!client) return;

    setAttendees((current) => {
      const next = current.length > 0 ? [...current] : [emptyAttendee()];
      next[0] = {
        ...(next[0] ?? emptyAttendee()),
        firstName: client.first_name ?? "",
        lastName: client.last_name ?? "",
        email: client.email ?? "",
        phone: client.phone ?? "",
      };
      return next;
    });
  }

  return (
    <form action={formAction} className="space-y-6">
      {state.error ? (
        <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {state.error}
        </div>
      ) : null}

      <input type="hidden" name="eventId" value={eventId} />
      <input type="hidden" name="ticketTypeId" value={ticketTypeId} />
      <input type="hidden" name="clientId" value={clientId} />
      <input type="hidden" name="quantity" value={quantity} />
      <input type="hidden" name="paymentMethod" value={paymentMethod} />

      <section className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm md:p-6">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-violet-700">
          Sale Details
        </p>
        <h2 className="mt-2 text-2xl font-semibold text-slate-950">
          Choose the event and ticket
        </h2>

        <div className="mt-5 grid gap-5 md:grid-cols-2">
          <div>
            <label htmlFor="eventIdVisible" className="text-sm font-medium text-slate-700">
              Event *
            </label>
            <select
              id="eventIdVisible"
              value={eventId}
              onChange={(event) => {
                setEventId(event.target.value);
                setTicketTypeId("");
              }}
              className="mt-2 w-full rounded-xl border border-slate-300 px-3 py-3 text-sm outline-none focus:border-violet-500"
              required
            >
              {events.length === 0 ? (
                <option value="">No events available</option>
              ) : null}

              {events.map((event) => (
                <option key={event.id} value={event.id}>
                  {event.name} — {formatEventDate(event)}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label
              htmlFor="ticketTypeIdVisible"
              className="text-sm font-medium text-slate-700"
            >
              Ticket type *
            </label>
            <select
              id="ticketTypeIdVisible"
              value={ticketTypeId}
              onChange={(event) => setTicketTypeId(event.target.value)}
              className="mt-2 w-full rounded-xl border border-slate-300 px-3 py-3 text-sm outline-none focus:border-violet-500"
              required
            >
              <option value="">Choose ticket type</option>
              {ticketTypes.map((ticket) => (
                <option key={ticket.id} value={ticket.id}>
                  {ticket.name} — {formatMoney(ticket.price, ticket.currency)} —{" "}
                  {remainingLabel(ticket)}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="quantityVisible" className="text-sm font-medium text-slate-700">
              Quantity *
            </label>
            <input
              id="quantityVisible"
              type="number"
              min="1"
              value={quantity}
              onChange={(event) =>
                setQuantity(Math.max(Number.parseInt(event.target.value || "1", 10), 1))
              }
              className="mt-2 w-full rounded-xl border border-slate-300 px-3 py-3 text-sm outline-none focus:border-violet-500"
              required
            />
          </div>

          <div>
            <label
              htmlFor="paymentMethodVisible"
              className="text-sm font-medium text-slate-700"
            >
              Payment method *
            </label>
            <select
              id="paymentMethodVisible"
              value={paymentMethod}
              onChange={(event) => setPaymentMethod(event.target.value)}
              className="mt-2 w-full rounded-xl border border-slate-300 px-3 py-3 text-sm outline-none focus:border-violet-500"
              required
            >
              <option value="cash">Cash</option>
              <option value="external_card">Card collected outside DanceFlow</option>
              <option value="check">Check</option>
              <option value="comp">Comp / no charge</option>
              <option value="other">Other</option>
            </select>
          </div>
        </div>

        <div className="mt-5 rounded-2xl border border-violet-100 bg-violet-50 p-4">
          <p className="text-sm font-semibold text-violet-950">Sale total</p>
          <p className="mt-1 text-3xl font-semibold text-violet-950">
            {formatMoney(total, selectedTicket?.currency ?? "USD")}
          </p>
          <p className="mt-1 text-sm text-violet-800">
            {selectedTicket
              ? `${quantity} × ${formatMoney(unitPrice, selectedTicket.currency)} · ${attendeesPerTicket} admitted per ticket · ${totalAttendees} QR ticket${totalAttendees === 1 ? "" : "s"}`
              : "Choose a ticket to calculate the total."}
          </p>
        </div>
      </section>

      <section className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm md:p-6">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-violet-700">
          Purchaser
        </p>
        <h2 className="mt-2 text-2xl font-semibold text-slate-950">
          Link a client or enter attendee info
        </h2>

        <div className="mt-5">
          <label htmlFor="clientIdVisible" className="text-sm font-medium text-slate-700">
            Existing client optional
          </label>
          <select
            id="clientIdVisible"
            value={clientId}
            onChange={(event) => applyClient(event.target.value)}
            className="mt-2 w-full rounded-xl border border-slate-300 px-3 py-3 text-sm outline-none focus:border-violet-500"
          >
            <option value="">No linked client</option>
            {clients.map((client) => (
              <option key={client.id} value={client.id}>
                {clientLabel(client)}
                {client.email ? ` — ${client.email}` : ""}
              </option>
            ))}
          </select>

          {selectedClient ? (
            <p className="mt-2 text-sm text-slate-500">
              This sale will be linked to {clientLabel(selectedClient)}.
            </p>
          ) : null}
        </div>

        <div className="mt-5 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          {selectedTicket ? (
            <p>
              <span className="font-semibold">{selectedTicket.name}</span> admits {attendeesPerTicket} per ticket.
              This sale will create <span className="font-semibold">{totalAttendees}</span> QR ticket{totalAttendees === 1 ? "" : "s"}.
            </p>
          ) : (
            <p>Choose a ticket type to see how many attendee names are needed.</p>
          )}
        </div>

        <div className="mt-5 space-y-4">
          {attendees.map((attendee, index) => {
            const slot = index + 1;
            const suffix = slot === 1 ? "" : `_${slot}`;

            return (
              <div
                key={slot}
                className="rounded-2xl border border-slate-200 bg-slate-50 p-4"
              >
                <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="text-sm font-semibold text-slate-950">
                      Attendee {slot}
                    </p>
                    <p className="text-xs text-slate-500">
                      {slot === 1
                        ? "Primary purchaser and first QR ticket."
                        : "Additional admitted guest with their own QR ticket."}
                    </p>
                  </div>
                  {slot > 1 ? (
                    <span className="rounded-full bg-violet-100 px-3 py-1 text-xs font-semibold text-violet-800">
                      Additional QR ticket
                    </span>
                  ) : null}
                </div>

                <div className="mt-4 grid gap-4 md:grid-cols-2">
                  <div>
                    <label
                      htmlFor={`attendeeFirstName${suffix || "_1"}`}
                      className="text-sm font-medium text-slate-700"
                    >
                      First name *
                    </label>
                    <input
                      id={`attendeeFirstName${suffix || "_1"}`}
                      name={`attendeeFirstName${suffix}`}
                      value={attendee.firstName}
                      onChange={(event) =>
                        updateAttendee(index, "firstName", event.target.value)
                      }
                      className="mt-2 w-full rounded-xl border border-slate-300 bg-white px-3 py-3 text-sm outline-none focus:border-violet-500"
                      required
                    />
                  </div>

                  <div>
                    <label
                      htmlFor={`attendeeLastName${suffix || "_1"}`}
                      className="text-sm font-medium text-slate-700"
                    >
                      Last name *
                    </label>
                    <input
                      id={`attendeeLastName${suffix || "_1"}`}
                      name={`attendeeLastName${suffix}`}
                      value={attendee.lastName}
                      onChange={(event) =>
                        updateAttendee(index, "lastName", event.target.value)
                      }
                      className="mt-2 w-full rounded-xl border border-slate-300 bg-white px-3 py-3 text-sm outline-none focus:border-violet-500"
                      required
                    />
                  </div>

                  <div>
                    <label
                      htmlFor={`attendeeEmail${suffix || "_1"}`}
                      className="text-sm font-medium text-slate-700"
                    >
                      Email {slot === 1 ? "*" : ""}
                    </label>
                    <input
                      id={`attendeeEmail${suffix || "_1"}`}
                      name={`attendeeEmail${suffix}`}
                      type="email"
                      value={attendee.email}
                      onChange={(event) =>
                        updateAttendee(index, "email", event.target.value)
                      }
                      className="mt-2 w-full rounded-xl border border-slate-300 bg-white px-3 py-3 text-sm outline-none focus:border-violet-500"
                      required={slot === 1}
                    />
                    {slot > 1 ? (
                      <p className="mt-1 text-xs text-slate-500">
                        Leave blank to use the purchaser email for delivery.
                      </p>
                    ) : null}
                  </div>

                  <div>
                    <label
                      htmlFor={`attendeePhone${suffix || "_1"}`}
                      className="text-sm font-medium text-slate-700"
                    >
                      Phone
                    </label>
                    <input
                      id={`attendeePhone${suffix || "_1"}`}
                      name={`attendeePhone${suffix}`}
                      value={attendee.phone}
                      onChange={(event) =>
                        updateAttendee(index, "phone", event.target.value)
                      }
                      className="mt-2 w-full rounded-xl border border-slate-300 bg-white px-3 py-3 text-sm outline-none focus:border-violet-500"
                    />
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <div className="mt-5">
          <label htmlFor="notes" className="text-sm font-medium text-slate-700">
            Notes
          </label>
          <textarea
            id="notes"
            name="notes"
            rows={4}
            placeholder="Optional notes about the sale, comp reason, cash receipt, or staff handoff."
            className="mt-2 w-full rounded-xl border border-slate-300 px-3 py-3 text-sm outline-none focus:border-violet-500"
          />
        </div>
      </section>

      <div className="flex justify-end">
        <button
          type="submit"
          disabled={pending || events.length === 0}
          className="rounded-xl bg-violet-700 px-5 py-3 text-sm font-semibold text-white shadow-sm hover:bg-violet-800 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {pending ? "Saving sale..." : "Complete Ticket Sale"}
        </button>
      </div>
    </form>
  );
}