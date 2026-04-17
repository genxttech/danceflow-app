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
      {mode === "edit" && initialValues ? (
        <input type="hidden" name="ticketTypeId" value={initialValues.id} />
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
