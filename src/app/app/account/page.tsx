import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

type FavoriteCountRow = {
  target_type: "studio" | "event";
};

type RegistrationRow = {
  id: string;
};

export default async function AccountHomePage() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login?next=/account");
  }

  const [
    { data: favorites, error: favoritesError },
    { data: registrations, error: registrationsError },
  ] = await Promise.all([
    supabase
      .from("user_favorites")
      .select("target_type")
      .eq("user_id", user.id),

    supabase
      .from("event_registrations")
      .select("id")
      .eq("attendee_email", user.email ?? "__no_email__")
      .not("status", "eq", "cancelled"),
  ]);

  if (favoritesError) {
    throw new Error(`Failed to load favorites summary: ${favoritesError.message}`);
  }

  if (registrationsError) {
    throw new Error(`Failed to load registrations summary: ${registrationsError.message}`);
  }

  const typedFavorites = (favorites ?? []) as FavoriteCountRow[];
  const typedRegistrations = (registrations ?? []) as RegistrationRow[];

  const studioFavorites = typedFavorites.filter((row) => row.target_type === "studio").length;
  const eventFavorites = typedFavorites.filter((row) => row.target_type === "event").length;
  const registrationCount = typedRegistrations.length;

  return (
    <main className="min-h-screen bg-slate-50">
      <section className="border-b bg-white">
        <div className="mx-auto max-w-7xl px-6 py-14">
          <p className="text-sm font-semibold uppercase tracking-[0.18em] text-[var(--brand-accent-dark)]">
            Free Discovery Account
          </p>

          <h1 className="mt-3 text-4xl font-semibold tracking-tight text-slate-900 sm:text-5xl">
            Your DanceFlow Account
          </h1>

          <p className="mt-4 max-w-3xl text-lg text-slate-600">
            Keep track of studios and events you care about, then jump back into discovery whenever you want.
          </p>
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-6 py-8">
        <div className="grid gap-6 md:grid-cols-3">
          <div className="rounded-3xl border bg-white p-6 shadow-sm">
            <p className="text-sm font-medium text-slate-500">Favorite Studios</p>
            <p className="mt-3 text-4xl font-semibold text-slate-900">{studioFavorites}</p>
            <p className="mt-2 text-sm text-slate-600">
              Studios you saved with the heart button.
            </p>
            <div className="mt-5">
              <Link
                href="/favorites"
                className="rounded-xl bg-slate-900 px-4 py-2 text-sm text-white hover:bg-slate-800"
              >
                View Favorites
              </Link>
            </div>
          </div>

          <div className="rounded-3xl border bg-white p-6 shadow-sm">
            <p className="text-sm font-medium text-slate-500">Favorite Events</p>
            <p className="mt-3 text-4xl font-semibold text-slate-900">{eventFavorites}</p>
            <p className="mt-2 text-sm text-slate-600">
              Events you saved to revisit later.
            </p>
            <div className="mt-5">
              <Link
                href="/favorites"
                className="rounded-xl bg-slate-900 px-4 py-2 text-sm text-white hover:bg-slate-800"
              >
                View Favorites
              </Link>
            </div>
          </div>

          <div className="rounded-3xl border bg-white p-6 shadow-sm">
            <p className="text-sm font-medium text-slate-500">Event Activity</p>
            <p className="mt-3 text-4xl font-semibold text-slate-900">{registrationCount}</p>
            <p className="mt-2 text-sm text-slate-600">
              Registrations tied to your account email.
            </p>
            <div className="mt-5">
              <Link
                href="/discover/events"
                className="rounded-xl bg-slate-900 px-4 py-2 text-sm text-white hover:bg-slate-800"
              >
                Browse Events
              </Link>
            </div>
          </div>
        </div>

        <div className="mt-8 grid gap-6 lg:grid-cols-2">
          <section className="rounded-3xl border bg-white p-6 shadow-sm">
            <h2 className="text-2xl font-semibold text-slate-900">Quick Actions</h2>

            <div className="mt-5 grid gap-3 sm:grid-cols-2">
              <Link
                href="/discover/studios"
                className="rounded-2xl border bg-slate-50 p-5 hover:bg-slate-100"
              >
                <p className="font-medium text-slate-900">Browse Studios</p>
                <p className="mt-1 text-sm text-slate-600">
                  Search public studio pages.
                </p>
              </Link>

              <Link
                href="/discover/events"
                className="rounded-2xl border bg-slate-50 p-5 hover:bg-slate-100"
              >
                <p className="font-medium text-slate-900">Browse Events</p>
                <p className="mt-1 text-sm text-slate-600">
                  Search workshops, classes, and socials.
                </p>
              </Link>

              <Link
                href="/favorites"
                className="rounded-2xl border bg-slate-50 p-5 hover:bg-slate-100"
              >
                <p className="font-medium text-slate-900">Favorites</p>
                <p className="mt-1 text-sm text-slate-600">
                  Revisit studios and events you saved.
                </p>
              </Link>

              <Link
                href="/get-started"
                className="rounded-2xl border bg-slate-50 p-5 hover:bg-slate-100"
              >
                <p className="font-medium text-slate-900">Explore Other Paths</p>
                <p className="mt-1 text-sm text-slate-600">
                  View studio or organizer options.
                </p>
              </Link>
            </div>
          </section>

          <section className="rounded-3xl border bg-white p-6 shadow-sm">
            <h2 className="text-2xl font-semibold text-slate-900">About This Account</h2>

            <div className="mt-5 space-y-4 text-sm leading-7 text-slate-600">
              <p>
                Your free account is designed for discovery. Use it to search studios,
                browse events, save favorites, and keep your dance activity easier to manage.
              </p>

              <p>
                As the member side grows, this account can also become the place where you
                track registrations, saved studios, and saved events in one spot.
              </p>
            </div>
          </section>
        </div>
      </section>
    </main>
  );
}