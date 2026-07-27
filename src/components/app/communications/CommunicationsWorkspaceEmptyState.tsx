import type { ReactNode } from "react";
import { MessageSquareText } from "lucide-react";

export default function CommunicationsWorkspaceEmptyState({
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
      className={`rounded-[24px] border border-dashed border-violet-200 bg-[linear-gradient(135deg,#faf5ff_0%,#fff7ed_100%)] text-center ${
        compact ? "p-5" : "p-7 sm:p-8"
      }`}
    >
      <span className="mx-auto flex h-10 w-10 items-center justify-center rounded-2xl border border-violet-200 bg-white text-violet-700 shadow-sm">
        <MessageSquareText className="h-5 w-5" />
      </span>
      <p className="mt-3 text-base font-semibold text-slate-950">{title}</p>
      <p className="mx-auto mt-1.5 max-w-xl text-sm leading-6 text-slate-600">
        {description}
      </p>
      {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
    </div>
  );
}
