"use client";

import { useState } from "react";

export default function ConfirmActionForm({
  action,
  title,
  description,
  buttonLabel,
  confirmLabel = "I understand this will affect multiple lessons",
  buttonClassName = "rounded-xl bg-red-600 px-4 py-2 text-white hover:bg-red-700",
  children,
}: {
  action: (formData: FormData) => void | Promise<void>;
  title: string;
  description: string;
  buttonLabel: string;
  confirmLabel?: string;
  buttonClassName?: string;
  children: React.ReactNode;
}) {
  const [confirmed, setConfirmed] = useState(false);

  return (
    <form action={action} className="rounded-xl border border-red-200 bg-red-50 p-4">
      {children}

      <p className="font-medium text-slate-900">{title}</p>
      <p className="mt-1 text-sm text-slate-600">{description}</p>

      <label className="mt-4 flex items-start gap-3 rounded-xl border border-red-200 bg-white p-3">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
          className="mt-1"
        />
        <span className="text-sm text-slate-700">{confirmLabel}</span>
      </label>

      <button
        type="submit"
        disabled={!confirmed}
        className={`${buttonClassName} mt-4 disabled:cursor-not-allowed disabled:opacity-50`}
      >
        {buttonLabel}
      </button>
    </form>
  );
}