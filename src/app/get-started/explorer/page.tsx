import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { continueExplorerIntoDiscoveryAction } from "../actions";

export default async function ExplorerGetStartedPage() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  return (
    <main className="min-h-screen bg-[linear-gradient(180deg,#fff7ed_0%,#ffffff_22%,#f8fafc_100%)]">
      <section className="mx-auto max-w-6xl px-6 py-14 lg:px-8 lg:py-20">
        <div className="mx-auto max-w-3xl text-center">
          <p className="text-sm font-semibold uppercase tracking-[0.18em] text-orange-600">
            Free Discovery Account
          </p>
          <h1 className="mt-3 text-4xl font-semibold tracking-tight text-slate-950 sm:text-5xl">
            Your DanceFlow account is ready
          </h1>
          <p className="mt-4 text-lg leading-8 text-slate-600">
            Use your free account to explore studios, events, partner listings,
            job postings, and your own dancer profile inside DanceFlow.
          </p>
        </div>

        <div className="mt-12 grid gap-6 lg:grid-cols-2">
          <div className="rounded-[32px] border border-slate-200 bg-white p-7 shadow-sm">
            <h2 className="text-2xl font-semibold tracking-tight text-slate-900">
              What your free account is for
            </h2>

            <div className="mt-6 grid gap-4">
              <div className="rounded-2xl bg-slate-50 p-5">
                <p className="font-medium text-slate-900">Discover studios</p>
                <p className="mt-1 text-sm leading-6 text-slate-600">
                  Search public studio profiles and find places that match your goals,
                  styles, and experience level.
                </p>
              </div>

              <div className="rounded-2xl bg-slate-50 p-5">
                <p className="font-medium text-slate-900">Browse events</p>
                <p className="mt-1 text-sm leading-6 text-slate-600">
                  Explore classes, workshops, socials, and public dance events from
                  one account.
                </p>
              </div>

              <div className="rounded-2xl bg-slate-50 p-5">
                <p className="font-medium text-slate-900">Create a partner profile</p>
                <p className="mt-1 text-sm leading-6 text-slate-600">
                  Look for practice, social, showcase, or competition partners.
                  Keep communication inside DanceFlow and hide your profile anytime.
                </p>
              </div>

              <div className="rounded-2xl bg-slate-50 p-5">
                <p className="font-medium text-slate-900">Find dance opportunities</p>
                <p className="mt-1 text-sm leading-6 text-slate-600">
                  Browse studio job postings, save favorites, and keep your dancer
                  activity connected to one account.
                </p>
              </div>
            </div>
          </div>

          <div className="rounded-[32px] border border-orange-200 bg-white p-7 shadow-sm">
            <p className="text-sm font-semibold uppercase tracking-[0.14em] text-orange-600">
              Next Steps
            </p>
            <h2 className="mt-3 text-2xl font-semibold tracking-tight text-slate-900">
              Start exploring now
            </h2>

            <div className="mt-6 grid gap-4">
              <Link
                href="/discover/studios"
                className="rounded-2xl border bg-slate-50 p-5 hover:bg-slate-100"
              >
                <p className="font-medium text-slate-900">Find studios</p>
                <p className="mt-1 text-sm text-slate-600">
                  Browse public studio pages and see what is near you.
                </p>
              </Link>

              <Link
                href="/discover/events"
                className="rounded-2xl border bg-slate-50 p-5 hover:bg-slate-100"
              >
                <p className="font-medium text-slate-900">Find events</p>
                <p className="mt-1 text-sm text-slate-600">
                  Browse workshops, classes, socials, and other public events.
                </p>
              </Link>

              <Link
                href="/discover/partners"
                className="rounded-2xl border bg-slate-50 p-5 hover:bg-slate-100"
              >
                <p className="font-medium text-slate-900">Find a partner</p>
                <p className="mt-1 text-sm text-slate-600">
                  Search dancer profiles by goals, role, level, location, and style.
                </p>
              </Link>

              <Link
                href="/account/partner-search"
                className="rounded-2xl border border-orange-200 bg-orange-50 p-5 hover:bg-orange-100"
              >
                <p className="font-medium text-slate-900">Create your dancer profile</p>
                <p className="mt-1 text-sm text-slate-600">
                  Add or pause your Partner Search profile from your account.
                </p>
              </Link>

              <Link
                href="/discover/jobs"
                className="rounded-2xl border bg-slate-50 p-5 hover:bg-slate-100"
              >
                <p className="font-medium text-slate-900">Browse dance jobs</p>
                <p className="mt-1 text-sm text-slate-600">
                  Find instructor, coach, front desk, event staff, and studio roles.
                </p>
              </Link>
            </div>

            <form action={continueExplorerIntoDiscoveryAction} className="mt-6">
              <button
                type="submit"
                className="w-full rounded-xl bg-orange-500 px-4 py-3 text-sm font-medium text-white hover:bg-orange-600"
              >
                Enter Discovery
              </button>
            </form>
          </div>
        </div>
      </section>
    </main>
  );
}
