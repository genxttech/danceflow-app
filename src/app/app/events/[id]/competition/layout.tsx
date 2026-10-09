import type { ReactNode } from "react";
import Link from "next/link";
import { requireCompetitionWorkspace } from "@/lib/competition/workspaceServer";
import { COMPETITIONS_HREF } from "@/lib/competition/workspaceLink";
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
        <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-2 text-sm font-medium text-slate-600">
          <Link href={COMPETITIONS_HREF} className="hover:text-slate-950">Competitions</Link>
          <span aria-hidden="true">/</span>
          <Link href={`/app/events/${id}`} className="hover:text-slate-950">Event details</Link>
        </nav>
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
