"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import type { PublicNavChild } from "./publicNav";

const focusRing =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand-primary)]";

/**
 * Desktop "For Business" disclosure. A plain disclosure (button + links), not an ARIA menu:
 * it closes on Escape (focus returns to the trigger), on outside click and on route change.
 * Below the `lg` breakpoint the same links are rendered inline in the mobile panel instead.
 */
export default function ForBusinessMenu({
  label,
  items,
  active,
}: {
  label: string;
  items: PublicNavChild[];
  active: boolean;
}) {
  const pathname = usePathname();
  const panelId = useId();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Remember where the menu was opened; navigating elsewhere closes it without an effect.
  const [openedAt, setOpenedAt] = useState<string | null>(null);
  const open = openedAt !== null && openedAt === pathname;

  useEffect(() => {
    if (!open) return;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpenedAt(null);
        triggerRef.current?.focus();
      }
    }
    function onPointerDown(event: MouseEvent | TouchEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) {
        setOpenedAt(null);
      }
    }

    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("touchstart", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("touchstart", onPointerDown);
    };
  }, [open]);

  const state = active
    ? "bg-[var(--brand-primary-soft)] text-[var(--brand-primary)]"
    : "text-slate-600 hover:bg-slate-100 hover:text-slate-900";

  return (
    <div ref={wrapperRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpenedAt(open ? null : pathname)}
        className={`inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-sm font-medium ${state} ${focusRing}`}
      >
        {label}
        <svg
          aria-hidden="true"
          viewBox="0 0 20 20"
          className={`h-4 w-4 transition ${open ? "rotate-180" : ""}`}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M5 8l5 5 5-5" />
        </svg>
      </button>

      <div
        id={panelId}
        hidden={!open}
        className="absolute left-0 top-full z-50 mt-2 w-64 rounded-2xl border border-slate-200 bg-white p-2 shadow-lg"
      >
        {items.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            aria-current={pathname === item.href ? "page" : undefined}
            className={`block rounded-xl px-3 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-100 hover:text-slate-900 ${focusRing}`}
          >
            {item.label}
          </Link>
        ))}
      </div>
    </div>
  );
}
