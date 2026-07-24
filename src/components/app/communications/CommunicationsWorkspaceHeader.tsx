import Link from "next/link";
import type { ReactNode } from "react";
import WorkspaceHeader from "@/components/app/workspace/WorkspaceHeader";

export type CommunicationsWorkspaceView = {
  id: string;
  label: string;
  description: string;
};

export default function CommunicationsWorkspaceHeader({
  activeView,
  views,
  actions,
  summary,
}: {
  activeView: string;
  views: CommunicationsWorkspaceView[];
  actions?: ReactNode;
  summary: ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-[28px] border border-violet-200/80 bg-white shadow-[0_18px_45px_rgba(76,29,149,0.09)]">
      <WorkspaceHeader
        eyebrow="Relationship operations"
        title="Communications"
        description="Manage client conversations, follow-ups, broadcasts, and delivery health without moving between disconnected tools."
        actions={actions}
      />

      {summary}

      <nav
        aria-label="Communications workspace"
        className="flex gap-2 overflow-x-auto border-t border-violet-100 bg-[linear-gradient(135deg,#faf5ff_0%,#fff7ed_100%)] p-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {views.map((view) => (
          <Link
            key={view.id}
            href={`/app/communications?view=${view.id}`}
            aria-current={activeView === view.id ? "page" : undefined}
            className={`min-w-[142px] shrink-0 rounded-xl px-4 py-2.5 transition sm:min-w-[168px] ${
              activeView === view.id
                ? "bg-[linear-gradient(135deg,#111827_0%,#4c1d95_62%,#f97316_150%)] text-white shadow-sm"
                : "border border-transparent text-slate-700 hover:border-violet-100 hover:bg-white"
            }`}
          >
            <span className="block text-sm font-semibold">{view.label}</span>
            <span
              className={`mt-0.5 block line-clamp-1 text-xs ${
                activeView === view.id ? "text-white/75" : "text-slate-500"
              }`}
            >
              {view.description}
            </span>
          </Link>
        ))}
      </nav>
    </section>
  );
}
