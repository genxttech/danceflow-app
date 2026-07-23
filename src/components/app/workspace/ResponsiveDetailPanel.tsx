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
    <div className="fixed inset-0 z-50">
      <button
        type="button"
        className="absolute inset-0 bg-slate-950/45 backdrop-blur-[2px]"
        onClick={onClose}
        aria-label="Close detail panel"
      />
      <aside
        className={classNames(
          "absolute inset-x-0 bottom-0 flex max-h-[92vh] flex-col rounded-t-3xl border border-violet-200 bg-[linear-gradient(180deg,#faf5ff_0%,#ffffff_34%,#fff7ed_100%)] shadow-2xl sm:inset-y-0 sm:left-auto sm:right-0 sm:max-h-none sm:w-full sm:max-w-xl sm:rounded-none sm:border-y-0 sm:border-r-0",
          className,
        )}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="flex items-start justify-between gap-3 border-b border-white/15 bg-[linear-gradient(135deg,#111827_0%,#4c1d95_52%,#f97316_145%)] px-5 py-5 text-white">
          <div className="min-w-0">
            <h2 className="truncate text-lg font-semibold text-white">{title}</h2>
            {description ? (
              <p className="mt-1 text-sm text-white/80">{description}</p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-white/20 bg-white/10 text-white hover:bg-white/15"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
        {footer ? (
          <div className="border-t border-violet-200 bg-white/95 px-5 py-4 shadow-[0_-12px_35px_rgba(76,29,149,0.10)] backdrop-blur">{footer}</div>
        ) : null}
      </aside>
    </div>
  );
}
