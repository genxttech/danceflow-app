import Image from "next/image";
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
        <section className="relative overflow-hidden border-b border-slate-200/70">
          <div className="absolute inset-x-0 top-0 h-64 bg-[radial-gradient(circle_at_top_left,rgba(251,146,60,0.18),transparent_45%),radial-gradient(circle_at_top_right,rgba(168,85,247,0.16),transparent_42%)]" />

          <div className="relative mx-auto max-w-7xl px-6 py-14 lg:px-8 lg:py-20">
            <div className="grid gap-12 lg:grid-cols-[1.02fr_0.98fr] lg:items-center">
              <div>
                <div className="flex flex-col gap-5 sm:flex-row sm:items-center">
  <div className="flex h-32 w-32 shrink-0 items-center justify-center rounded-[32px] bg-white shadow-sm ring-1 ring-slate-200 sm:h-40 sm:w-40 lg:h-48 lg:w-48">
    <Image
      src="/brand/danceflow-logo.png"
      alt="DanceFlow logo"
      width={180}
      height={180}
      className="h-24 w-24 object-contain sm:h-32 sm:w-32 lg:h-40 lg:w-40"
      priority
    />
  </div>

  <div>
    <p className="text-sm font-semibold uppercase tracking-[0.18em] text-[var(--brand-accent-dark)]">
      DanceFlow
    </p>
    <p className="mt-1 text-sm text-slate-600 sm:text-base">
      Next-generation studio software for ballroom and country
    </p>
  </div>
</div>

                <h1 className="mt-8 text-4xl font-semibold tracking-tight text-slate-950 sm:text-5xl lg:text-6xl">
                  DanceFlow is where studios grow and dancers connect!
                </h1>

                <p className="mt-5 max-w-2xl text-lg leading-8 text-slate-600">
                  Manage your studio, grow your community, and help dancers discover
                  the lessons, events, and experiences they are looking for — all in
                  one platform.
                </p>

                <div className="mt-8 flex flex-wrap gap-3">
                  <Link
                    href="/signup"
                    className="rounded-xl bg-slate-900 px-5 py-3 text-sm font-medium text-white hover:bg-slate-800"
                  >
                    Create Free Account
                  </Link>

                  <Link
                    href="/get-started"
                    className="rounded-xl border border-slate-200 bg-white px-5 py-3 text-sm font-medium text-slate-700 hover:bg-slate-50"
                  >
                    View Paths & Pricing
                  </Link>
                </div>

                <div className="mt-10 grid gap-3 sm:grid-cols-3">
                  <div className="rounded-2xl border border-orange-100 bg-white/90 p-4 shadow-sm backdrop-blur">
                    <p className="text-sm font-medium text-slate-900">For Dancers</p>
                    <p className="mt-1 text-sm text-slate-600">
                      Find studios, save favorites, and keep up with events and registrations.
                    </p>
                  </div>

                  <div className="rounded-2xl border border-violet-100 bg-white/90 p-4 shadow-sm backdrop-blur">
                    <p className="text-sm font-medium text-slate-900">For Studios</p>
                    <p className="mt-1 text-sm text-slate-600">
                      Run CRM, lessons, memberships, packages, and payments in one place.
                    </p>
                  </div>

                  <div className="rounded-2xl border border-sky-100 bg-white/90 p-4 shadow-sm backdrop-blur">
                    <p className="text-sm font-medium text-slate-900">For Organizers</p>
                    <p className="mt-1 text-sm text-slate-600">
                      Publish public events, manage registrations, and sell tickets cleanly.
                    </p>
                  </div>
                </div>
              </div>

              <div className="relative">
                <div className="rounded-[34px] border border-slate-200 bg-white p-4 shadow-sm">
                  <div className="overflow-hidden rounded-[28px] bg-[linear-gradient(135deg,#fff7ed_0%,#fdf2f8_38%,#eef2ff_100%)]">
                    <Image
                      src="/brand/danceflow-home-hero.png"
                      alt="DanceFlow connects studio operations and dancers on the dance floor"
                      width={1400}
                      height={1000}
                      className="h-auto w-full object-cover"
                      priority
                    />
                  </div>
                </div>

                <div className="absolute -bottom-5 left-5 rounded-2xl border border-orange-100 bg-white/95 px-4 py-3 shadow-sm backdrop-blur">
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-orange-700">
                    Studio Growth
                  </p>
                  <p className="mt-1 text-sm text-slate-600">
                    Operations that feel cleaner and easier to run
                  </p>
                </div>

                <div className="absolute -top-5 right-5 rounded-2xl border border-violet-100 bg-white/95 px-4 py-3 shadow-sm backdrop-blur">
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-violet-700">
                    Dancer Connection
                  </p>
                  <p className="mt-1 text-sm text-slate-600">
                    Discovery that helps people actually find you
                  </p>
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
              One platform for the business side of dance and the people searching for it
            </h2>
            <p className="mt-4 text-lg leading-8 text-slate-600">
              Dance studios need more than a simple calendar. Dancers need more than a static listing.
              DanceFlow brings both sides together in a way that feels modern, warm, and built for real growth.
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
                Keep client details, lesson scheduling, payments, and recurring revenue together in one system designed for studio flow.
              </p>
            </section>

            <section className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
              <p className="text-sm font-semibold uppercase tracking-[0.16em] text-sky-700">
                Discovery Experience
              </p>
              <h3 className="mt-3 text-xl font-semibold text-slate-900">
                Help dancers find your studio and events faster
              </h3>
              <p className="mt-3 text-sm leading-7 text-slate-600">
                Public profiles, favorites, searchable events, and nearby discovery make your digital front door stronger.
              </p>
            </section>

            <section className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
              <p className="text-sm font-semibold uppercase tracking-[0.16em] text-orange-700">
                Event Growth
              </p>
              <h3 className="mt-3 text-xl font-semibold text-slate-900">
                Publish, register, and ticket events with clarity
              </h3>
              <p className="mt-3 text-sm leading-7 text-slate-600">
                Organizers can create public-facing events, manage registrations, and sell tickets through a cleaner workflow.
              </p>
            </section>
          </div>
        </section>

        <section className="border-y border-slate-200 bg-white/70">
          <div className="mx-auto max-w-7xl px-6 py-14 lg:px-8">
            <div className="grid gap-8 lg:grid-cols-[1fr_auto] lg:items-center">
              <div>
                <p className="text-sm font-semibold uppercase tracking-[0.16em] text-[var(--brand-accent-dark)]">
                  Get started your way
                </p>
                <h2 className="mt-3 text-3xl font-semibold tracking-tight text-slate-950">
                  Built for public users, studios, and organizers
                </h2>
                <p className="mt-4 max-w-3xl text-base leading-7 text-slate-600">
                  Dancers can create a free account to save favorites and track event registrations.
                  Studios and organizers can continue into feature and pricing paths built for running the business side of dance.
                </p>
              </div>

              <div className="flex flex-wrap gap-3">
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

                <Link
                  href="/login"
                  className="rounded-xl bg-slate-900 px-5 py-3 text-sm font-medium text-white hover:bg-slate-800"
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