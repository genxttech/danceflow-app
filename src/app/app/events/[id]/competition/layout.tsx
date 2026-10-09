import type { ReactNode } from "react";
import Link from "next/link";
import { requireCompetitionWorkspace } from "@/lib/competition/workspaceServer";
import CompetitionNav from "./CompetitionNav";

export default async function CompetitionWorkspaceLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { event } = await requireCompetitionWorkspace(id);

  return (
    <div className="mx-auto w-full max-w-[90rem] px-4 py-6 sm:px-6">
      <div className="mb-5">
        <Link href={`/app/events/${id}`} className="text-sm font-medium text-slate-600 hover:text-slate-950">
          Back to event
        </Link>
        <p className="mt-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Competition</p>
        <h1 className="text-xl font-semibold text-slate-950">{event.name}</h1>
      </div>
      <div className="grid gap-6 lg:grid-cols-[13.5rem_minmax(0,1fr)]">
        <CompetitionNav eventId={id} />
        <div className="min-w-0">{children}</div>
      </div>
    </div>
  );
}
