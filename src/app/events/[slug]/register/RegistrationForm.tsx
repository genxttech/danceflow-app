"use client";

import Link from "next/link";
import { useActionState, useMemo, useState } from "react";
import { createEventRegistrationAction } from "./actions";

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
};

type ActionState = {
  error: string;
  success: string;
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

const initialState: ActionState = {
  error: "",
  success: "",
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
}: RegistrationFormProps) {
  const [state, formAction, pending] = useActionState(
    createEventRegistrationAction,
    initialState
  );

  const [selectedTicketTypeId, setSelectedTicketTypeId] = useState<string>("");

  const ticketOptions = useMemo(() => {
    return ticketTypes.map((ticket) => ({
      ...ticket,
      meta: ticketStatusMeta(ticket, waitlistEnabled),
    }));
  }, [ticketTypes, waitlistEnabled]);

  const selectableTicketTypes = ticketOptions.filter((ticket) => ticket.meta.selectable);

  const blockedForAuth = accountRequiredForRegistration && !isAuthenticated;
  const allowSubmission =
    !blockedForAuth && (selectableTicketTypes.length > 0 || (isSoldOut && waitlistEnabled));

  const selectedTicket = useMemo(
    () => ticketOptions.find((ticket) => ticket.id === selectedTicketTypeId) ?? null,
    [ticketOptions, selectedTicketTypeId]
  );

  const topNotice = blockedForAuth
    ? "This event requires a free account before registration can continue."
    : isSoldOut
    ? waitlistEnabled
      ? "This event is currently full. Select a ticket below to join the waitlist. You will not be charged unless a spot opens."
      : "This event is currently sold out."
    : "Choose a ticket type below. Free registrations complete immediately. Paid registrations continue to secure Stripe Checkout.";

  const buttonLabel = pending
    ? isSoldOut && waitlistEnabled
      ? "Joining Waitlist..."
      : "Continuing..."
    : blockedForAuth
    ? "Account Required"
    : isSoldOut && waitlistEnabled
    ? "Join Waitlist"
    : selectedTicket && Number(selectedTicket.price) <= 0
    ? "Complete Registration"
    : "Continue to Checkout";

  return (
    <form action={formAction} className="mt-4 space-y-4">
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

      <div>
        <label htmlFor="ticketTypeId" className="mb-1 block text-sm font-medium">
          Ticket Type
        </label>

        <select
          id="ticketTypeId"
          name="ticketTypeId"
          required
          value={selectedTicketTypeId}
          onChange={(event) => setSelectedTicketTypeId(event.target.value)}
          disabled={!allowSubmission}
          className="w-full rounded-xl border border-slate-300 px-3 py-2 disabled:bg-slate-100"
        >
          <option value="">Select ticket type</option>

          {ticketOptions.map((ticket) => (
            <option key={ticket.id} value={ticket.id} disabled={!ticket.meta.selectable}>
              {ticket.name} — {formatCurrency(ticket.price, ticket.currency)}
              {!ticket.meta.selectable ? ` (${ticket.meta.label})` : ""}
            </option>
          ))}
        </select>

        {selectedTicket ? (
          <p className="mt-2 text-sm text-slate-600">{selectedTicket.meta.helper}</p>
        ) : null}
      </div>

      {ticketOptions.length > 0 ? (
        <div className="space-y-3">
          {ticketOptions.map((ticket) => {
            const isSelected = ticket.id === selectedTicketTypeId;

            return (
              <div
                key={ticket.id}
                className={`rounded-xl border p-4 ${
                  isSelected
                    ? "border-slate-900 bg-slate-50"
                    : "border-slate-200 bg-slate-50"
                }`}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-medium text-slate-900">{ticket.name}</p>

                      <span className="inline-flex rounded-full bg-white px-2.5 py-1 text-xs font-medium text-slate-700 ring-1 ring-slate-200">
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
                    <p className="font-semibold text-slate-900">
                      {formatCurrency(ticket.price, ticket.currency)}
                    </p>
                    <p className="text-xs text-slate-500">
                      {ticket.capacity == null
                        ? "Unlimited"
                        : `${ticket.capacity} currently available`}
                    </p>
                  </div>
                </div>

                <div className="mt-3 space-y-1 text-xs text-slate-500">
                  <p>{ticket.meta.helper}</p>
                  <p>Sale starts: {formatDateTime(ticket.sale_starts_at)}</p>
                  <p>Sale ends: {formatDateTime(ticket.sale_ends_at)}</p>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-8 text-sm text-slate-500">
          No active ticket types are available right now.
        </div>
      )}

      <div>
        <label htmlFor="quantity" className="mb-1 block text-sm font-medium">
          Quantity
        </label>

        <input
          id="quantity"
          name="quantity"
          type="number"
          min={1}
          defaultValue={1}
          disabled={!allowSubmission}
          className="w-full rounded-xl border border-slate-300 px-3 py-2 disabled:bg-slate-100"
        />

        <p className="mt-1 text-xs text-slate-500">
          Quantity will be validated again when registration is submitted.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
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

      <div>
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

      {state.error ? (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {state.error}
        </div>
      ) : null}

      {state.success ? (
        <div className="rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">
          {state.success}
        </div>
      ) : null}

      <button
        type="submit"
        disabled={pending || !allowSubmission}
        className="w-full rounded-xl bg-slate-900 px-4 py-3 text-white hover:bg-slate-800 disabled:opacity-60"
      >
        {buttonLabel}
      </button>
    </form>
  );
}