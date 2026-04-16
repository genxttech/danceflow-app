"use client";

import { useActionState } from "react";
import { updateRoomAction } from "../../actions";

const initialState = { error: "" };

type RoomRecord = {
  id: string;
  name: string;
  capacity: number | null;
  active: boolean;
};

export default function RoomEditForm({
  room,
}: {
  room: RoomRecord;
}) {
  const [state, formAction, pending] = useActionState(
    updateRoomAction,
    initialState
  );

  return (
    <div className="max-w-2xl">
      <h2 className="text-3xl font-semibold tracking-tight">Edit Room</h2>
      <p className="mt-2 text-slate-600">Update room details.</p>

      <form action={formAction} className="mt-8 space-y-4 rounded-2xl border bg-white p-6">
        <input type="hidden" name="roomId" value={room.id} />

        <div>
          <label htmlFor="name" className="mb-1 block text-sm font-medium">
            Room Name
          </label>
          <input
            id="name"
            name="name"
            defaultValue={room.name}
            required
            className="w-full rounded-xl border border-slate-300 px-3 py-2"
          />
        </div>

        <div>
          <label htmlFor="capacity" className="mb-1 block text-sm font-medium">
            Capacity
          </label>
          <input
            id="capacity"
            name="capacity"
            type="number"
            min="0"
            defaultValue={room.capacity ?? ""}
            className="w-full rounded-xl border border-slate-300 px-3 py-2"
          />
        </div>

        <div>
          <label htmlFor="active" className="mb-1 block text-sm font-medium">
            Status
          </label>
          <select
            id="active"
            name="active"
            defaultValue={room.active ? "true" : "false"}
            className="w-full rounded-xl border border-slate-300 px-3 py-2"
          >
            <option value="true">Active</option>
            <option value="false">Inactive</option>
          </select>
        </div>

        {state?.error ? (
          <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {state.error}
          </div>
        ) : null}

        <div className="flex gap-3">
          <button
            type="submit"
            disabled={pending}
            className="rounded-xl bg-slate-900 px-4 py-2 text-white hover:bg-slate-800 disabled:opacity-60"
          >
            {pending ? "Saving..." : "Save Changes"}
          </button>

          <a
            href={`/app/rooms/${room.id}`}
            className="rounded-xl border px-4 py-2 text-slate-700 hover:bg-slate-50"
          >
            Cancel
          </a>
        </div>
      </form>
    </div>
  );
}