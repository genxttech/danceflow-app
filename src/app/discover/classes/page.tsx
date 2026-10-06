import type { Metadata } from "next";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { fetchPublicGroupClasses } from "@/lib/public/groupClasses";
import PublicClassCard from "@/components/public/PublicClassCard";

export const metadata: Metadata = {
  title: "Find Dance Classes",
};

// Public and signed-out friendly; availability is read live from the database.
export const dynamic = "force-dynamic";

export default async function DiscoverClassesPage() {
  const supabase = await createClient();
  const classes = await fetchPublicGroupClasses(supabase, { limit: 100 });

  return (
    <main className="min-h-screen bg-[linear-gradient(180deg,#fff7ed_0%,#f8fafc_34%,#ffffff_100%)] text-slate-900">
      <section className="mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-8 lg:py-14">
        <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[var(--brand-accent-dark)]">Classes</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">Find a dance class</h1>
        <p className="mt-3 max-w-2xl text-base leading-7 text-slate-600">
          Upcoming group classes from studios on DanceFlow. Looking for socials, workshops or competitions instead?{" "}
          <Link href="/discover/events" className="font-semibold text-[var(--brand-primary)] underline">
            Browse events
          </Link>
          .
        </p>

        {classes.length === 0 ? (
          <div className="mt-8 rounded-3xl border border-slate-200 bg-white p-8 text-center shadow-sm">
            <h2 className="text-lg font-semibold text-slate-950">No upcoming classes are listed yet</h2>
            <p className="mt-2 text-sm text-slate-600">Check back soon, or explore studios to see what they offer.</p>
            <Link
              href="/discover/studios"
              className="mt-5 inline-flex rounded-2xl bg-slate-950 px-4 py-3 text-sm font-semibold text-white hover:bg-slate-800"
            >
              Explore studios
            </Link>
          </div>
        ) : (
          <div className="mt-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {classes.map((item) => (
              <PublicClassCard key={item.appointmentId} item={item} />
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
