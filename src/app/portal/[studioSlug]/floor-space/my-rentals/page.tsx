import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { cancelFloorSpaceRentalAction } from "../actions";

type Params = Promise<{
  studioSlug: string;
}>;

type SearchParams = Promise<{
  success?: string;
  error?: string;
}>;

type RentalRow = {
  id: string;
  title: string | null;
  starts_at: string;
  ends_at: string;
  status: string;
  payment_status: string | null;
  price_amount: number | null;
  rooms:
    | { name: string }
    | { name: string }[]
    | null;
};

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatCurrency(value: number | null) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(Number(value ?? 0));
}

function getRoomName(value: { name: string } | { name: string }[] | null) {
  const room = Array.isArray(value) ? value[0] : value;
  return room?.name ?? "No room selected";
}

function statusBadgeClass(status: string) {
  if (status === "scheduled") return "bg-blue-50 text-blue-700 ring-1 ring-blue-100";
  if (status === "cancelled") return "bg-red-50 text-red-700 ring-1 ring-red-100";
  if (status === "attended") return "bg-green-50 text-green-700 ring-1 ring-green-100";
  if (status === "no_show") return "bg-amber-50 text-amber-700 ring-1 ring-amber-100";
  return "bg-slate-100 text-slate-700 ring-1 ring-slate-200";
}

function paymentBadgeClass(status: string | null) {
  if (status === "paid") return "bg-green-50 text-green-700 ring-1 ring-green-100";
  if (status === "partial") return "bg-amber-50 text-amber-700 ring-1 ring-amber-100";
  if (status === "waived") return "bg-violet-50 text-violet-700 ring-1 ring-violet-100";
  return "bg-slate-100 text-slate-700 ring-1 ring-slate-200";
}

function paymentLabel(status: string | null) {
  if (!status) return "Unpaid";
  return status.replaceAll("_", " ");
}

function getBanner(search: { success?: string; error?: string }) {
  if (search.success === "cancelled") {
    return { kind: "success" as const, message: "Floor rental cancelled." };
  }

  if (search.success === "already_cancelled") {
    return { kind: "success" as const, message: "That floor rental was already cancelled." };
  }

  if (search.success === "balance_payment_submitted") {
    return {
      kind: "success" as const,
      message: "Balance payment submitted. Stripe will return you here after checkout.",
    };
  }

  if (search.success === "no_balance_due") {
    return {
      kind: "success" as const,
      message: "There is no unpaid rental balance right now.",
    };
  }

  if (search.error === "checkout_cancelled") {
    return { kind: "error" as const, message: "Payment checkout was cancelled." };
  }

  if (search.error === "checkout_failed") {
    return { kind: "error" as const, message: "Could not start rental balance checkout." };
  }

  if (search.error === "missing_rental_amount") {
    return { kind: "error" as const, message: "One or more rentals is missing a fee amount." };
  }

  if (search.error === "missing_appointment") {
    return { kind: "error" as const, message: "Missing floor rental selection." };
  }

  if (search.error === "not_found") {
    return { kind: "error" as const, message: "Floor rental not found." };
  }

  if (search.error === "unauthorized") {
    return { kind: "error" as const, message: "You are not allowed to manage that floor rental." };
  }

  if (search.error === "invalid_type") {
    return { kind: "error" as const, message: "That booking is not a floor rental." };
  }

  if (search.error === "past_rental") {
    return { kind: "error" as const, message: "Past floor rentals cannot be cancelled here." };
  }

  if (search.error === "cancel_failed") {
    return { kind: "error" as const, message: "Could not cancel the floor rental." };
  }

  return null;
}

export default async function MyFloorRentalsPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SearchParams;
}) {
  const { studioSlug } = await params;
  const query = await searchParams;
  const banner = getBanner(query);

  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect(`/login?studio=${encodeURIComponent(studioSlug)}`);
  }

  const { data: studio, error: studioError } = await supabase
    .from("studios")
    .select("id, name, slug, public_name")
    .eq("slug", studioSlug)
    .single();

  if (studioError || !studio) {
    redirect("/login");
  }

  const { data: client, error: clientError } = await supabase
    .from("clients")
    .select("id, first_name, last_name, is_independent_instructor")
    .eq("studio_id", studio.id)
    .eq("portal_user_id", user.id)
    .single();

  if (clientError || !client || !client.is_independent_instructor) {
    redirect(`/portal/${encodeURIComponent(studioSlug)}`);
  }

  const nowIso = new Date().toISOString();

  const [{ data: upcomingRentals, error: upcomingError }, { data: recentRentals, error: recentError }] =
    await Promise.all([
      supabase
        .from("appointments")
        .select(`
          id,
          title,
          starts_at,
          ends_at,
          status,
          payment_status,
          price_amount,
          rooms ( name )
        `)
        .eq("studio_id", studio.id)
        .eq("client_id", client.id)
        .eq("appointment_type", "floor_space_rental")
        .gte("starts_at", nowIso)
        .order("starts_at", { ascending: true }),

      supabase
        .from("appointments")
        .select(`
          id,
          title,
          starts_at,
          ends_at,
          status,
          payment_status,
          price_amount,
          rooms ( name )
        `)
        .eq("studio_id", studio.id)
        .eq("client_id", client.id)
        .eq("appointment_type", "floor_space_rental")
        .lt("starts_at", nowIso)
        .order("starts_at", { ascending: false })
        .limit(20),
    ]);

  if (upcomingError) {
    throw new Error(`Failed to load upcoming rentals: ${upcomingError.message}`);
  }

  if (recentError) {
    throw new Error(`Failed to load rental history: ${recentError.message}`);
  }

  const upcoming = (upcomingRentals ?? []) as RentalRow[];
  const recent = (recentRentals ?? []) as RentalRow[];
  const studioLabel = studio.public_name?.trim() || studio.name;
  const fullName =
    `${client.first_name ?? ""} ${client.last_name ?? ""}`.trim() || "Portal Member";

  const nextRental = upcoming[0] ?? null;
  const unpaidRentals = upcoming.filter(
    (rental) =>
      rental.status !== "cancelled" &&
      (rental.payment_status === "unpaid" ||
        rental.payment_status === "partial" ||
        rental.payment_status == null) &&
      Number(rental.price_amount ?? 0) > 0
  );

  const balanceDue = unpaidRentals.reduce(
    (sum, rental) => sum + Number(rental.price_amount ?? 0),
    0
  );

  return (
    <div className="space-y-8">
      {banner ? (
        <div
          className={`rounded-2xl border px-4 py-3 text-sm ${
            banner.kind === "success"
              ? "border-green-200 bg-green-50 text-green-700"
              : "border-red-200 bg-red-50 text-red-700"
          }`}
        >
          {banner.message}
        </div>
      ) : null}

      <section className="overflow-hidden rounded-[36px] border border-slate-200 bg-[linear-gradient(135deg,#ecfdf5_0%,#ffffff_45%,#f8fafc_100%)] p-8 shadow-sm sm:p-10">
        <div className="grid gap-8 xl:grid-cols-[1.2fr_0.8fr]">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-emerald-700">
              {studioLabel}
            </p>
            <h1 className="mt-3 text-4xl font-semibold tracking-tight text-slate-950 sm:text-5xl">
              My Rentals
            </h1>
            <p className="mt-4 max-w-3xl text-sm leading-7 text-slate-600 sm:text-base">
              Review upcoming and recent floor rentals, keep track of your running rental balance, and pay unpaid rentals in one checkout.
            </p>
            <p className="mt-3 text-sm text-slate-500">Signed in as {fullName}</p>

            <div className="mt-8 grid gap-4 sm:grid-cols-3">
              <div className="rounded-2xl border border-emerald-100 bg-white p-5 shadow-sm">
                <p className="text-sm text-slate-500">Upcoming Rentals</p>
                <p className="mt-2 text-3xl font-semibold text-slate-950">{upcoming.length}</p>
              </div>

              <div className="rounded-2xl border border-amber-100 bg-white p-5 shadow-sm">
                <p className="text-sm text-slate-500">Balance Due</p>
                <p className="mt-2 text-3xl font-semibold text-slate-950">
                  {formatCurrency(balanceDue)}
                </p>
              </div>

              <div className="rounded-2xl border border-violet-100 bg-white p-5 shadow-sm">
                <p className="text-sm text-slate-500">Unpaid Rentals</p>
                <p className="mt-2 text-3xl font-semibold text-slate-950">
                  {unpaidRentals.length}
                </p>
              </div>
            </div>
          </div>

          <div className="rounded-[28px] border border-slate-200 bg-white/90 p-6 shadow-sm">
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-slate-500">
              Balance Actions
            </p>

            <div className="mt-5 space-y-4">
              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-5">
                <p className="text-sm text-slate-500">Current Rental Balance</p>
                <p className="mt-2 text-3xl font-semibold text-slate-950">
                  {formatCurrency(balanceDue)}
                </p>
                <p className="mt-2 text-sm text-slate-600">
                  {unpaidRentals.length} unpaid rental{unpaidRentals.length === 1 ? "" : "s"}
                </p>
              </div>

              <form action="/api/payments/portal-floor-rental-checkout" method="post">
                <input type="hidden" name="studioSlug" value={studio.slug} />
                <button
                  type="submit"
                  disabled={balanceDue <= 0}
                  className="w-full rounded-2xl bg-slate-900 px-4 py-3 text-sm font-medium text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Pay Balance
                </button>
              </form>

              <div className="grid gap-3">
                <Link
                  href={`/portal/${encodeURIComponent(studio.slug)}/floor-space`}
                  className="rounded-2xl border border-slate-200 bg-slate-50 p-4 hover:bg-slate-100"
                >
                  <p className="font-medium text-slate-900">Book Floor Space</p>
                  <p className="mt-1 text-sm text-slate-600">
                    Reserve additional studio time.
                  </p>
                </Link>

                <Link
                  href={`/portal/${encodeURIComponent(studio.slug)}`}
                  className="rounded-2xl border border-slate-200 bg-slate-50 p-4 hover:bg-slate-100"
                >
                  <p className="font-medium text-slate-900">Portal Home</p>
                  <p className="mt-1 text-sm text-slate-600">
                    Return to your instructor dashboard.
                  </p>
                </Link>
              </div>
            </div>
          </div>
        </div>
      </section>

      <div className="grid gap-8 xl:grid-cols-[1.1fr_0.9fr]">
        <div className="space-y-8">
          <section className="rounded-[32px] border border-slate-200 bg-white p-7 shadow-sm">
            <div className="max-w-2xl">
              <p className="text-sm font-semibold uppercase tracking-[0.16em] text-sky-700">
                Upcoming Rentals
              </p>
              <h2 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">
                Scheduled studio time
              </h2>
              <p className="mt-3 text-sm leading-7 text-slate-600">
                Upcoming rentals stay visible individually, but unpaid ones roll into one running balance.
              </p>
            </div>

            {upcoming.length === 0 ? (
              <div className="mt-6 rounded-3xl border border-dashed border-slate-300 bg-slate-50 p-10 text-center">
                <p className="text-lg font-medium text-slate-900">No upcoming floor rentals</p>
                <p className="mt-2 text-sm leading-7 text-slate-600">
                  New rentals will appear here after booking.
                </p>
              </div>
            ) : (
              <div className="mt-6 space-y-4">
                {upcoming.map((rental) => (
                  <div
                    key={rental.id}
                    className="rounded-3xl border border-slate-200 bg-slate-50 p-5 shadow-sm"
                  >
                    <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                      <div>
                        <div className="flex flex-wrap items-center gap-3">
                          <p className="font-semibold text-slate-900">
                            {rental.title || "Floor Space Rental"}
                          </p>
                          <span
                            className={`rounded-full px-3 py-1 text-xs font-medium uppercase tracking-wide ${statusBadgeClass(
                              rental.status
                            )}`}
                          >
                            {rental.status.replaceAll("_", " ")}
                          </span>
                          <span
                            className={`rounded-full px-3 py-1 text-xs font-medium uppercase tracking-wide ${paymentBadgeClass(
                              rental.payment_status
                            )}`}
                          >
                            {paymentLabel(rental.payment_status)}
                          </span>
                        </div>

                        <p className="mt-3 text-sm text-slate-700">
                          {formatDate(rental.starts_at)}
                        </p>
                        <p className="mt-1 text-sm text-slate-600">
                          {formatTime(rental.starts_at)} – {formatTime(rental.ends_at)}
                        </p>
                        <p className="mt-1 text-sm text-slate-500">
                          {getRoomName(rental.rooms)}
                        </p>
                        <p className="mt-3 text-sm font-medium text-slate-800">
                          Rental Fee: {formatCurrency(rental.price_amount)}
                        </p>
                      </div>

                      {rental.status !== "cancelled" ? (
                        <form action={cancelFloorSpaceRentalAction}>
                          <input type="hidden" name="studioSlug" value={studio.slug} />
                          <input type="hidden" name="appointmentId" value={rental.id} />
                          <input
                            type="hidden"
                            name="returnTo"
                            value={`/portal/${encodeURIComponent(
                              studio.slug
                            )}/floor-space/my-rentals`}
                          />
                          <button
                            type="submit"
                            className="rounded-2xl border border-red-200 px-4 py-3 text-sm font-medium text-red-700 hover:bg-red-50"
                          >
                            Cancel Rental
                          </button>
                        </form>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="rounded-[32px] border border-slate-200 bg-white p-7 shadow-sm">
            <div className="max-w-2xl">
              <p className="text-sm font-semibold uppercase tracking-[0.16em] text-violet-700">
                Recent Rentals
              </p>
              <h2 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">
                Rental history
              </h2>
              <p className="mt-3 text-sm leading-7 text-slate-600">
                Your latest completed, cancelled, or past rental activity.
              </p>
            </div>

            {recent.length === 0 ? (
              <div className="mt-6 rounded-3xl border border-dashed border-slate-300 bg-slate-50 p-10 text-center">
                <p className="text-lg font-medium text-slate-900">No recent rental history</p>
                <p className="mt-2 text-sm leading-7 text-slate-600">
                  Past rentals will appear here after you have completed bookings.
                </p>
              </div>
            ) : (
              <div className="mt-6 space-y-3">
                {recent.map((rental) => (
                  <div
                    key={rental.id}
                    className="rounded-2xl border border-slate-200 bg-slate-50 p-4 shadow-sm"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <p className="font-medium text-slate-900">
                          {rental.title || "Floor Space Rental"}
                        </p>
                        <p className="mt-1 text-sm text-slate-600">
                          {formatDateTime(rental.starts_at)}
                        </p>
                        <p className="mt-1 text-sm text-slate-500">
                          {getRoomName(rental.rooms)}
                        </p>
                        <p className="mt-2 text-sm text-slate-700">
                          Rental Fee: {formatCurrency(rental.price_amount)}
                        </p>
                      </div>

                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          className={`rounded-full px-3 py-1 text-xs font-medium uppercase tracking-wide ${statusBadgeClass(
                            rental.status
                          )}`}
                        >
                          {rental.status.replaceAll("_", " ")}
                        </span>
                        <span
                          className={`rounded-full px-3 py-1 text-xs font-medium uppercase tracking-wide ${paymentBadgeClass(
                            rental.payment_status
                          )}`}
                        >
                          {paymentLabel(rental.payment_status)}
                        </span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>

        <div className="space-y-8">
          <section className="rounded-[32px] border border-slate-200 bg-white p-7 shadow-sm">
            <p className="text-sm font-semibold uppercase tracking-[0.16em] text-orange-600">
              Payment Notes
            </p>
            <ul className="mt-5 space-y-3 text-sm leading-7 text-slate-700">
              <li>Unpaid rentals are grouped into one running balance.</li>
              <li>Paying the balance clears all currently included unpaid rentals at once.</li>
              <li>Waived rentals do not increase the balance.</li>
              <li>Cancelled rentals are excluded from payment.</li>
            </ul>
          </section>

          <section className="rounded-[32px] border border-slate-200 bg-white p-7 shadow-sm">
            <p className="text-sm font-semibold uppercase tracking-[0.16em] text-emerald-700">
              Quick Snapshot
            </p>

            <div className="mt-5 space-y-3 text-sm text-slate-700">
              <div className="flex items-center justify-between rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
                <span>Next Rental</span>
                <span className="font-medium text-slate-900">
                  {nextRental ? formatDateTime(nextRental.starts_at) : "None scheduled"}
                </span>
              </div>

              <div className="flex items-center justify-between rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
                <span>Balance Due</span>
                <span className="font-medium text-slate-900">
                  {formatCurrency(balanceDue)}
                </span>
              </div>

              <div className="flex items-center justify-between rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
                <span>Unpaid Rentals</span>
                <span className="font-medium text-slate-900">
                  {unpaidRentals.length}
                </span>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}