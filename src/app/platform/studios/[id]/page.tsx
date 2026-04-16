import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requirePlatformAdmin } from "@/lib/auth/platform";
import { enterStudioContextAction } from "@/app/platform/actions";

type Params = Promise<{
  id: string;
}>;

type StudioRow = {
  id: string;
  name: string;
  created_at: string;
};

type SubscriptionRow = {
  id: string;
  studio_id: string;
  status: string;
  billing_interval: string;
  current_period_start: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  trial_ends_at: string | null;
  subscription_plans:
    | {
        code: string;
        name: string;
      }
    | {
        code: string;
        name: string;
      }[]
    | null;
};

type OrganizerRow = {
  id: string;
  studio_id: string;
  name: string;
  slug: string;
  active: boolean;
  created_at: string;
};

type EventRow = {
  id: string;
  studio_id: string;
  organizer_id: string | null;
  name: string;
  slug: string;
  status: string;
  visibility: string;
  event_type: string;
  start_date: string;
  created_at: string;
};

type RegistrationRow = {
  id: string;
  event_id: string;
  payment_status: string | null;
  total_amount: number | null;
  created_at: string;
};

function getPlan(
  value:
    | { code: string; name: string }
    | { code: string; name: string }[]
    | null
) {
  return Array.isArray(value) ? value[0] : value;
}

function formatDate(value: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

function formatMoney(value: number, currency = "USD") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(value);
}

function statusBadgeClass(status: string) {
  if (status === "active") return "bg-green-50 text-green-700";
  if (status === "trialing") return "bg-blue-50 text-blue-700";
  if (status === "past_due") return "bg-amber-50 text-amber-700";
  if (status === "cancelled") return "bg-red-50 text-red-700";
  return "bg-slate-100 text-slate-700";
}

function statusLabel(status: string) {
  if (status === "trialing") return "Trialing";
  if (status === "active") return "Active";
  if (status === "past_due") return "Past Due";
  if (status === "cancelled") return "Cancelled";
  if (status === "inactive") return "Inactive";
  return status;
}

function eventTypeLabel(value: string) {
  if (value === "group_class") return "Group Class";
  if (value === "practice_party") return "Practice Party";
  if (value === "workshop") return "Workshop";
  if (value === "social_dance") return "Social Dance";
  if (value === "competition") return "Competition";
  if (value === "showcase") return "Showcase";
  if (value === "festival") return "Festival";
  if (value === "special_event") return "Special Event";
  return value.replaceAll("_", " ");
}

export default async function PlatformStudioDetailPage({
  params,
}: {
  params: Params;
}) {
  await requirePlatformAdmin();

  const { id } = await params;
  const supabase = await createClient();

  const [
    { data: studio, error: studioError },
    { data: subscription, error: subscriptionError },
    { data: organizers, error: organizersError },
    { data: events, error: eventsError },
    { data: registrations, error: registrationsError },
  ] = await Promise.all([
    supabase.from("studios").select("id, name, created_at").eq("id", id).maybeSingle(),

    supabase
      .from("studio_subscriptions")
      .select(`
        id,
        studio_id,
        status,
        billing_interval,
        current_period_start,
        current_period_end,
        cancel_at_period_end,
        trial_ends_at,
        subscription_plans (
          code,
          name
        )
      `)
      .eq("studio_id", id)
      .maybeSingle(),

    supabase
      .from("organizers")
      .select("id, studio_id, name, slug, active, created_at")
      .eq("studio_id", id)
      .order("created_at", { ascending: false }),

    supabase
      .from("events")
      .select(
        "id, studio_id, organizer_id, name, slug, status, visibility, event_type, start_date, created_at"
      )
      .eq("studio_id", id)
      .order("created_at", { ascending: false }),

    supabase
      .from("event_registrations")
      .select("id, event_id, payment_status, total_amount, created_at"),
  ]);

  if (studioError) throw new Error(`Failed to load studio: ${studioError.message}`);
  if (!studio) notFound();
  if (subscriptionError) throw new Error(`Failed to load subscription: ${subscriptionError.message}`);
  if (organizersError) throw new Error(`Failed to load organizers: ${organizersError.message}`);
  if (eventsError) throw new Error(`Failed to load events: ${eventsError.message}`);
  if (registrationsError) throw new Error(`Failed to load registrations: ${registrationsError.message}`);

  const typedStudio = studio as StudioRow;
  const typedSubscription = (subscription ?? null) as SubscriptionRow | null;
  const typedOrganizers = (organizers ?? []) as OrganizerRow[];
  const typedEvents = (events ?? []) as EventRow[];
  const typedRegistrations = (registrations ?? []) as RegistrationRow[];

  const plan = typedSubscription ? getPlan(typedSubscription.subscription_plans) : null;
  const organizerById = new Map(typedOrganizers.map((organizer) => [organizer.id, organizer]));
  const studioEventIds = new Set(typedEvents.map((event) => event.id));
  const studioRegistrations = typedRegistrations.filter((registration) =>
    studioEventIds.has(registration.event_id)
  );

  const activeOrganizers = typedOrganizers.filter((organizer) => organizer.active).length;
  const publicEvents = typedEvents.filter(
    (event) => event.status === "published" && event.visibility === "public"
  ).length;
  const paidRegistrations = studioRegistrations.filter(
    (registration) => registration.payment_status === "paid"
  ).length;

  const grossRevenue = studioRegistrations.reduce((sum, registration) => {
    if (
      registration.payment_status !== "paid" &&
      registration.payment_status !== "partial"
    ) {
      return sum;
    }
    return sum + Number(registration.total_amount ?? 0);
  }, 0);

  const recentEvents = typedEvents.slice(0, 8);
  const recentOrganizers = typedOrganizers.slice(0, 8);

  return (
    <div className="space-y-8">
      <div className="rounded-3xl border bg-white p-6 shadow-sm">
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight text-slate-900">
              {typedStudio.name}
            </h1>
            <p className="mt-2 text-slate-600">
              Studio detail, billing health, organizer usage, and event activity.
            </p>
            <p className="mt-2 text-xs text-slate-500">{typedStudio.id}</p>
          </div>

          <form action={enterStudioContextAction}>
            <input type="hidden" name="studioId" value={typedStudio.id} />
            <button
              type="submit"
              className="rounded-xl bg-slate-900 px-4 py-2 text-sm text-white hover:bg-slate-800"
            >
              Open Studio App
            </button>
          </form>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-3 xl:grid-cols-6">
        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Plan</p>
          <p className="mt-2 text-2xl font-semibold text-slate-900">
            {plan?.name ?? "No plan"}
          </p>
        </div>

        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Subscription</p>
          <p className="mt-2">
            <span
              className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${statusBadgeClass(
                typedSubscription?.status ?? "inactive"
              )}`}
            >
              {statusLabel(typedSubscription?.status ?? "inactive")}
            </span>
          </p>
        </div>

        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Billing Interval</p>
          <p className="mt-2 text-2xl font-semibold text-slate-900">
            {typedSubscription?.billing_interval === "year" ? "Yearly" : "Monthly"}
          </p>
        </div>

        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Organizers</p>
          <p className="mt-2 text-3xl font-semibold">{typedOrganizers.length}</p>
          <p className="mt-1 text-sm text-slate-500">{activeOrganizers} active</p>
        </div>

        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Events</p>
          <p className="mt-2 text-3xl font-semibold">{typedEvents.length}</p>
          <p className="mt-1 text-sm text-slate-500">{publicEvents} public</p>
        </div>

        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Registrations</p>
          <p className="mt-2 text-3xl font-semibold">{studioRegistrations.length}</p>
          <p className="mt-1 text-sm text-slate-500">{paidRegistrations} paid</p>
        </div>
      </div>

      <div className="grid gap-6 xl:grid-cols-[1.05fr_0.95fr]">
        <div className="rounded-2xl border bg-white p-6 shadow-sm">
          <h2 className="text-xl font-semibold text-slate-900">Billing Overview</h2>

          <div className="mt-5 grid gap-4 md:grid-cols-2">
            <div className="rounded-xl border bg-slate-50 p-4">
              <p className="text-sm text-slate-500">Current Period Start</p>
              <p className="mt-1 font-medium text-slate-900">
                {formatDate(typedSubscription?.current_period_start ?? null)}
              </p>
            </div>

            <div className="rounded-xl border bg-slate-50 p-4">
              <p className="text-sm text-slate-500">Current Period End</p>
              <p className="mt-1 font-medium text-slate-900">
                {formatDate(typedSubscription?.current_period_end ?? null)}
              </p>
            </div>

            <div className="rounded-xl border bg-slate-50 p-4">
              <p className="text-sm text-slate-500">Trial Ends</p>
              <p className="mt-1 font-medium text-slate-900">
                {formatDate(typedSubscription?.trial_ends_at ?? null)}
              </p>
            </div>

            <div className="rounded-xl border bg-slate-50 p-4">
              <p className="text-sm text-slate-500">Cancel at Period End</p>
              <p className="mt-1 font-medium text-slate-900">
                {typedSubscription?.cancel_at_period_end ? "Yes" : "No"}
              </p>
            </div>
          </div>

          <div className="mt-5 rounded-xl border bg-slate-50 p-4">
            <p className="text-sm text-slate-500">Gross Registration Revenue</p>
            <p className="mt-1 text-2xl font-semibold text-slate-900">
              {formatMoney(grossRevenue, "USD")}
            </p>
          </div>
        </div>

        <div className="rounded-2xl border bg-white p-6 shadow-sm">
          <h2 className="text-xl font-semibold text-slate-900">Studio Overview</h2>

          <div className="mt-5 space-y-4">
            <div className="rounded-xl border bg-slate-50 p-4">
              <p className="text-sm text-slate-500">Studio Created</p>
              <p className="mt-1 font-medium text-slate-900">
                {formatDate(typedStudio.created_at)}
              </p>
            </div>

            <div className="rounded-xl border bg-slate-50 p-4">
              <p className="text-sm text-slate-500">Public Event Adoption</p>
              <p className="mt-1 font-medium text-slate-900">
                {publicEvents} published public events
              </p>
            </div>

            <div className="rounded-xl border bg-slate-50 p-4">
              <p className="text-sm text-slate-500">Organizer Adoption</p>
              <p className="mt-1 font-medium text-slate-900">
                {activeOrganizers} active of {typedOrganizers.length}
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        <div className="rounded-2xl border bg-white p-6 shadow-sm">
          <h2 className="text-xl font-semibold text-slate-900">Recent Events</h2>

          {recentEvents.length === 0 ? (
            <div className="mt-5 rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-10 text-sm text-slate-500">
              No events yet.
            </div>
          ) : (
            <div className="mt-5 space-y-3">
              {recentEvents.map((event) => {
                const organizer = event.organizer_id
                  ? organizerById.get(event.organizer_id)
                  : null;

                return (
                  <div key={event.id} className="rounded-xl border bg-slate-50 p-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <p className="font-medium text-slate-900">{event.name}</p>
                        <p className="mt-1 text-sm text-slate-500">
                          {eventTypeLabel(event.event_type)} • {event.visibility} • {event.status}
                        </p>
                      </div>

                      <div className="text-right text-sm text-slate-500">
                        <p>{formatDate(event.start_date)}</p>
                        <p>{organizer?.name ?? "No organizer"}</p>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="rounded-2xl border bg-white p-6 shadow-sm">
          <h2 className="text-xl font-semibold text-slate-900">Recent Organizers</h2>

          {recentOrganizers.length === 0 ? (
            <div className="mt-5 rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-10 text-sm text-slate-500">
              No organizers yet.
            </div>
          ) : (
            <div className="mt-5 space-y-3">
              {recentOrganizers.map((organizer) => (
                <div key={organizer.id} className="rounded-xl border bg-slate-50 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="font-medium text-slate-900">{organizer.name}</p>
                      <p className="mt-1 text-sm text-slate-500">{organizer.slug}</p>
                    </div>

                    <div className="text-right">
                      <span
                        className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${
                          organizer.active
                            ? "bg-green-50 text-green-700"
                            : "bg-slate-100 text-slate-700"
                        }`}
                      >
                        {organizer.active ? "Active" : "Inactive"}
                      </span>
                      <p className="mt-2 text-xs text-slate-500">
                        {formatDate(organizer.created_at)}
                      </p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}