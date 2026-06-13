"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

type SelectedCoachSlotSummary = {
  id: string;
  coachName: string;
  slotLabel: string;
  price: number;
};


type EventDocumentRequirement = {
  id: string;
  template_id: string;
  template_version_id: string | null;
  title: string;
  description: string | null;
  body: string;
  requires_signature: boolean;
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
  requiredEventDocuments?: EventDocumentRequirement[];
};

function formatCurrency(value: number, currency: string) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency || "USD",
  }).format(Number(value ?? 0));
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
  requiredEventDocuments = [],
}: RegistrationFormProps) {
  const [ticketQuantities, setTicketQuantities] = useState<Record<string, number>>({});
  const [waiversAccepted, setWaiversAccepted] = useState(false);

  const ticketOptions = useMemo(() => {
    return ticketTypes.map((ticket) => ({
      ...ticket,
      meta: ticketStatusMeta(ticket, waitlistEnabled),
    }));
  }, [ticketTypes, waitlistEnabled]);

  const blockedForAuth = accountRequiredForRegistration && !isAuthenticated;
  const allowSubmission = !blockedForAuth;

  const selectedTickets = useMemo(() => {
    return ticketOptions
      .map((ticket) => ({
        ...ticket,
        selectedQuantity: Math.max(0, Number(ticketQuantities[ticket.id] ?? 0) || 0),
      }))
      .filter((ticket) => ticket.selectedQuantity > 0);
  }, [ticketOptions, ticketQuantities]);

  const selectedTicketTotal = selectedTickets.reduce(
    (sum, ticket) => sum + Number(ticket.price ?? 0) * ticket.selectedQuantity,
    0,
  );

  const selectedTicketAttendeeCount = selectedTickets.reduce((sum, ticket) => {
    const attendeesPerTicket = Math.max(1, Number(ticket.attendees_per_ticket ?? 1) || 1);
    return sum + ticket.selectedQuantity * attendeesPerTicket;
  }, 0);

  const additionalAttendeeRequests = selectedTickets.flatMap((ticket) => {
    const attendeesPerTicket = Math.max(1, Number(ticket.attendees_per_ticket ?? 1) || 1);
    const totalForTicket = ticket.selectedQuantity * attendeesPerTicket;
    const additionalCount = Math.max(0, totalForTicket - 1);

    return Array.from({ length: additionalCount }, (_, index) => ({
      ticketId: ticket.id,
      ticketName: ticket.name,
      attendeeNumber: index + 2,
    }));
  });

  const primaryCurrency =
    selectedTickets[0]?.currency || ticketOptions.find((ticket) => ticket.currency)?.currency || "USD";

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

  const estimatedTotal = selectedTicketTotal + selectedCoachSlotTotal;
  const hasCheckoutSelection = selectedTickets.length > 0 || selectedCoachSlots.length > 0;
  const canSubmitCheckout = allowSubmission && hasCheckoutSelection;

  const updateTicketQuantity = (ticketId: string, nextQuantity: number) => {
    setTicketQuantities((current) => {
      const safeQuantity = Number.isFinite(nextQuantity) && nextQuantity > 0 ? nextQuantity : 0;
      const next = { ...current };

      if (safeQuantity <= 0) {
        delete next[ticketId];
      } else {
        next[ticketId] = safeQuantity;
      }

      return next;
    });
  };

  const topNotice = blockedForAuth
    ? "This event requires a free account before registration can continue."
    : isSoldOut
    ? waitlistEnabled
      ? "This event is currently full. Select a ticket below to join the waitlist. You will not be charged unless a spot opens."
      : "This event is currently sold out."
    : "Choose one or more event tickets and any guest coach lesson slots you want, then check out once.";

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

      {selectedTickets.map((ticket) => (
        <div key={ticket.id}>
          <input type="hidden" name="ticketTypeIds" value={ticket.id} />
          <input type="hidden" name="ticketQuantities" value={ticket.selectedQuantity} />
        </div>
      ))}

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
            Select quantities for one or more ticket options. Leave all quantities at 0 if you only want to book guest coach lessons.
          </p>
        </div>

        {ticketOptions.length > 0 ? (
          <div className="mt-4 space-y-3">
            {ticketOptions.map((ticket) => {
              const selectedQuantity = Math.max(0, Number(ticketQuantities[ticket.id] ?? 0) || 0);
              const attendeesPerTicket = Math.max(1, Number(ticket.attendees_per_ticket ?? 1) || 1);
              const selectedAttendees = selectedQuantity * attendeesPerTicket;
              const isSelected = selectedQuantity > 0;
              const maxQuantity = ticket.capacity == null ? undefined : Math.max(0, ticket.capacity);

              return (
                <div
                  key={ticket.id}
                  className={`rounded-xl border p-4 transition ${
                    isSelected
                      ? "border-slate-900 bg-white shadow-sm"
                      : "border-slate-200 bg-white"
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

                      <div className="mt-3 space-y-1 text-xs text-slate-500">
                        <p>{ticket.meta.helper}</p>
                        <p>Sale starts: {formatDateTime(ticket.sale_starts_at)}</p>
                        <p>Sale ends: {formatDateTime(ticket.sale_ends_at)}</p>
                      </div>
                    </div>

                    <div className="min-w-[170px] text-right">
                      <p className="font-semibold text-slate-900">
                        {formatCurrency(ticket.price, ticket.currency)}
                      </p>
                      <p className="text-xs text-slate-500">
                        {ticket.capacity == null
                          ? "Unlimited"
                          : `${ticket.capacity} currently available`}
                      </p>
                      <p className="text-xs text-slate-500">
                        Admits {attendeesPerTicket}
                        {attendeesPerTicket === 1 ? " attendee" : " attendees"}
                      </p>

                      <label className="mt-3 block text-left text-xs font-semibold text-slate-600">
                        Quantity
                        <input
                          name={`ticketQuantityDisplay-${ticket.id}`}
                          type="number"
                          min={0}
                          max={maxQuantity}
                          value={selectedQuantity}
                          disabled={!ticket.meta.selectable || !allowSubmission}
                          onChange={(event) => {
                            const nextValue = Number.parseInt(event.target.value, 10);
                            updateTicketQuantity(
                              ticket.id,
                              Number.isFinite(nextValue) ? nextValue : 0,
                            );
                          }}
                          className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm disabled:bg-slate-100"
                        />
                      </label>

                      {selectedQuantity > 0 ? (
                        <p className="mt-1 text-xs text-slate-500">
                          {selectedAttendees} total{" "}
                          {selectedAttendees === 1 ? "attendee" : "attendees"}
                        </p>
                      ) : null}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="mt-4 rounded-xl border border-dashed border-slate-300 bg-white px-4 py-8 text-sm text-slate-500">
            No active ticket types are available right now.
          </div>
        )}
      </div>

      {requiredEventDocuments.length ? (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4">
          <div className="flex flex-col gap-1">
            <p className="text-sm font-semibold text-amber-950">
              Required event documents
            </p>
            <p className="text-sm leading-6 text-amber-900">
              Review and acknowledge these documents before checkout. Your typed name will be saved with the registration record.
            </p>
          </div>

          <div className="mt-4 space-y-3">
            {requiredEventDocuments.map((document) => (
              <details
                key={document.id}
                className="rounded-2xl border border-amber-200 bg-white p-4"
              >
                <summary className="cursor-pointer list-none text-sm font-bold text-slate-900">
                  {document.title}
                  {document.description ? (
                    <span className="mt-1 block text-sm font-normal leading-6 text-slate-600">
                      {document.description}
                    </span>
                  ) : null}
                </summary>
                <div className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm leading-6 text-slate-700">
                  {document.body}
                </div>
                <input type="hidden" name="documentRequirementIds" value={document.id} />
              </details>
            ))}
          </div>

          <div className="mt-4 grid gap-3 md:grid-cols-2">
            <label className="space-y-2 text-sm font-semibold text-slate-900">
              Type your full name to sign
              <input
                name="documentSignatureName"
                required
                disabled={!allowSubmission}
                className="w-full rounded-xl border border-amber-200 bg-white px-3 py-2 disabled:bg-slate-100"
                placeholder="Full legal name"
              />
            </label>

            <label className="flex items-start gap-3 rounded-xl border border-amber-200 bg-white p-3 text-sm text-slate-700">
              <input
                name="documentConsentAccepted"
                type="checkbox"
                required
                checked={waiversAccepted}
                disabled={!allowSubmission}
                onChange={(event) => setWaiversAccepted(event.target.checked)}
                className="mt-1"
              />
              <span>
                I have reviewed the required document(s), agree to sign electronically, and confirm that my typed name is my signature.
              </span>
            </label>
          </div>
        </div>
      ) : null}

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

      {additionalAttendeeRequests.length > 0 ? (
        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
          <div className="flex flex-col gap-1">
            <p className="text-sm font-semibold text-slate-900">3. Additional attendee names</p>
            <p className="text-sm text-slate-600">
              The buyer above is Attendee 1 for each selected ticket option. Add guest names for tickets that admit more than one person or multiple quantities.
            </p>
          </div>

          <div className="mt-4 grid gap-3 md:grid-cols-2">
            {additionalAttendeeRequests.map((request, index) => (
              <label key={`${request.ticketId}-${index}`} className="space-y-1 text-sm">
                <span className="font-medium text-slate-700">
                  {request.ticketName} — attendee {request.attendeeNumber}
                </span>
                <input
                  name="additionalAttendeeNames"
                  required
                  disabled={!allowSubmission}
                  className="w-full rounded-xl border border-slate-300 px-3 py-2 disabled:bg-slate-100"
                  placeholder="Full name"
                />
              </label>
            ))}
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
          Selected tickets and coach lesson slots will be included in one secure Stripe payment.
        </p>
      </div>

      {!hasCheckoutSelection ? (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          Select at least one ticket option or guest coach lesson slot before continuing to checkout.
        </div>
      ) : null}

      <details className="rounded-2xl border border-slate-200 bg-slate-50 p-4" open>
        <summary className="cursor-pointer list-none text-sm font-semibold text-slate-900">
          Your checkout
        </summary>

        <div className="mt-3 space-y-3 text-sm">
          {selectedTickets.map((ticket) => {
            const attendeesPerTicket = Math.max(1, Number(ticket.attendees_per_ticket ?? 1) || 1);
            const ticketTotal = Number(ticket.price ?? 0) * ticket.selectedQuantity;
            const attendeeCount = attendeesPerTicket * ticket.selectedQuantity;

            return (
              <div key={ticket.id} className="flex items-start justify-between gap-3">
                <div>
                  <p className="font-medium text-slate-900">{ticket.name}</p>
                  <p className="text-xs text-slate-500">
                    Quantity {ticket.selectedQuantity} · {attendeeCount} total{" "}
                    {attendeeCount === 1 ? "attendee" : "attendees"}
                  </p>
                </div>
                <p className="font-semibold text-slate-900">
                  {formatCurrency(ticketTotal, ticket.currency)}
                </p>
              </div>
            );
          })}

          {selectedCoachSlots.map((slot) => (
            <div key={slot.id} className="flex items-start justify-between gap-3">
              <div>
                <p className="font-medium text-slate-900">
                  Private lesson with {slot.coachName}
                </p>
                <p className="text-xs text-slate-500">{slot.slotLabel}</p>
              </div>
              <p className="font-semibold text-slate-900">
                {formatCurrency(slot.price, primaryCurrency)}
              </p>
            </div>
          ))}

          {selectedTickets.length === 0 && selectedCoachSlots.length === 0 ? (
            <p className="text-slate-500">
              Select tickets or coach lessons to see your checkout total.
            </p>
          ) : null}

          {selectedTickets.length > 0 ? (
            <p className="rounded-xl bg-white px-3 py-2 text-xs text-slate-600 ring-1 ring-slate-200">
              Selected tickets admit {selectedTicketAttendeeCount} total{" "}
              {selectedTicketAttendeeCount === 1 ? "attendee" : "attendees"} across all ticket options.
            </p>
          ) : null}

          <div className="border-t border-slate-200 pt-3">
            <div className="flex items-center justify-between gap-3">
              <p className="font-semibold text-slate-950">Estimated total</p>
              <p className="text-lg font-bold text-slate-950">
                {formatCurrency(estimatedTotal, primaryCurrency)}
              </p>
            </div>
          </div>
        </div>
      </details>

      <button
        type="submit"
        disabled={!canSubmitCheckout}
        className="w-full rounded-xl bg-slate-900 px-4 py-3 text-white hover:bg-slate-800 disabled:opacity-60"
      >
        {!hasCheckoutSelection && allowSubmission ? "Select Tickets or Coach Slots" : buttonLabel}
      </button>
    </form>
  );
}

