"use client";

import type { ReactNode } from "react";
import { X } from "lucide-react";
import { classNames } from "./classNames";

export default function ResponsiveDetailPanel({
  open,
  title,
  description,
  children,
  footer,
  onClose,
  className,
}: {
  open: boolean;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  className?: string;
}) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 2xl:hidden">
      <button
        type="button"
        className="absolute inset-0 bg-slate-950/35"
        onClick={onClose}
        aria-label="Close detail panel"
      />
      <aside
        className={classNames(
          "absolute inset-x-0 bottom-0 flex max-h-[92vh] flex-col rounded-t-3xl border border-[var(--brand-border)] bg-white shadow-2xl sm:inset-y-0 sm:left-auto sm:right-0 sm:max-h-none sm:w-full sm:max-w-xl sm:rounded-none sm:border-y-0 sm:border-r-0",
          className,
        )}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="flex items-start justify-between gap-3 border-b border-[var(--brand-border)] px-5 py-4">
          <div className="min-w-0">
            <h2 className="truncate text-lg font-semibold text-[var(--brand-text)]">{title}</h2>
            {description ? (
              <p className="mt-1 text-sm text-[var(--brand-muted)]">{description}</p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-[var(--brand-border)] text-[var(--brand-muted)] hover:bg-[var(--brand-primary-soft)] hover:text-[var(--brand-primary)]"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
        {footer ? (
          <div className="border-t border-[var(--brand-border)] bg-white px-5 py-4">{footer}</div>
        ) : null}
      </aside>
    </div>
  );
}
