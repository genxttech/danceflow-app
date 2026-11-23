"use client";

import { useState, type ReactNode } from "react";

/** Two-step submit button: the first click asks "are you sure?", the second click submits the surrounding form. */
export default function ConfirmButton({
  children,
  confirmLabel = "Yes, continue",
  className,
  disabled,
}: {
  children: ReactNode;
  confirmLabel?: string;
  className?: string;
  disabled?: boolean;
}) {
  const [asking, setAsking] = useState(false);
  if (!asking) {
    return (
      <button type="button" className={className} disabled={disabled} onClick={() => setAsking(true)}>
        {children}
      </button>
    );
  }
  return (
    <span className="inline-flex items-center gap-2" role="group" aria-label="Confirm">
      <button type="submit" className={className} disabled={disabled}>
        {confirmLabel}
      </button>
      <button type="button" className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700" onClick={() => setAsking(false)}>
        Cancel
      </button>
    </span>
  );
}
