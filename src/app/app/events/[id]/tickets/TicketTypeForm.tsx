"use client";

import {
  createTicketTypeAction,
  updateTicketTypeAction,
} from "./actions";

type TicketTypeRow = {
  id: string;
  name: string;
  description: string | null;
  ticket_kind: string;
  price: number;
  currency: string;
  capacity: number | null;
  sort_order: number;
  active: boolean;
  sale_starts_at: string | null;
  sale_ends_at: string | null;
  early_bird_enabled: boolean | null;
  early_bird_price: number | null;
  early_bird_ends_at: string | null;
  attendees_per_ticket: number | null;
};

function toDatetimeLocal(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  const yyyy = date.getFullYear();
  const mm = `${date.getMonth() + 1}`.padStart(2, "0");
  const dd = `${date.getDate()}`.padStart(2, "0");
  const hh = `${date.getHours()}`.padStart(2, "0");
  const mi = `${date.getMinutes()}`.padStart(2, "0");
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}`;
}

export default function TicketTypeForm({
  eventId,
  initialValues,
  mode,
}: {
  eventId: string;
  initialValues?: TicketTypeRow;
  mode: "create" | "edit";
}) {
  const formAction =
    mode === "edit" ? updateTicketTypeAction : createTicketTypeAction;

  return (
    <form
      action={formAction}
      className="space-y-4 rounded-2xl border bg-slate-50 p-5"
    >
      <input type="hidden" name="eventId" value={eventId} />
      <input
        type="hidden"
        name="timezoneOffsetMinutes"
        value={String(new Date().getTimezoneOffset())}
      />
      {mode === "edit" && initialValues ? (
        <input type="hidden" name="ticketId" value={initialValues.id} />
      ) : null}

      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <label className="mb-1 block text-sm font-medium">Name</label>
          <input
            name="name"
            required
            defaultValue={initialValues?.name ?? ""}
            className="w-full rounded-xl border border-slate-300 px-3 py-2"
            placeholder="Weekend Pass"
          />
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium">Ticket Kind</label>
          <select
            name="ticketKind"
            defaultValue={initialValues?.ticket_kind ?? "general_admission"}
            className="w-full rounded-xl border border-slate-300 px-3 py-2"
          >
            <option value="general_admission">General Admission</option>
            <option value="vip">VIP</option>
            <option value="competitor">Competitor</option>
            <option value="spectator">Spectator</option>
            <option value="staff">Staff</option>
            <option value="vendor">Vendor</option>
            <option value="table">Table</option>
            <option value="pass">Pass</option>
            <option value="other">Other</option>
          </select>
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium">Price</label>
          <input
            name="price"
            type="number"
            min="0"
            step="0.01"
            required
            defaultValue={initialValues ? String(initialValues.price) : "0"}
            className="w-full rounded-xl border border-slate-300 px-3 py-2"
          />
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium">Currency</label>
          <input
            name="currency"
            defaultValue={initialValues?.currency ?? "USD"}
            className="w-full rounded-xl border border-slate-300 px-3 py-2"
          />
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium">Capacity</label>
          <input
            name="capacity"
            type="number"
            min="0"
            defaultValue={
              initialValues?.capacity == null ? "" : String(initialValues.capacity)
            }
            className="w-full rounded-xl border border-slate-300 px-3 py-2"
            placeholder="Optional"
          />
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium">Attendees per ticket</label>
          <input
            name="attendeesPerTicket"
            type="number"
            min="1"
            step="1"
            defaultValue={String(Math.max(1, Number(initialValues?.attendees_per_ticket ?? 1)))}
            className="w-full rounded-xl border border-slate-300 px-3 py-2"
          />
          <p className="mt-1 text-xs text-slate-500">
            Use 1 for a single ticket, 2 for a couple ticket, or more for group/table passes.
          </p>
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium">Sort Order</label>
          <input
            name="sortOrder"
            type="number"
            min="0"
            defaultValue={String(initialValues?.sort_order ?? 0)}
            className="w-full rounded-xl border border-slate-300 px-3 py-2"
          />
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium">Sale Starts At</label>
          <input
            name="saleStartsAt"
            type="datetime-local"
            defaultValue={toDatetimeLocal(initialValues?.sale_starts_at ?? null)}
            className="w-full rounded-xl border border-slate-300 px-3 py-2"
          />
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium">Sale Ends At</label>
          <input
            name="saleEndsAt"
            type="datetime-local"
            defaultValue={toDatetimeLocal(initialValues?.sale_ends_at ?? null)}
            className="w-full rounded-xl border border-slate-300 px-3 py-2"
          />
        </div>
      </div>

      <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4">
        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            name="earlyBirdEnabled"
            defaultChecked={Boolean(initialValues?.early_bird_enabled)}
            className="mt-1"
          />
          <div>
            <p className="font-medium text-slate-900">Enable early bird pricing</p>
            <p className="mt-1 text-sm text-slate-600">
              Offer a lower price until a specific cutoff date and time. Checkout will enforce the active price server-side.
            </p>
          </div>
        </label>

        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <div>
            <label className="mb-1 block text-sm font-medium">Early Bird Price</label>
            <input
              name="earlyBirdPrice"
              type="number"
              min="0"
              step="0.01"
              defaultValue={
                initialValues?.early_bird_price == null
                  ? ""
                  : String(initialValues.early_bird_price)
              }
              className="w-full rounded-xl border border-slate-300 px-3 py-2"
              placeholder="Optional"
            />
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium">Early Bird Ends At</label>
            <input
              name="earlyBirdEndsAt"
              type="datetime-local"
              defaultValue={toDatetimeLocal(initialValues?.early_bird_ends_at ?? null)}
              className="w-full rounded-xl border border-slate-300 px-3 py-2"
            />
          </div>
        </div>
      </div>

      <div>
        <label className="mb-1 block text-sm font-medium">Description</label>
        <textarea
          name="description"
          rows={3}
          defaultValue={initialValues?.description ?? ""}
          className="w-full rounded-xl border border-slate-300 px-3 py-2"
          placeholder="Optional ticket description"
        />
      </div>

      <label className="flex items-start gap-3 rounded-xl border bg-white p-4">
        <input
          type="checkbox"
          name="active"
          defaultChecked={initialValues?.active ?? true}
          className="mt-1"
        />
        <div>
          <p className="font-medium text-slate-900">Active ticket type</p>
          <p className="mt-1 text-sm text-slate-600">
            Inactive ticket types stay in the system but are hidden from public registration.
          </p>
        </div>
      </label>

      <div className="flex flex-wrap gap-3">
        <button
          type="submit"
          className="rounded-xl bg-slate-900 px-4 py-2 text-white hover:bg-slate-800"
        >
          {mode === "edit" ? "Save Ticket Type" : "Create Ticket Type"}
        </button>
      </div>
    </form>
  );
}

