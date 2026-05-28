"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

type SelectedCoachSlotSummary = {
  id: string;
  coachName: string;
  slotLabel: string;
  price: number;
};


type TicketTypeRow = {
  id: string;
  name: string;
  description: string | null;
  ticket_kind: string;
  price: number;
  currency: string;
  capacity: number | null;
  active: boolean;
  sale_starts_at: string | null;
  sale_ends_at: string | null;
  early_bird_enabled: boolean | null;
  early_bird_price: number | null;
  early_bird_ends_at: string | null;
  attendees_per_ticket: number | null;
};

type RegistrationFormProps = {
  eventSlug: string;
  ticketTypes: TicketTypeRow[];
  currentUserEmail?: string;
  isSoldOut?: boolean;
  waitlistEnabled?: boolean;
  accountRequiredForRegistration?: boolean;
  isAuthenticated?: boolean;
};

function formatCurrency(value: number, currency: string) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency || "USD",
  }).format(Number(value ?? 0));
}

function isEarlyBirdActive(ticket: TicketTypeRow) {
  const earlyBirdPrice =
    ticket.early_bird_price == null ? null : Number(ticket.early_bird_price);
  const earlyBirdEndsAt = ticket.early_bird_ends_at
    ? new Date(ticket.early_bird_ends_at).getTime()
    : null;

  return Boolean(
    ticket.early_bird_enabled &&
      earlyBirdPrice != null &&
      Number.isFinite(earlyBirdPrice) &&
      earlyBirdPrice >= 0 &&
      earlyBirdEndsAt != null &&
      Number.isFinite(earlyBirdEndsAt) &&
      earlyBirdEndsAt >= Date.now()
  );
}

function activeTicketPrice(ticket: TicketTypeRow) {
  return isEarlyBirdActive(ticket) && ticket.early_bird_price != null
    ? Number(ticket.early_bird_price)
    : Number(ticket.price ?? 0);
}

function formatDateTime(value: string | null) {
  if (!value) return "—";

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function ticketKindLabel(value: string) {
  if (value === "general_admission") return "General Admission";
  if (value === "vip") return "VIP";
  if (value === "competitor") return "Competitor";
  if (value === "spectator") return "Spectator";
  if (value === "staff") return "Staff";
  if (value === "vendor") return "Vendor";
  if (value === "table") return "Table";
  if (value === "pass") return "Pass";
  if (value === "other") return "Other";
  return value.replaceAll("_", " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function ticketStatusMeta(ticket: TicketTypeRow, waitlistEnabled: boolean) {
  const now = Date.now();

  if (!ticket.active) {
    return {
      selectable: false,
      soldOut: false,
      label: "Inactive",
      className: "bg-slate-100 text-slate-700",
      helper: "This ticket type is not currently active.",
    };
  }

  if (ticket.sale_starts_at && new Date(ticket.sale_starts_at).getTime() > now) {
    return {
      selectable: false,
      soldOut: false,
      label: "Not on sale yet",
      className: "bg-slate-100 text-slate-700",
      helper: `Sales open ${formatDateTime(ticket.sale_starts_at)}.`,
    };
  }

  if (ticket.sale_ends_at && new Date(ticket.sale_ends_at).getTime() < now) {
    return {
      selectable: false,
      soldOut: false,
      label: "Sales ended",
      className: "bg-slate-100 text-slate-700",
      helper: `Sales ended ${formatDateTime(ticket.sale_ends_at)}.`,
    };
  }

  if (ticket.capacity != null && ticket.capacity <= 0) {
    return waitlistEnabled
      ? {
          selectable: true,
          soldOut: true,
          label: "Waitlist only",
          className: "bg-purple-50 text-purple-700",
          helper:
            "This ticket is full. You can still join the waitlist without being charged.",
        }
      : {
          selectable: false,
          soldOut: true,
          label: "Sold out",
          className: "bg-red-50 text-red-700",
          helper: "This ticket is currently sold out.",
        };
  }

  return {
    selectable: true,
    soldOut: false,
    label: "Available",
    className: "bg-green-50 text-green-700",
    helper:
      ticket.capacity == null
        ? "This ticket is currently available."
        : `${ticket.capacity} spots currently available for this ticket.`,
  };
}

export default function RegistrationForm({
  eventSlug,
  ticketTypes,
  currentUserEmail = "",
  isSoldOut = false,
  waitlistEnabled = false,
  accountRequiredForRegistration = false,
  isAuthenticated = true,
}: RegistrationFormProps) {
  const [selectedTicketTypeId, setSelectedTicketTypeId] = useState<string>("");
  const [quantity, setQuantity] = useState(1);

  const ticketOptions = useMemo(() => {
    return ticketTypes.map((ticket) => ({
      ...ticket,
      meta: ticketStatusMeta(ticket, waitlistEnabled),
    }));
  }, [ticketTypes, waitlistEnabled]);

  const blockedForAuth = accountRequiredForRegistration && !isAuthenticated;
  const allowSubmission = !blockedForAuth;

  const selectedTicket = useMemo(
    () => ticketOptions.find((ticket) => ticket.id === selectedTicketTypeId) ?? null,
    [ticketOptions, selectedTicketTypeId],
  );

  const attendeesPerTicket = selectedTicket
    ? Math.max(1, Number(selectedTicket.attendees_per_ticket ?? 1) || 1)
    : 1;
  const totalAttendeeCount = selectedTicket ? Math.max(1, quantity) * attendeesPerTicket : 1;
  const additionalAttendeeCount = selectedTicket ? Math.max(0, totalAttendeeCount - 1) : 0;

  const [selectedCoachSlots, setSelectedCoachSlots] = useState<SelectedCoachSlotSummary[]>([]);

  useEffect(() => {
    function readSelectedCoachSlots() {
      const checkboxes = Array.from(
        document.querySelectorAll<HTMLInputElement>(
          'input[name="slotIds"][form="event-cart-checkout-form"]',
        ),
      );

      const selected = checkboxes
        .filter((checkbox) => checkbox.checked)
        .map((checkbox) => {
          const price = Number.parseFloat(checkbox.dataset.slotPrice ?? "0");

          return {
            id: checkbox.value,
            coachName: checkbox.dataset.coachName || "Guest coach",
            slotLabel: checkbox.dataset.slotLabel || "Selected lesson slot",
            price: Number.isFinite(price) ? price : 0,
          };
        });

      setSelectedCoachSlots(selected);
    }

    readSelectedCoachSlots();

    document.addEventListener("change", readSelectedCoachSlots);

    return () => {
      document.removeEventListener("change", readSelectedCoachSlots);
    };
  }, []);

  const selectedCoachSlotTotal = selectedCoachSlots.reduce(
    (sum, slot) => sum + slot.price,
    0,
  );

  const selectedTicketTotal = selectedTicket
    ? activeTicketPrice(selectedTicket) * Math.max(1, quantity)
    : 0;

  const estimatedTotal = selectedTicketTotal + selectedCoachSlotTotal;

  const topNotice = blockedForAuth
    ? "This event requires a free account before registration can continue."
    : isSoldOut
    ? waitlistEnabled
      ? "This event is currently full. Select a ticket below to join the waitlist. You will not be charged unless a spot opens."
      : "This event is currently sold out."
    : "Choose event tickets and any guest coach lesson slots you want, then check out once.";

  const buttonLabel = blockedForAuth
    ? "Account Required"
    : isSoldOut && waitlistEnabled
    ? "Join Waitlist"
    : "Continue to Secure Checkout";

  return (
    <form
      id="event-cart-checkout-form"
      action="/api/events/cart/checkout"
      method="post"
      className="mt-4 space-y-4"
    >
      <input type="hidden" name="eventSlug" value={eventSlug} />

      <div
        className={`rounded-xl border px-4 py-3 text-sm ${
          blockedForAuth
            ? "border-amber-200 bg-amber-50 text-amber-900"
            : isSoldOut
            ? waitlistEnabled
              ? "border-purple-200 bg-purple-50 text-purple-800"
              : "border-red-200 bg-red-50 text-red-700"
            : "border-blue-200 bg-blue-50 text-blue-800"
        }`}
      >
        {topNotice}
      </div>

      {blockedForAuth ? (
        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
          <p className="text-sm font-medium text-slate-900">
            Create a free account or log in to register
          </p>
          <p className="mt-1 text-sm text-slate-600">
            You can still review the event details and ticket options below, but registration is locked until you sign in.
          </p>

          <div className="mt-4 flex flex-wrap gap-3">
            <Link
              href="/signup"
              className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
            >
              Create Free Account
            </Link>

            <Link
              href="/login"
              className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Log In
            </Link>
          </div>
        </div>
      ) : null}

      <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
        <div className="flex flex-col gap-1">
          <p className="text-sm font-semibold text-slate-900">1. Choose event tickets</p>
          <p className="text-sm text-slate-600">
            Leave ticket type blank if you only want to book guest coach lessons.
          </p>
        </div>

        <div className="mt-4">
          <label htmlFor="ticketTypeId" className="mb-1 block text-sm font-medium">
            Ticket Type
          </label>

          <select
            id="ticketTypeId"
            name="ticketTypeId"
            value={selectedTicketTypeId}
            onChange={(event) => setSelectedTicketTypeId(event.target.value)}
            disabled={!allowSubmission}
            className="w-full rounded-xl border border-slate-300 px-3 py-2 disabled:bg-slate-100"
          >
            <option value="">No event ticket</option>

            {ticketOptions.map((ticket) => (
              <option key={ticket.id} value={ticket.id} disabled={!ticket.meta.selectable}>
                {ticket.name} — {formatCurrency(activeTicketPrice(ticket), ticket.currency)}
                {isEarlyBirdActive(ticket) ? " early bird" : ""}
                {Number(ticket.attendees_per_ticket ?? 1) > 1
                  ? ` · admits ${Number(ticket.attendees_per_ticket ?? 1)}`
                  : ""}
                {!ticket.meta.selectable ? ` (${ticket.meta.label})` : ""}
              </option>
            ))}
          </select>

          {selectedTicket ? (
            <p className="mt-2 text-sm text-slate-600">{selectedTicket.meta.helper}</p>
          ) : null}
        </div>

        {ticketOptions.length > 0 ? (
          <div className="mt-4 space-y-3">
            {ticketOptions.map((ticket) => {
              const isSelected = ticket.id === selectedTicketTypeId;

              return (
                <button
                  key={ticket.id}
                  type="button"
                  disabled={!ticket.meta.selectable || !allowSubmission}
                  onClick={() => setSelectedTicketTypeId(ticket.id)}
                  className={`w-full rounded-xl border p-4 text-left transition disabled:cursor-not-allowed disabled:opacity-60 ${
                    isSelected
                      ? "border-slate-900 bg-white shadow-sm"
                      : "border-slate-200 bg-white hover:border-slate-300"
                  }`}
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-medium text-slate-900">{ticket.name}</p>

                        <span className="inline-flex rounded-full bg-slate-50 px-2.5 py-1 text-xs font-medium text-slate-700 ring-1 ring-slate-200">
                          {ticketKindLabel(ticket.ticket_kind)}
                        </span>

                        <span
                          className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${ticket.meta.className}`}
                        >
                          {ticket.meta.label}
                        </span>

                        {isSelected ? (
                          <span className="inline-flex rounded-full bg-slate-900 px-2.5 py-1 text-xs font-medium text-white">
                            Selected
                          </span>
                        ) : null}
                      </div>

                      {ticket.description ? (
                        <p className="mt-2 text-sm text-slate-600">{ticket.description}</p>
                      ) : null}
                    </div>

                    <div className="text-right">
                      {isEarlyBirdActive(ticket) ? (
                        <div>
                          <p className="font-semibold text-slate-900">
                            {formatCurrency(activeTicketPrice(ticket), ticket.currency)}
                          </p>
                          <p className="text-xs font-medium text-amber-700">
                            Early bird · regular {formatCurrency(ticket.price, ticket.currency)}
                          </p>
                        </div>
                      ) : (
                        <p className="font-semibold text-slate-900">
                          {formatCurrency(ticket.price, ticket.currency)}
                        </p>
                      )}
                      <p className="text-xs text-slate-500">
                        {ticket.capacity == null
                          ? "Unlimited"
                          : `${ticket.capacity} currently available`}
                      </p>
                      <p className="text-xs text-slate-500">
                        Admits {Math.max(1, Number(ticket.attendees_per_ticket ?? 1) || 1)}
                        {Math.max(1, Number(ticket.attendees_per_ticket ?? 1) || 1) === 1
                          ? " attendee"
                          : " attendees"}
                      </p>
                    </div>
                  </div>

                  <div className="mt-3 space-y-1 text-xs text-slate-500">
                    <p>{ticket.meta.helper}</p>
                    {isEarlyBirdActive(ticket) && ticket.early_bird_ends_at ? (
                      <p className="font-medium text-amber-700">
                        Early bird ends: {formatDateTime(ticket.early_bird_ends_at)}
                      </p>
                    ) : null}
                    <p>Sale starts: {formatDateTime(ticket.sale_starts_at)}</p>
                    <p>Sale ends: {formatDateTime(ticket.sale_ends_at)}</p>
                  </div>
                </button>
              );
            })}
          </div>
        ) : (
          <div className="mt-4 rounded-xl border border-dashed border-slate-300 bg-white px-4 py-8 text-sm text-slate-500">
            No active ticket types are available right now.
          </div>
        )}

        {selectedTicket ? (
          <div className="mt-4">
            <label htmlFor="quantity" className="mb-1 block text-sm font-medium">
              Quantity
            </label>

            <input
              id="quantity"
              name="quantity"
              type="number"
              min={1}
              value={quantity}
              onChange={(event) => {
                const nextValue = Number.parseInt(event.target.value, 10);
                setQuantity(Number.isFinite(nextValue) && nextValue > 0 ? nextValue : 1);
              }}
              disabled={!allowSubmission}
              className="w-full rounded-xl border border-slate-300 px-3 py-2 disabled:bg-slate-100"
            />

            <p className="mt-1 text-xs text-slate-500">
              This ticket selection admits {totalAttendeeCount} total
              {totalAttendeeCount === 1 ? " attendee" : " attendees"}.
            </p>
          </div>
        ) : (
          <input type="hidden" name="quantity" value="0" />
        )}
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white p-4">
        <div className="flex flex-col gap-1">
          <p className="text-sm font-semibold text-slate-900">2. Buyer details</p>
          <p className="text-sm text-slate-600">
            This person receives the receipt and any event updates.
          </p>
        </div>

        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <div>
            <label htmlFor="attendeeFirstName" className="mb-1 block text-sm font-medium">
              First Name
            </label>
            <input
              id="attendeeFirstName"
              name="attendeeFirstName"
              required
              disabled={!allowSubmission}
              className="w-full rounded-xl border border-slate-300 px-3 py-2 disabled:bg-slate-100"
            />
          </div>

          <div>
            <label htmlFor="attendeeLastName" className="mb-1 block text-sm font-medium">
              Last Name
            </label>
            <input
              id="attendeeLastName"
              name="attendeeLastName"
              required
              disabled={!allowSubmission}
              className="w-full rounded-xl border border-slate-300 px-3 py-2 disabled:bg-slate-100"
            />
          </div>

          <div className="md:col-span-2">
            <label htmlFor="attendeeEmail" className="mb-1 block text-sm font-medium">
              Email
            </label>
            <input
              id="attendeeEmail"
              name="attendeeEmail"
              type="email"
              required
              defaultValue={currentUserEmail}
              disabled={!allowSubmission}
              className="w-full rounded-xl border border-slate-300 px-3 py-2 disabled:bg-slate-100"
            />
          </div>

          <div className="md:col-span-2">
            <label htmlFor="attendeePhone" className="mb-1 block text-sm font-medium">
              Phone
            </label>
            <input
              id="attendeePhone"
              name="attendeePhone"
              disabled={!allowSubmission}
              className="w-full rounded-xl border border-slate-300 px-3 py-2 disabled:bg-slate-100"
            />
          </div>
        </div>
      </div>

      {selectedTicket && additionalAttendeeCount > 0 ? (
        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
          <div className="flex flex-col gap-1">
            <p className="text-sm font-semibold text-slate-900">3. Additional attendee names</p>
            <p className="text-sm text-slate-600">
              This ticket selection admits {totalAttendeeCount} total attendees. The buyer above is
              Attendee 1. Add the remaining attendee names below for accurate check-in.
            </p>
          </div>

          <div className="mt-4 grid gap-3 md:grid-cols-2">
            {Array.from({ length: additionalAttendeeCount }, (_, index) => {
              const attendeeNumber = index + 2;

              return (
                <label key={attendeeNumber} className="space-y-1 text-sm">
                  <span className="font-medium text-slate-700">
                    Attendee {attendeeNumber} name
                  </span>
                  <input
                    name="additionalAttendeeNames"
                    required
                    disabled={!allowSubmission}
                    className="w-full rounded-xl border border-slate-300 px-3 py-2 disabled:bg-slate-100"
                    placeholder="Full name"
                  />
                </label>
              );
            })}
          </div>
        </div>
      ) : null}

      <div className="rounded-2xl border border-slate-200 bg-white p-4">
        <label htmlFor="notes" className="mb-1 block text-sm font-medium">
          Notes
        </label>
        <textarea
          id="notes"
          name="notes"
          rows={3}
          disabled={!allowSubmission}
          className="w-full rounded-xl border border-slate-300 px-3 py-2 disabled:bg-slate-100"
          placeholder="Optional notes"
        />
      </div>

      <div className="rounded-2xl border border-purple-100 bg-purple-50 p-4 text-sm text-purple-900">
        <p className="font-semibold">Single checkout</p>
        <p className="mt-1">
          Selected coach lesson slots above will be included with your event ticket in one secure Stripe payment.
        </p>
      </div>

      <details className="rounded-2xl border border-slate-200 bg-slate-50 p-4" open>
        <summary className="cursor-pointer list-none text-sm font-semibold text-slate-900">
          Your checkout
        </summary>

        <div className="mt-3 space-y-3 text-sm">
          {selectedTicket ? (
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="font-medium text-slate-900">{selectedTicket.name}</p>
                <p className="text-xs text-slate-500">
                  Quantity {Math.max(1, quantity)} · {totalAttendeeCount} total{" "}
                  {totalAttendeeCount === 1 ? "attendee" : "attendees"}
                </p>
              </div>
              <p className="font-semibold text-slate-900">
                {formatCurrency(selectedTicketTotal, selectedTicket.currency)}
              </p>
            </div>
          ) : null}

          {selectedCoachSlots.map((slot) => (
            <div key={slot.id} className="flex items-start justify-between gap-3">
              <div>
                <p className="font-medium text-slate-900">
                  Private lesson with {slot.coachName}
                </p>
                <p className="text-xs text-slate-500">{slot.slotLabel}</p>
              </div>
              <p className="font-semibold text-slate-900">
                {formatCurrency(slot.price, selectedTicket?.currency || "USD")}
              </p>
            </div>
          ))}

          {!selectedTicket && selectedCoachSlots.length === 0 ? (
            <p className="text-slate-500">
              Select a ticket or coach lesson to see your checkout total.
            </p>
          ) : null}

          <div className="border-t border-slate-200 pt-3">
            <div className="flex items-center justify-between gap-3">
              <p className="font-semibold text-slate-950">Estimated total</p>
              <p className="text-lg font-bold text-slate-950">
                {formatCurrency(estimatedTotal, selectedTicket?.currency || "USD")}
              </p>
            </div>
          </div>
        </div>
      </details>

      <button
        type="submit"
        disabled={!allowSubmission}
        className="w-full rounded-xl bg-slate-900 px-4 py-3 text-white hover:bg-slate-800 disabled:opacity-60"
      >
        {buttonLabel}
      </button>
    </form>
  );
}





