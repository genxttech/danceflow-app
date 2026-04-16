"use client";

import Link from "next/link";
import { useActionState, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { createFloorSpaceRentalAction } from "./actions";

type RoomOption = {
  id: string;
  name: string;
};

type Slot = {
  id: string;
  date: string;
  startTime: string;
  endTime: string;
};

type ActionState = {
  error: string;
  success: string;
};

const initialState: ActionState = {
  error: "",
  success: "",
};

function makeSlot(): Slot {
  return {
    id: crypto.randomUUID(),
    date: "",
    startTime: "",
    endTime: "",
  };
}

function getTodayDateInputValue() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = `${now.getMonth() + 1}`.padStart(2, "0");
  const dd = `${now.getDate()}`.padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function formatSlotLabel(slot: Pick<Slot, "date" | "startTime" | "endTime">) {
  if (!slot.date || !slot.startTime || !slot.endTime) return "Incomplete slot";

  const start = new Date(`${slot.date}T${slot.startTime}:00`);
  const end = new Date(`${slot.date}T${slot.endTime}:00`);

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return "Incomplete slot";
  }

  return `${start.toLocaleDateString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
  })} • ${start.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  })} - ${end.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  })}`;
}

function hasDuplicateSlots(slots: Slot[]) {
  const seen = new Set<string>();

  for (const slot of slots) {
    const key = `${slot.date}|${slot.startTime}|${slot.endTime}`;
    if (seen.has(key)) return true;
    seen.add(key);
  }

  return false;
}

function getClientValidationError(slots: Slot[]) {
  if (slots.length === 0) {
    return "Add at least one rental slot.";
  }

  for (const slot of slots) {
    if (!slot.date || !slot.startTime || !slot.endTime) {
      return "Complete every slot before booking.";
    }

    const startsAt = new Date(`${slot.date}T${slot.startTime}:00`);
    const endsAt = new Date(`${slot.date}T${slot.endTime}:00`);

    if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) {
      return "One or more rental slots has an invalid date or time.";
    }

    if (endsAt <= startsAt) {
      return "Each slot must end after it starts.";
    }
  }

  if (hasDuplicateSlots(slots)) {
    return "Duplicate slots are not allowed.";
  }

  return "";
}

export default function FloorSpaceRentalForm({
  studioSlug,
  rooms,
}: {
  studioSlug: string;
  rooms: RoomOption[];
}) {
  const [state, formAction, pending] = useActionState(
    createFloorSpaceRentalAction,
    initialState
  );
  const searchParams = useSearchParams();

  const [notes, setNotes] = useState("");
  const [slots, setSlots] = useState<Slot[]>([
    {
      ...makeSlot(),
      date: getTodayDateInputValue(),
    },
  ]);

  const bookingSuccess = searchParams.get("success") === "booked";

  const slotsJson = useMemo(() => {
    return JSON.stringify(
      slots.map((slot) => ({
        date: slot.date,
        startTime: slot.startTime,
        endTime: slot.endTime,
      }))
    );
  }, [slots]);

  const clientValidationError = useMemo(
    () => getClientValidationError(slots),
    [slots]
  );

  const slotCount = slots.length;

  function addSlot() {
    setSlots((current) => [
      ...current,
      {
        ...makeSlot(),
        date: current[current.length - 1]?.date || getTodayDateInputValue(),
      },
    ]);
  }

  function removeSlot(id: string) {
    setSlots((current) => {
      if (current.length === 1) return current;
      return current.filter((slot) => slot.id !== id);
    });
  }

  function updateSlot(id: string, patch: Partial<Slot>) {
    setSlots((current) =>
      current.map((slot) => (slot.id === id ? { ...slot, ...patch } : slot))
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <h2 className="text-3xl font-semibold tracking-tight text-slate-900">
            Floor Space Rental
          </h2>
          <p className="mt-2 text-slate-600">
            Book one or more future floor rental sessions for this studio.
          </p>
        </div>

        <div className="flex flex-wrap gap-3">
          <Link
            href={`/portal/${encodeURIComponent(studioSlug)}`}
            className="rounded-xl border px-4 py-2 text-slate-700 hover:bg-slate-50"
          >
            Back to Portal
          </Link>

          <Link
            href={`/portal/${encodeURIComponent(studioSlug)}/floor-space/my-rentals`}
            className="rounded-xl border px-4 py-2 text-slate-700 hover:bg-slate-50"
          >
            My Rentals
          </Link>
        </div>
      </div>

      {bookingSuccess ? (
        <div className="rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">
          Floor space rental booked successfully.
        </div>
      ) : null}

      <div className="rounded-2xl border border-blue-200 bg-blue-50 p-5 text-sm text-blue-900">
        <p className="font-medium">Floor rental rules</p>
        <ul className="mt-2 space-y-1 text-blue-800">
          <li>Floor space rentals do not deduct from lesson packages.</li>
          <li>Past time slots cannot be booked.</li>
          <li>Your own overlapping bookings are blocked.</li>
          <li>
            Room overlap can be overridden only when you intentionally choose to do so.
          </li>
        </ul>
      </div>

      <form action={formAction} className="space-y-6">
        <input type="hidden" name="studioSlug" value={studioSlug} />
        <input type="hidden" name="slotsJson" value={slotsJson} />

        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <label htmlFor="roomId" className="mb-1 block text-sm font-medium">
              Room
            </label>
            <select
              id="roomId"
              name="roomId"
              defaultValue=""
              className="w-full rounded-xl border border-slate-300 px-3 py-2"
            >
              <option value="">No room selected</option>
              {rooms.map((room) => (
                <option key={room.id} value={room.id}>
                  {room.name}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-slate-500">
              Optional. Select a room only if your studio uses room-level tracking.
            </p>
          </div>

          <div>
            <label htmlFor="notes" className="mb-1 block text-sm font-medium">
              Notes
            </label>
            <input
              id="notes"
              name="notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="w-full rounded-xl border border-slate-300 px-3 py-2"
              placeholder="Optional notes"
            />
          </div>
        </div>

        <label className="flex items-start gap-3 rounded-xl border bg-slate-50 p-4">
          <input
            type="checkbox"
            name="overrideRoomConflict"
            className="mt-1"
          />
          <div>
            <p className="font-medium text-slate-900">
              Override room conflict warning
            </p>
            <p className="mt-1 text-sm text-slate-600">
              Allows booking to continue even if the selected room overlaps another booking.
              Your own overlapping bookings are still blocked.
            </p>
          </div>
        </label>

        <div className="rounded-2xl border bg-slate-50 p-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h3 className="text-lg font-semibold text-slate-900">Rental Slots</h3>
              <p className="mt-1 text-sm text-slate-600">
                Add one or more future floor rental sessions.
              </p>
            </div>

            <div className="flex items-center gap-3">
              <span className="rounded-full bg-white px-3 py-1 text-sm text-slate-700 ring-1 ring-slate-200">
                {slotCount} slot{slotCount === 1 ? "" : "s"}
              </span>

              <button
                type="button"
                onClick={addSlot}
                className="rounded-xl border px-4 py-2 hover:bg-white"
              >
                Add Slot
              </button>
            </div>
          </div>

          <div className="mt-5 space-y-4">
            {slots.map((slot, index) => (
              <div
                key={slot.id}
                className="rounded-2xl border border-slate-200 bg-white p-4"
              >
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="font-medium text-slate-900">Slot {index + 1}</p>
                    <p className="mt-1 text-xs text-slate-500">
                      {formatSlotLabel(slot)}
                    </p>
                  </div>

                  <button
                    type="button"
                    onClick={() => removeSlot(slot.id)}
                    disabled={slots.length === 1}
                    className="rounded-xl border px-3 py-1.5 text-sm hover:bg-slate-50 disabled:opacity-50"
                  >
                    Remove
                  </button>
                </div>

                <div className="mt-4 grid gap-4 md:grid-cols-3">
                  <div>
                    <label className="mb-1 block text-sm font-medium">Date</label>
                    <input
                      type="date"
                      min={getTodayDateInputValue()}
                      value={slot.date}
                      onChange={(e) =>
                        updateSlot(slot.id, { date: e.target.value })
                      }
                      className="w-full rounded-xl border border-slate-300 px-3 py-2"
                    />
                  </div>

                  <div>
                    <label className="mb-1 block text-sm font-medium">
                      Start Time
                    </label>
                    <input
                      type="time"
                      value={slot.startTime}
                      onChange={(e) =>
                        updateSlot(slot.id, { startTime: e.target.value })
                      }
                      className="w-full rounded-xl border border-slate-300 px-3 py-2"
                    />
                  </div>

                  <div>
                    <label className="mb-1 block text-sm font-medium">
                      End Time
                    </label>
                    <input
                      type="time"
                      value={slot.endTime}
                      onChange={(e) =>
                        updateSlot(slot.id, { endTime: e.target.value })
                      }
                      className="w-full rounded-xl border border-slate-300 px-3 py-2"
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {clientValidationError ? (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            {clientValidationError}
          </div>
        ) : null}

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

        <div className="flex flex-wrap gap-3">
          <button
            type="submit"
            disabled={pending || !!clientValidationError}
            className="rounded-xl bg-slate-900 px-4 py-2 text-white hover:bg-slate-800 disabled:opacity-60"
          >
            {pending ? "Booking..." : "Book Floor Rentals"}
          </button>
        </div>
      </form>
    </div>
  );
}