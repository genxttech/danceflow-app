import Image from "next/image";
import {
  chooseExplorerPathAction,
  chooseOrganizerPathAction,
  chooseStudioPathAction,
} from "./actions";
import PublicSiteHeader from "@/components/public/PublicSiteHeader";
import PublicSiteFooter from "@/components/public/PublicSiteFooter";
import { createClient } from "@/lib/supabase/server";

export default async function GetStartedPage() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  return (
    <>
      <PublicSiteHeader currentPath="pricing" isAuthenticated={!!user} />

      <main className="min-h-screen bg-[linear-gradient(180deg,#fff7ed_0%,#ffffff_18%,#f8fafc_100%)]">
        <section className="border-b border-slate-200/70">
          <div className="mx-auto max-w-7xl px-6 py-14 lg:px-8 lg:py-20">
            <div className="mx-auto max-w-5xl">
              <div className="grid gap-10 lg:grid-cols-[0.9fr_1.1fr] lg:items-center">
                <div className="flex justify-center lg:justify-start">
  <div className="overflow-hidden rounded-[36px] bg-white shadow-sm ring-1 ring-slate-200">
    <Image
      src="/brand/danceflow-path-hero.png"
      alt="DanceFlow dancers hero"
      width={900}
      height={600}
      className="h-[240px] w-full max-w-[520px] object-cover sm:h-[280px] lg:h-[320px]"
      priority
    />
  </div>
</div>

                <div className="text-center lg:text-left">
                  <p className="text-sm font-semibold uppercase tracking-[0.18em] text-[var(--brand-accent-dark)]">
                    Get Started
                  </p>

                  <h1 className="mt-3 text-4xl font-semibold tracking-tight text-slate-950 sm:text-5xl lg:text-6xl">
                    Choose your DanceFlow path
                  </h1>

                  <p className="mt-5 text-lg leading-8 text-slate-600">
                    DanceFlow is where studios grow and dancers connect. Start with
                    the path that fits how you want to use the platform — discovery,
                    studio operations, or event organizing.
                  </p>

                  <div className="mt-7 rounded-2xl border border-violet-200 bg-violet-50 px-5 py-4 text-left">
                    <p className="text-sm font-semibold uppercase tracking-[0.16em] text-violet-700">
                      One account, multiple ways to use DanceFlow
                    </p>
                    <p className="mt-2 text-sm leading-7 text-slate-600">
                      Dancers can use DanceFlow with a free discovery account.
                      Studios and organizers continue into transparent pricing and
                      trial options built for the business side of dance.
                    </p>
                  </div>
                </div>
              </div>

              <div className="mt-14 grid gap-6 lg:grid-cols-3">
                <section className="rounded-[32px] border border-orange-200 bg-white p-7 shadow-sm">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="text-sm font-semibold uppercase tracking-[0.14em] text-orange-600">
                        Discovery Account
                      </p>
                      <h2 className="mt-3 text-2xl font-semibold tracking-tight text-slate-900">
                        I’m here to explore
                      </h2>
                    </div>

                    <span className="rounded-full bg-orange-50 px-3 py-1 text-xs font-medium text-orange-700">
                      Free
                    </span>
                  </div>

                  <p className="mt-4 text-sm leading-7 text-slate-600">
                    Use DanceFlow as a dancer or member of the public to discover
                    studios and events, save favorites, and keep your registrations
                    organized from one place.
                  </p>

                  <div className="mt-5 space-y-2">
                    <div className="rounded-xl bg-orange-50 px-4 py-3 text-sm text-slate-700">
                      Favorite studios and events
                    </div>
                    <div className="rounded-xl bg-orange-50 px-4 py-3 text-sm text-slate-700">
                      Track events you register for
                    </div>
                    <div className="rounded-xl bg-orange-50 px-4 py-3 text-sm text-slate-700">
                      Search by city, state, ZIP, or near-me location
                    </div>
                  </div>

                  <form action={chooseExplorerPathAction} className="mt-6">
                    <button
                      type="submit"
                      className="w-full rounded-xl bg-orange-500 px-4 py-3 text-sm font-medium text-white hover:bg-orange-600"
                    >
                      Continue as Explorer
                    </button>
                  </form>
                </section>

                <section className="rounded-[32px] border border-violet-200 bg-white p-7 shadow-sm">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="text-sm font-semibold uppercase tracking-[0.14em] text-violet-600">
                        Studio Path
                      </p>
                      <h2 className="mt-3 text-2xl font-semibold tracking-tight text-slate-900">
                        I run a dance studio
                      </h2>
                    </div>

                    <span className="rounded-full bg-violet-50 px-3 py-1 text-xs font-medium text-violet-700">
                      Trial Available
                    </span>
                  </div>

                  <p className="mt-4 text-sm leading-7 text-slate-600">
                    Compare studio tiers, see feature differences clearly, and choose
                    the plan that fits your operations, staff, and growth goals.
                  </p>

                  <div className="mt-5 space-y-2">
                    <div className="rounded-xl bg-violet-50 px-4 py-3 text-sm text-slate-700">
                      CRM, scheduling, packages, memberships, and payments
                    </div>
                    <div className="rounded-xl bg-violet-50 px-4 py-3 text-sm text-slate-700">
                      Public studio profile and lead capture
                    </div>
                    <div className="rounded-xl bg-violet-50 px-4 py-3 text-sm text-slate-700">
                      Transparent pricing and feature comparison
                    </div>
                  </div>

                  <form action={chooseStudioPathAction} className="mt-6">
                    <button
                      type="submit"
                      className="w-full rounded-xl bg-violet-600 px-4 py-3 text-sm font-medium text-white hover:bg-violet-700"
                    >
                      View Studio Pricing
                    </button>
                  </form>
                </section>

                <section className="rounded-[32px] border border-sky-200 bg-white p-7 shadow-sm">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="text-sm font-semibold uppercase tracking-[0.14em] text-sky-600">
                        Organizer Path
                      </p>
                      <h2 className="mt-3 text-2xl font-semibold tracking-tight text-slate-900">
                        I organize events
                      </h2>
                    </div>

                    <span className="rounded-full bg-sky-50 px-3 py-1 text-xs font-medium text-sky-700">
                      Trial Available
                    </span>
                  </div>

                  <p className="mt-4 text-sm leading-7 text-slate-600">
                    Continue into organizer pricing for public event publishing,
                    registrations, ticketing, and event visibility tools.
                  </p>

                  <div className="mt-5 space-y-2">
                    <div className="rounded-xl bg-sky-50 px-4 py-3 text-sm text-slate-700">
                      Publish searchable public events
                    </div>
                    <div className="rounded-xl bg-sky-50 px-4 py-3 text-sm text-slate-700">
                      Manage registrations and ticket sales
                    </div>
                    <div className="rounded-xl bg-sky-50 px-4 py-3 text-sm text-slate-700">
                      Clear pricing before you start
                    </div>
                  </div>

                  <form action={chooseOrganizerPathAction} className="mt-6">
                    <button
                      type="submit"
                      className="w-full rounded-xl bg-sky-600 px-4 py-3 text-sm font-medium text-white hover:bg-sky-700"
                    >
                      View Organizer Pricing
                    </button>
                  </form>
                </section>
              </div>

              <div className="mt-10 rounded-[32px] border border-slate-200 bg-white p-7 shadow-sm">
                <div className="grid gap-6 lg:grid-cols-[1fr_auto] lg:items-center">
                  <div>
                    <p className="text-sm font-semibold uppercase tracking-[0.16em] text-[var(--brand-accent-dark)]">
                      Why this step exists
                    </p>
                    <h2 className="mt-3 text-2xl font-semibold tracking-tight text-slate-900">
                      DanceFlow supports discovery and business growth in one platform
                    </h2>
                    <p className="mt-3 max-w-3xl text-sm leading-7 text-slate-600">
                      The free discovery path is built for dancers and the public.
                      Studio and organizer paths continue into business pricing so users
                      only see the tools, features, and costs that match how they plan
                      to use DanceFlow.
                    </p>
                  </div>

                  <div className="flex flex-wrap gap-3">
                    <form action={chooseExplorerPathAction}>
                      <button
                        type="submit"
                        className="rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
                      >
                        Free Discovery Path
                      </button>
                    </form>

                    <div className="inline-flex items-center rounded-xl bg-slate-100 px-4 py-2.5 text-sm font-medium text-slate-500">
                      Choose above to continue
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>
      </main>

      <PublicSiteFooter />
    </>
  );
}