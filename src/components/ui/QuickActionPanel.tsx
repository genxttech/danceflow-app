"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

export default function QuickActionPanel({
  title,
  description,
  defaultOpen = false,
  children,
}: {
  title: string;
  description?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="rounded-2xl border bg-white shadow-sm">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-4 px-6 py-4 text-left"
      >
        <div>
          <h3 className="text-lg font-semibold text-slate-900">{title}</h3>
          {description ? (
            <p className="mt-1 text-sm text-slate-600">{description}</p>
          ) : null}
        </div>

        <span className="shrink-0 text-slate-500">
          {open ? <ChevronDown className="h-5 w-5" /> : <ChevronRight className="h-5 w-5" />}
        </span>
      </button>

      {open ? <div className="border-t px-6 py-5">{children}</div> : null}
    </div>
  );
}