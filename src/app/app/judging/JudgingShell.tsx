import type { ReactNode } from "react";
import Link from "next/link";

/**
 * OJ-1: the minimal frame for an official who is not studio staff (for example an organizer-team judge). It shows no studio navigation, no
 * studio data and no workspace switcher; it links only to the official's own assignments. Rendered by the /app layout only after the server
 * checked an active official assignment for the event in the URL.
 */
export default function JudgingShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between px-4 py-3 sm:px-6">
          <Link href="/app/judging" className="text-sm font-semibold text-slate-950">
            DanceFlow Judging
          </Link>
          <Link href="/account" className="text-sm text-slate-600 hover:text-slate-950">
            Account
          </Link>
        </div>
      </header>
      <main>{children}</main>
    </div>
  );
}
