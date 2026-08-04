"use client";

import { useActionState, useState } from "react";
import { updateStudioOperatingHoursAction } from "./actions";

type HoursRow = {
  weekday: number;
  is_closed: boolean;
  opens_at: string | null;
  closes_at: string | null;
};

const DAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

const initialState = { error: "" };

function trimTime(value: string | null, fallback: string) {
  return value?.slice(0, 5) || fallback;
}

export default function StudioOperatingHoursForm({
  hours,
}: {
  hours: HoursRow[];
}) {
  const [state, action, pending] = useActionState(
    updateStudioOperatingHoursAction,
    initialState,
  );

  const hoursByDay = new Map(hours.map((row) => [row.weekday, row]));
  const [closedDays, setClosedDays] = useState<Record<number, boolean>>(
    Object.fromEntries(
      DAYS.map((_, weekday) => [
        weekday,
        hoursByDay.get(weekday)?.is_closed ?? weekday === 0,
      ]),
    ),
  );

  return (
    <form action={action} className="space-y-5">
      {state.error ? (
        <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {state.error}
        </div>
      ) : null}

      <div className="overflow-hidden rounded-3xl border border-violet-200 bg-white shadow-sm">
        <div className="divide-y divide-slate-200">
          {DAYS.map((day, weekday) => {
            const row = hoursByDay.get(weekday);
            const closed = closedDays[weekday];

            return (
              <div
                key={day}
                className="grid gap-4 px-4 py-4 md:grid-cols-[160px_130px_1fr_1fr] md:items-center md:px-6"
              >
                <div>
                  <p className="font-semibold text-slate-950">{day}</p>
                </div>

                <label className="inline-flex items-center gap-2 text-sm font-medium text-slate-700">
                  <input
                    type="checkbox"
                    name={`closed_${weekday}`}
                    value="true"
                    checked={closed}
                    onChange={(event) =>
                      setClosedDays((current) => ({
                        ...current,
                        [weekday]: event.target.checked,
                      }))
                    }
                  />
                  Closed
                </label>

                <label className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Opens
                  <input
                    type="time"
                    name={`opens_${weekday}`}
                    defaultValue={trimTime(row?.opens_at ?? null, "09:00")}
                    disabled={closed}
                    required={!closed}
                    step={900}
                    className="mt-1 block w-full rounded-xl border border-slate-300 px-3 py-2 text-sm font-normal text-slate-950 disabled:bg-slate-100"
                  />
                </label>

                <label className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Closes
                  <input
                    type="time"
                    name={`closes_${weekday}`}
                    defaultValue={trimTime(row?.closes_at ?? null, "21:00")}
                    disabled={closed}
                    required={!closed}
                    step={900}
                    className="mt-1 block w-full rounded-xl border border-slate-300 px-3 py-2 text-sm font-normal text-slate-950 disabled:bg-slate-100"
                  />
                </label>
              </div>
            );
          })}
        </div>
      </div>

      <div className="flex justify-end">
        <button
          type="submit"
          disabled={pending}
          className="rounded-xl bg-[linear-gradient(135deg,#111827_0%,#4c1d95_62%,#f97316_150%)] px-5 py-3 text-sm font-semibold text-white shadow-sm disabled:opacity-60"
        >
          {pending ? "Saving…" : "Save studio hours"}
        </button>
      </div>
    </form>
  );
}
