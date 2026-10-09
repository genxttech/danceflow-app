"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { activeNavKey, competitionNav } from "@/lib/competition/workspaceNav";

export default function CompetitionNav({ eventId }: { eventId: string }) {
  const pathname = usePathname();
  const active = activeNavKey(eventId, pathname ?? "");
  const items = competitionNav(eventId);

  return (
    <nav aria-label="Competition workspace" className="lg:sticky lg:top-4 lg:self-start">
      <ul className="flex gap-1 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible lg:pb-0">
        {items.map((item) => {
          const isActive = item.key === active;
          const base = `flex shrink-0 items-center justify-between gap-3 rounded-lg px-3 py-2 text-sm ${item.child ? "lg:ml-4 lg:py-1.5 lg:text-[13px]" : ""}`;
          if (!item.available || !item.href) {
            return (
              <li key={item.key}>
                <span
                  aria-disabled="true"
                  title={item.note}
                  className={`${base} cursor-not-allowed text-slate-400`}
                >
                  <span>{item.label}</span>
                  <span className="hidden rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-500 lg:inline">Later</span>
                </span>
              </li>
            );
          }
          return (
            <li key={item.key}>
              <Link
                href={item.href}
                aria-current={isActive ? "page" : undefined}
                className={`${base} ${isActive ? "bg-slate-950 font-semibold text-white" : "text-slate-700 hover:bg-slate-100"}`}
              >
                <span>{item.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
