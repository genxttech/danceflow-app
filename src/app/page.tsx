import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentUserPlatformRole } from "@/lib/auth/platform";
import PublicSiteHeader from "@/components/public/PublicSiteHeader";
import PublicSiteFooter from "@/components/public/PublicSiteFooter";

export default async function HomePage() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user) {
    const platformRole = await getCurrentUserPlatformRole();

    if (platformRole === "platform_admin") {
      redirect("/platform");
    }

    const { data: studioRole } = await supabase
      .from("user_studio_roles")
      .select("studio_id")
      .eq("user_id", user.id)
      .eq("active", true)
      .limit(1)
      .maybeSingle();

    if (studioRole) {
      redirect("/app");
    }

    redirect("/account");
  }

  return (
    <>
      <PublicSiteHeader currentPath="home" isAuthenticated={false} />

      <main className="min-h-screen bg-[linear-gradient(180deg,#fff7ed_0%,#ffffff_18%,#f8fafc_100%)]">
        <section className="border-b border-slate-200/70">
          <div className="mx-auto max-w-7xl px-6 py-14 lg:px-8 lg:py-20">
            <div className="grid gap-10 lg:grid-cols-[1.05fr_0.95fr] lg:items-center">
              <div>
                <p className="text-sm font-semibold uppercase tracking-[0.18em] text-[var(--brand-accent-dark)]">
                  Next-generation studio software for ballroom and country
                </p>

                <h1 className="mt-4 text-4xl font-semibold tracking-tight text-slate-950 sm:text-5xl lg:text-6xl">
                  Studio software for the business side of dance — and the dancers searching for it
                </h1>

                <p className="mt-5 max-w-2xl text-lg leading-8 text-slate-600">
                  DanceFlow helps studios and organizers manage CRM, scheduling,
                  memberships, payments, and events while giving dancers a better
                  way to discover studios, save favorites, and register for what is
                  happening nearby.
                </p>

                <div className="mt-8 flex flex-wrap gap-3">
                  <Link
                    href="/signup"
                    className="rounded-xl bg-slate-900 px-5 py-3 text-sm font-medium text-white hover:bg-slate-800"
                  >
                    Create Free Account
                  </Link>

                  <Link
                    href="/discover/studios"
                    className="rounded-xl border border-slate-200 bg-white px-5 py-3 text-sm font-medium text-slate-700 hover:bg-slate-50"
                  >
                    Explore Studios
                  </Link>

                  <Link
                    href="/discover/events"
                    className="rounded-xl border border-slate-200 bg-white px-5 py-3 text-sm font-medium text-slate-700 hover:bg-slate-50"
                  >
                    Explore Events
                  </Link>
                </div>

                <div className="mt-8 grid gap-3 sm:grid-cols-3">
                  <div className="rounded-2xl border border-orange-100 bg-white p-4 shadow-sm">
                    <p className="text-sm font-medium text-slate-900">For Dancers</p>
                    <p className="mt-1 text-sm text-slate-600">
                      Search studios and events, save favorites, and track registrations.
                    </p>
                  </div>

                  <div className="rounded-2xl border border-violet-100 bg-white p-4 shadow-sm">
                    <p className="text-sm font-medium text-slate-900">For Studios</p>
                    <p className="mt-1 text-sm text-slate-600">
                      Run scheduling, clients, memberships, packages, and payments in one place.
                    </p>
                  </div>

                  <div className="rounded-2xl border border-sky-100 bg-white p-4 shadow-sm">
                    <p className="text-sm font-medium text-slate-900">For Organizers</p>
                    <p className="mt-1 text-sm text-slate-600">
                      Publish events, manage registrations, and sell tickets with clear pricing.
                    </p>
                  </div>
                </div>
              </div>

              <div className="rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm">
                <div className="rounded-[28px] bg-[linear-gradient(135deg,#fff7ed_0%,#ede9fe_45%,#eff6ff_100%)] p-6">
                  <div className="grid gap-4">
                    <div className="rounded-2xl bg-white p-4 shadow-sm">
                      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-violet-700">
                        Studio Operations
                      </p>
                      <p className="mt-2 text-lg font-semibold text-slate-900">
                        CRM, lessons, memberships, and billing
                      </p>
                      <p className="mt-2 text-sm text-slate-600">
                        Give studios fewer clicks, cleaner workflows, and better visibility across daily operations.
                      </p>
                    </div>

                    <div className="rounded-2xl bg-white p-4 shadow-sm">
                      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-sky-700">
                        Public Discovery
                      </p>
                      <p className="mt-2 text-lg font-semibold text-slate-900">
                        Help dancers find the right studio or event faster
                      </p>
                      <p className="mt-2 text-sm text-slate-600">
                        Public users can browse, favorite, and return to what matters without starting over every time.
                      </p>
                    </div>

                    <div className="rounded-2xl bg-white p-4 shadow-sm">
                      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-orange-700">
                        Event Growth
                      </p>
                      <p className="mt-2 text-lg font-semibold text-slate-900">
                        Searchable event pages, registration, and ticketing
                      </p>
                      <p className="mt-2 text-sm text-slate-600">
                        Organizers can publish public events and manage the registration flow in one system.
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="mx-auto max-w-7xl px-6 py-14 lg:px-8">
          <div className="mx-auto max-w-3xl text-center">
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-[var(--brand-accent-dark)]">
              Why DanceFlow
            </p>
            <h2 className="mt-3 text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">
              Built for the real workflow of dance businesses
            </h2>
            <p className="mt-4 text-lg leading-8 text-slate-600">
              Dance studios need more than a simple calendar. Dancers need more
              than a static listing. DanceFlow brings both sides together.
            </p>
          </div>

          <div className="mt-10 grid gap-6 lg:grid-cols-3">
            <section className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
              <p className="text-sm font-semibold uppercase tracking-[0.16em] text-violet-700">
                Studio CRM
              </p>
              <h3 className="mt-3 text-xl font-semibold text-slate-900">
                Manage clients, lessons, packages, and memberships
              </h3>
              <p className="mt-3 text-sm leading-7 text-slate-600">
                Keep client details, scheduling, payment workflows, and recurring programs together in one system.
              </p>
            </section>

            <section className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
              <p className="text-sm font-semibold uppercase tracking-[0.16em] text-sky-700">
                Discovery Experience
              </p>
              <h3 className="mt-3 text-xl font-semibold text-slate-900">
                Help people actually find your studio and events
              </h3>
              <p className="mt-3 text-sm leading-7 text-slate-600">
                Public profiles, searchable events, favorites, and nearby discovery make the front door of your business stronger.
              </p>
            </section>

            <section className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
              <p className="text-sm font-semibold uppercase tracking-[0.16em] text-orange-700">
                Transparent Pricing
              </p>
              <h3 className="mt-3 text-xl font-semibold text-slate-900">
                Clear paths for public, studio, and organizer users
              </h3>
              <p className="mt-3 text-sm leading-7 text-slate-600">
                Public users get a free discovery account. Studios and organizers continue into business pricing built for their use case.
              </p>
            </section>
          </div>
        </section>

        <section className="border-y border-slate-200 bg-white/70">
          <div className="mx-auto max-w-7xl px-6 py-14 lg:px-8">
            <div className="grid gap-6 lg:grid-cols-[1fr_auto] lg:items-center">
              <div>
                <p className="text-sm font-semibold uppercase tracking-[0.16em] text-[var(--brand-accent-dark)]">
                  Get started your way
                </p>
                <h2 className="mt-3 text-3xl font-semibold tracking-tight text-slate-950">
                  One platform, different entry points
                </h2>
                <p className="mt-4 max-w-3xl text-base leading-7 text-slate-600">
                  Dancers can create a free account to save favorites and track event registrations.
                  Studios and organizers can continue into feature and pricing paths built for running the business side of dance.
                </p>
              </div>

              <div className="flex flex-wrap gap-3">
                <Link
                  href="/get-started"
                  className="rounded-xl bg-slate-900 px-5 py-3 text-sm font-medium text-white hover:bg-slate-800"
                >
                  View Paths & Pricing
                </Link>

                <Link
                  href="/login"
                  className="rounded-xl border border-slate-200 bg-white px-5 py-3 text-sm font-medium text-slate-700 hover:bg-slate-50"
                >
                  Log In
                </Link>
              </div>
            </div>
          </div>
        </section>
      </main>

      <PublicSiteFooter />
    </>
  );
}