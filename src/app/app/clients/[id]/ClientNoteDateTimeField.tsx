"use client";

import { useEffect, useMemo, useState } from "react";

function toLocalDateTimeInputValue(date: Date) {
  const offsetMs = date.getTimezoneOffset() * 60 * 1000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

function toIsoOrEmpty(value: string) {
  if (!value) return "";

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString();
}

export default function ClientNoteDateTimeField() {
  const [localValue, setLocalValue] = useState("");

  useEffect(() => {
    setLocalValue(toLocalDateTimeInputValue(new Date()));
  }, []);

  const occurredAtIso = useMemo(
    () => toIsoOrEmpty(localValue),
    [localValue],
  );

  return (
    <div>
      <label
        htmlFor="clientNoteOccurredAtLocal"
        className="mb-1 block text-sm font-medium text-[var(--brand-text)]"
      >
        Date / time
      </label>

      <input
        id="clientNoteOccurredAtLocal"
        type="datetime-local"
        value={localValue}
        onChange={(event) => setLocalValue(event.target.value)}
        required
        className="w-full rounded-xl border border-[#E9D5FF] bg-white px-3 py-2 text-sm"
      />

      <input
        type="hidden"
        name="occurredAt"
        value={occurredAtIso}
      />

      <p className="mt-1 text-xs text-slate-500">
        Uses the local time on this device.
      </p>
    </div>
  );
}
