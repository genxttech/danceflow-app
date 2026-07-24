import type { ReactNode } from "react";
import { Inbox } from "lucide-react";

export default function SellWorkspaceEmptyState({
  title,
  description,
  action,
  compact = false,
}: {
  title: string;
  description: string;
  action?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div
      className={`rounded-2xl border border-dashed border-[var(--brand-border)] bg-[var(--brand-surface)] text-center ${
        compact ? "px-5 py-6" : "px-6 py-10"
      }`}
    >
      <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-2xl bg-white text-[var(--brand-primary)] shadow-sm">
        <Inbox className="h-5 w-5" />
      </div>
      <h2 className="mt-4 text-lg font-semibold text-[var(--brand-text)]">
        {title}
      </h2>
      <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-[var(--brand-muted)]">
        {description}
      </p>
      {action ? <div className="mt-5 flex justify-center">{action}</div> : null}
    </div>
  );
}
