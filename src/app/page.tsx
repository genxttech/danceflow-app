import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentUserPlatformRole } from "@/lib/auth/platform";

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

    redirect("/app");
  }

  return (
    <main className="min-h-screen bg-slate-50">
      <section className="mx-auto flex min-h-screen max-w-6xl items-center px-6 py-16">
        <div className="grid w-full gap-10 lg:grid-cols-[1.1fr_0.9fr] lg:items-center">
          <div>
            <div className="inline-flex rounded-full border border-slate-200 bg-white px-3 py-1 text-sm font-medium text-slate-600">
              StudioFlow
            </div>

            <h1 className="mt-6 text-4xl font-semibold tracking-tight text-slate-900 sm:text-5xl">
              Studio software that works harder for your dance studio.
            </h1>

            <p className="mt-5 max-w-2xl text-lg text-slate-600">
              Manage clients, packages, scheduling, leads, payments, and studio
              operations in one place.
            </p>

            <div className="mt-8 flex flex-wrap gap-3">
              <Link
                href="/login"
                className="rounded-xl bg-slate-900 px-5 py-3 text-sm font-medium text-white hover:bg-slate-800"
              >
                Sign In
              </Link>

              <Link
                href="/app"
                className="rounded-xl border border-slate-300 bg-white px-5 py-3 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                Open App
              </Link>
            </div>

            <div className="mt-10 grid gap-4 sm:grid-cols-3">
              <div className="rounded-2xl border bg-white p-4 shadow-sm">
                <p className="text-sm font-medium text-slate-900">Client CRM</p>
                <p className="mt-2 text-sm text-slate-600">
                  Track leads, active students, notes, and follow-ups.
                </p>
              </div>

              <div className="rounded-2xl border bg-white p-4 shadow-sm">
                <p className="text-sm font-medium text-slate-900">Scheduling</p>
                <p className="mt-2 text-sm text-slate-600">
                  Book appointments, recurring lessons, and studio time.
                </p>
              </div>

              <div className="rounded-2xl border bg-white p-4 shadow-sm">
                <p className="text-sm font-medium text-slate-900">Packages & Payments</p>
                <p className="mt-2 text-sm text-slate-600">
                  Manage balances, payments, and package health.
                </p>
              </div>
            </div>
          </div>

          <div className="rounded-3xl border bg-white p-6 shadow-sm">
            <div className="grid gap-4">
              <div className="rounded-2xl bg-slate-50 p-5">
                <p className="text-sm text-slate-500">Today</p>
                <p className="mt-2 text-2xl font-semibold text-slate-900">
                  Studio Command Center
                </p>
                <p className="mt-2 text-sm text-slate-600">
                  View bookings, leads, packages, notifications, and studio activity from one dashboard.
                </p>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="rounded-2xl border bg-white p-4">
                  <p className="text-sm text-slate-500">Scheduling</p>
                  <p className="mt-2 font-medium text-slate-900">
                    Private lessons, intros, recurring series
                  </p>
                </div>

                <div className="rounded-2xl border bg-white p-4">
                  <p className="text-sm text-slate-500">Notifications</p>
                  <p className="mt-2 font-medium text-slate-900">
                    Follow-ups, package alerts, bookings
                  </p>
                </div>

                <div className="rounded-2xl border bg-white p-4">
                  <p className="text-sm text-slate-500">Public Booking</p>
                  <p className="mt-2 font-medium text-slate-900">
                    Intro lesson and lead capture workflows
                  </p>
                </div>

                <div className="rounded-2xl border bg-white p-4">
                  <p className="text-sm text-slate-500">Operations</p>
                  <p className="mt-2 font-medium text-slate-900">
                    Packages, balances, and payment tracking
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}