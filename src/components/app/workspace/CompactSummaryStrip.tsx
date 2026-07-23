import type { ReactNode } from "react";
import { classNames } from "./classNames";

export type CompactSummaryItem = {
  key: string;
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  tone?: "default" | "success" | "warning" | "danger" | "info";
};

function toneClass(tone: CompactSummaryItem["tone"]) {
  if (tone === "success") return "text-emerald-700";
  if (tone === "warning") return "text-amber-700";
  if (tone === "danger") return "text-rose-700";
  if (tone === "info") return "text-sky-700";
  return "text-[var(--brand-text)]";
}

export default function CompactSummaryStrip({
  items,
  className,
}: {
  items: CompactSummaryItem[];
  className?: string;
}) {
  if (!items.length) return null;

  return (
    <div
      className={classNames(
        "flex gap-0 overflow-x-auto px-4 sm:px-6 lg:px-8",
        className,
      )}
    >
      {items.map((item, index) => (
        <div
          key={item.key}
          className={classNames(
            "min-w-[9rem] shrink-0 py-3 pr-5",
            index > 0 && "border-l border-[var(--brand-border)] pl-5",
          )}
        >
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--brand-muted)]">
            {item.label}
          </p>
          <div className={classNames("mt-1 text-xl font-semibold", toneClass(item.tone))}>
            {item.value}
          </div>
          {item.detail ? (
            <div className="mt-0.5 text-xs text-[var(--brand-muted)]">{item.detail}</div>
          ) : null}
        </div>
      ))}
    </div>
  );
}
