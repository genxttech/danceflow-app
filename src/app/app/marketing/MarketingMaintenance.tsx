import Link from "next/link";
import { MARKETING_PAUSED_NOTICE } from "@/lib/marketing/compliance/sendFreeze";

/**
 * Marketing M-0: shown while marketing sends are frozen (release / rollback transition). During the freeze campaign rows
 * are hidden from signed-in users by the database, so pages explain the maintenance state instead of a "not found".
 */
export function MarketingPausedBanner({ paused }: { paused: boolean }) {
  if (!paused) return null;
  return (
    <div role="status" className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-800 shadow-sm">
      {MARKETING_PAUSED_NOTICE}
    </div>
  );
}

export function MarketingMaintenancePanel({ backHref, backLabel }: { backHref: string; backLabel: string }) {
  return (
    <main className="min-h-screen bg-[var(--brand-page-bg)] px-4 py-10 text-[var(--brand-text)] sm:px-6">
      <div className="mx-auto max-w-xl">
        <section role="status" className="rounded-3xl border border-amber-200 bg-amber-50 p-6 text-amber-900 shadow-sm">
          <h1 className="text-xl font-bold">Marketing maintenance</h1>
          <p className="mt-3 text-sm leading-6">{MARKETING_PAUSED_NOTICE}</p>
          <p className="mt-3 text-sm leading-6">
            Campaigns are temporarily hidden while sending is paused. Nothing has been deleted.
          </p>
          <Link href={backHref} className="mt-5 inline-flex rounded-2xl bg-[#4D1F47] px-5 py-3 text-sm font-semibold text-white">
            {backLabel}
          </Link>
        </section>
      </div>
    </main>
  );
}
