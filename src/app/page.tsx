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
                    href="/discover/events"
                    className="rounded-xl bg-slate-900 px-5 py-3 text-sm font-medium text-white hover:bg-slate-800"
                  >
                    Explore Events
                  </Link>

                  <Link
                    href="/discover/studios"
                    className="rounded-xl border border-slate-200 bg-white px-5 py-3 text-sm font-medium text-slate-700 hover:bg-slate-50"
                  >
                    Explore Studios
                  </Link>
                </div>

                <p className="mt-4 max-w-2xl text-sm leading-7 text-slate-500">
                  You can explore studios and events without an account. A free
                  discovery account lets you save favorites, track registrations,
                  and keep everything in one place.
                </p>
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

            <div className="mt-14 grid gap-6 lg:grid-cols-3">
              <section className="rounded-[32px] border border-orange-200 bg-white/95 p-6 shadow-sm">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-semibold uppercase tracking-[0.18em] text-[var(--brand-accent-dark)]">
                    Discovery Account
                  </p>
                  <span className="rounded-full bg-orange-50 px-3 py-1 text-xs font-semibold text-orange-700 ring-1 ring-orange-200">
                    Free
                  </span>
                </div>

                <h2 className="mt-4 text-3xl font-semibold tracking-tight text-slate-950">
                  I’m here to explore
                </h2>

                <p className="mt-4 text-base leading-7 text-slate-600">
                  Use DanceFlow as a dancer or member of the public to discover
                  studios and events, save favorites, and keep your registrations
                  organized from one place.
                </p>

                <div className="mt-6 space-y-3">
                  <div className="rounded-2xl bg-orange-50 px-4 py-3 text-sm text-slate-700 ring-1 ring-orange-100">
                    Favorite studios and events
                  </div>
                  <div className="rounded-2xl bg-orange-50 px-4 py-3 text-sm text-slate-700 ring-1 ring-orange-100">
                    Track events you register for
                  </div>
                  <div className="rounded-2xl bg-orange-50 px-4 py-3 text-sm text-slate-700 ring-1 ring-orange-100">
                    Search by city, state, ZIP, or near-me location
                  </div>
                </div>

                <form action="/login" method="get" className="mt-8 space-y-3">
                  <input type="hidden" name="intent" value="public" />

                  <div>
                    <label
                      htmlFor="discovery-email"
                      className="mb-1.5 block text-sm font-medium text-slate-800"
                    >
                      Email
                    </label>
                    <input
                      id="discovery-email"
                      name="email"
                      type="email"
                      required
                      autoComplete="email"
                      placeholder="you@example.com"
                      className="w-full rounded-xl border border-orange-200 px-3 py-3 outline-none focus:border-orange-400"
                    />
                  </div>

                  <button
                    type="submit"
                    className="inline-flex w-full items-center justify-center rounded-xl bg-orange-500 px-5 py-3 text-sm font-medium text-white hover:bg-orange-600"
                  >
                    Email My Sign-In Link
                  </button>
                </form>

                <p className="mt-3 text-xs leading-6 text-slate-500">
                  You can explore without an account. A free discovery account lets
                  you save favorites, track registrations, and return faster with
                  your magic link.
                </p>
              </section>

              <section className="rounded-[32px] border border-violet-200 bg-white/95 p-6 shadow-sm">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-semibold uppercase tracking-[0.18em] text-violet-700">
                    Studio Path
                  </p>
                  <span className="rounded-full bg-violet-50 px-3 py-1 text-xs font-semibold text-violet-700 ring-1 ring-violet-200">
                    Trial Available
                  </span>
                </div>

                <h2 className="mt-4 text-3xl font-semibold tracking-tight text-slate-950">
                  I run a dance studio
                </h2>

                <p className="mt-4 text-base leading-7 text-slate-600">
                  Compare studio tiers, see feature differences clearly, and choose
                  the plan that fits your operations, staff, and growth goals.
                </p>

                <div className="mt-6 space-y-3">
                  <div className="rounded-2xl bg-violet-50 px-4 py-3 text-sm text-slate-700 ring-1 ring-violet-100">
                    CRM, scheduling, packages, memberships, and payments
                  </div>
                  <div className="rounded-2xl bg-violet-50 px-4 py-3 text-sm text-slate-700 ring-1 ring-violet-100">
                    Public studio profile and lead capture
                  </div>
                  <div className="rounded-2xl bg-violet-50 px-4 py-3 text-sm text-slate-700 ring-1 ring-violet-100">
                    Transparent pricing and feature comparison
                  </div>
                </div>

                <Link
                  href="/get-started/studio"
                  className="mt-8 inline-flex w-full items-center justify-center rounded-xl bg-violet-600 px-5 py-3 text-sm font-medium text-white hover:bg-violet-700"
                >
                  View Studio Pricing
                </Link>
              </section>

              <section className="rounded-[32px] border border-sky-200 bg-white/95 p-6 shadow-sm">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-semibold uppercase tracking-[0.18em] text-sky-700">
                    Organizer Path
                  </p>
                  <span className="rounded-full bg-sky-50 px-3 py-1 text-xs font-semibold text-sky-700 ring-1 ring-sky-200">
                    Trial Available
                  </span>
                </div>

                <h2 className="mt-4 text-3xl font-semibold tracking-tight text-slate-950">
                  I organize events
                </h2>

                <p className="mt-4 text-base leading-7 text-slate-600">
                  Continue into organizer pricing for public event publishing,
                  registrations, ticketing, and event visibility tools.
                </p>

                <div className="mt-6 space-y-3">
                  <div className="rounded-2xl bg-sky-50 px-4 py-3 text-sm text-slate-700 ring-1 ring-sky-100">
                    Publish searchable public events
                  </div>
                  <div className="rounded-2xl bg-sky-50 px-4 py-3 text-sm text-slate-700 ring-1 ring-sky-100">
                    Manage registrations and ticket sales
                  </div>
                  <div className="rounded-2xl bg-sky-50 px-4 py-3 text-sm text-slate-700 ring-1 ring-sky-100">
                    Clear pricing before you start
                  </div>
                </div>

                <Link
                  href="/get-started/organizer"
                  className="mt-8 inline-flex w-full items-center justify-center rounded-xl bg-sky-600 px-5 py-3 text-sm font-medium text-white hover:bg-sky-700"
                >
                  View Organizer Pricing
                </Link>
              </section>
            </div>

            <div className="mt-8 rounded-[28px] border border-slate-200 bg-white/90 p-6 shadow-sm">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                <div>
                  <p className="text-sm font-semibold uppercase tracking-[0.16em] text-slate-500">
                    Already have an account?
                  </p>
                  <p className="mt-2 text-base leading-7 text-slate-600">
                    Choose the login that matches your account type. Public
                    accounts use a magic link. Studio and organizer accounts use
                    password login.
                  </p>
                </div>

                <div className="flex flex-wrap gap-3">
                  <Link
                    href="/login"
                    className="rounded-xl border border-orange-200 bg-orange-50 px-4 py-3 text-sm font-medium text-orange-700 hover:bg-orange-100"
                  >
                    Public Log In
                  </Link>

                  <Link
                    href="/login?intent=studio"
                    className="rounded-xl border border-violet-200 bg-violet-50 px-4 py-3 text-sm font-medium text-violet-700 hover:bg-violet-100"
                  >
                    Studio Log In
                  </Link>

                  <Link
                    href="/login?intent=organizer"
                    className="rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm font-medium text-sky-700 hover:bg-sky-100"
                  >
                    Organizer Log In
                  </Link>
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
              Dance studios need more than a simple calendar. Dancers need more
              than a static listing. DanceFlow brings both sides together in a
              way that feels modern, warm, and built for real growth.
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
                Keep client details, lesson scheduling, payments, and recurring
                revenue together in one system designed for studio flow.
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
                Public profiles, favorites, searchable events, and nearby discovery
                make your digital front door stronger.
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
                Organizers can create public-facing events, manage registrations,
                and sell tickets through a cleaner workflow.
              </p>
            </section>
          </div>
        </section>

        <section className="border-y border-slate-200 bg-white/70">
          <div className="mx-auto max-w-7xl px-6 py-14 lg:px-8">
            <div className="grid gap-8 lg:grid-cols-[1fr_auto] lg:items-center">
              <div>
                <p className="text-sm font-semibold uppercase tracking-[0.16em] text-[var(--brand-accent-dark)]">
                  Keep exploring
                </p>
                <h2 className="mt-3 text-3xl font-semibold tracking-tight text-slate-950">
                  Discover studios, discover events, or log back in
                </h2>
                <p className="mt-4 max-w-3xl text-base leading-7 text-slate-600">
                  Browse the public side of DanceFlow or return to your account to
                  manage favorites, registrations, studio operations, or organizer
                  event workflows.
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
                  Public Log In
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