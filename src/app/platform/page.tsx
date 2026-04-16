import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requirePlatformAdmin } from "@/lib/auth/platform";

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
  current_period_end: string | null;
  cancel_at_period_end: boolean;
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
  active: boolean;
};

type EventRow = {
  id: string;
  studio_id: string;
  visibility: string;
  status: string;
  event_type: string;
};

type RegistrationRow = {
  id: string;
  event_id: string;
  status: string;
  payment_status: string | null;
  total_amount: number | null;
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

function formatMoney(value: number, currency = "USD") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(value);
}

export default async function PlatformDashboardPage() {
  await requirePlatformAdmin();

  const supabase = await createClient();

  const [
    { data: studios, error: studiosError },
    { data: subscriptions, error: subscriptionsError },
    { data: organizers, error: organizersError },
    { data: events, error: eventsError },
    { data: registrations, error: registrationsError },
  ] = await Promise.all([
    supabase
      .from("studios")
      .select("id, name, created_at")
      .order("created_at", { ascending: false }),

    supabase
      .from("studio_subscriptions")
      .select(`
        id,
        studio_id,
        status,
        billing_interval,
        current_period_end,
        cancel_at_period_end,
        subscription_plans (
          code,
          name
        )
      `),

    supabase
      .from("organizers")
      .select("id, studio_id, active"),

    supabase
      .from("events")
      .select("id, studio_id, visibility, status, event_type"),

    supabase
      .from("event_registrations")
      .select("id, event_id, status, payment_status, total_amount"),
  ]);

  if (studiosError) {
    throw new Error(`Failed to load studios: ${studiosError.message}`);
  }

  if (subscriptionsError) {
    throw new Error(`Failed to load subscriptions: ${subscriptionsError.message}`);
  }

  if (organizersError) {
    throw new Error(`Failed to load organizers: ${organizersError.message}`);
  }

  if (eventsError) {
    throw new Error(`Failed to load events: ${eventsError.message}`);
  }

  if (registrationsError) {
    throw new Error(`Failed to load registrations: ${registrationsError.message}`);
  }

  const typedStudios = (studios ?? []) as StudioRow[];
  const typedSubscriptions = (subscriptions ?? []) as SubscriptionRow[];
  const typedOrganizers = (organizers ?? []) as OrganizerRow[];
  const typedEvents = (events ?? []) as EventRow[];
  const typedRegistrations = (registrations ?? []) as RegistrationRow[];

  const subscriptionByStudioId = new Map(
    typedSubscriptions.map((subscription) => [subscription.studio_id, subscription])
  );

  const organizersByStudioId = new Map<string, number>();
  for (const organizer of typedOrganizers) {
    organizersByStudioId.set(
      organizer.studio_id,
      (organizersByStudioId.get(organizer.studio_id) ?? 0) + 1
    );
  }

  const eventsByStudioId = new Map<string, number>();
  const publicEventsByStudioId = new Map<string, number>();
  for (const event of typedEvents) {
    eventsByStudioId.set(event.studio_id, (eventsByStudioId.get(event.studio_id) ?? 0) + 1);

    if (event.status === "published" && event.visibility === "public") {
      publicEventsByStudioId.set(
        event.studio_id,
        (publicEventsByStudioId.get(event.studio_id) ?? 0) + 1
      );
    }
  }

  const eventStudioMap = new Map(typedEvents.map((event) => [event.id, event.studio_id]));
  const registrationsByStudioId = new Map<string, number>();
  let grossRegistrationVolume = 0;

  for (const registration of typedRegistrations) {
    const studioId = eventStudioMap.get(registration.event_id);
    if (!studioId) continue;

    registrationsByStudioId.set(
      studioId,
      (registrationsByStudioId.get(studioId) ?? 0) + 1
    );

    if (
      registration.payment_status === "paid" ||
      registration.payment_status === "partial"
    ) {
      grossRegistrationVolume += Number(registration.total_amount ?? 0);
    }
  }

  const totalStudios = typedStudios.length;
  const activeStudios = typedSubscriptions.filter((s) => s.status === "active").length;
  const trialingStudios = typedSubscriptions.filter((s) => s.status === "trialing").length;
  const pastDueStudios = typedSubscriptions.filter((s) => s.status === "past_due").length;
  const cancelledStudios = typedSubscriptions.filter((s) => s.status === "cancelled").length;

  const totalOrganizers = typedOrganizers.length;
  const activeOrganizers = typedOrganizers.filter((o) => o.active).length;

  const totalEvents = typedEvents.length;
  const publicEvents = typedEvents.filter(
    (event) => event.status === "published" && event.visibility === "public"
  ).length;

  const totalRegistrations = typedRegistrations.length;
  const paidRegistrations = typedRegistrations.filter(
    (registration) => registration.payment_status === "paid"
  ).length;

  const studiosByPlan = typedSubscriptions.reduce<Record<string, number>>((acc, subscription) => {
    const plan = getPlan(subscription.subscription_plans);
    const key = plan?.name ?? "No plan";
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});

  const billingIssues = typedStudios
    .map((studio) => {
      const subscription = subscriptionByStudioId.get(studio.id);
      return {
        studio,
        subscription,
      };
    })
    .filter(({ subscription }) => {
      if (!subscription) return true;
      return subscription.status === "past_due" || subscription.status === "cancelled";
    });

  const recentStudios = typedStudios.slice(0, 8);

  return (
    <div className="space-y-8">
      <div className="rounded-3xl border bg-white p-6 shadow-sm">
        <h1 className="text-3xl font-semibold tracking-tight text-slate-900">
          Platform Dashboard
        </h1>
        <p className="mt-2 text-slate-600">
          Monitor studios, subscriptions, organizers, events, registrations, and billing health across the platform.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-3 xl:grid-cols-6">
        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Studios</p>
          <p className="mt-2 text-3xl font-semibold">{totalStudios}</p>
        </div>

        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Active Subs</p>
          <p className="mt-2 text-3xl font-semibold">{activeStudios}</p>
        </div>

        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Trialing</p>
          <p className="mt-2 text-3xl font-semibold">{trialingStudios}</p>
        </div>

        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Past Due</p>
          <p className="mt-2 text-3xl font-semibold">{pastDueStudios}</p>
        </div>

        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Cancelled</p>
          <p className="mt-2 text-3xl font-semibold">{cancelledStudios}</p>
        </div>

        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Organizer Count</p>
          <p className="mt-2 text-3xl font-semibold">{totalOrganizers}</p>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Active Organizers</p>
          <p className="mt-2 text-3xl font-semibold">{activeOrganizers}</p>
        </div>

        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Events</p>
          <p className="mt-2 text-3xl font-semibold">{totalEvents}</p>
        </div>

        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Public Events</p>
          <p className="mt-2 text-3xl font-semibold">{publicEvents}</p>
        </div>

        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Registrations</p>
          <p className="mt-2 text-3xl font-semibold">{totalRegistrations}</p>
          <p className="mt-1 text-sm text-slate-500">{paidRegistrations} paid</p>
        </div>
      </div>

      <div className="grid gap-6 xl:grid-cols-[1.05fr_0.95fr]">
        <div className="rounded-2xl border bg-white p-6 shadow-sm">
          <h2 className="text-xl font-semibold text-slate-900">Subscription Mix</h2>
          <div className="mt-5 grid gap-4 md:grid-cols-2">
            {Object.keys(studiosByPlan).length === 0 ? (
              <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-10 text-sm text-slate-500 md:col-span-2">
                No subscription data yet.
              </div>
            ) : (
              Object.entries(studiosByPlan).map(([planName, count]) => (
                <div key={planName} className="rounded-xl border bg-slate-50 p-4">
                  <p className="text-sm text-slate-500">{planName}</p>
                  <p className="mt-1 text-2xl font-semibold text-slate-900">{count}</p>
                </div>
              ))
            )}
          </div>

          <div className="mt-6 rounded-xl border bg-slate-50 p-4">
            <p className="text-sm text-slate-500">Gross Registration Volume</p>
            <p className="mt-1 text-2xl font-semibold text-slate-900">
              {formatMoney(grossRegistrationVolume, "USD")}
            </p>
            <p className="mt-1 text-sm text-slate-500">
              Based on paid and partially paid event registrations.
            </p>
          </div>
        </div>

        <div className="rounded-2xl border bg-white p-6 shadow-sm">
          <div className="flex items-center justify-between gap-4">
            <h2 className="text-xl font-semibold text-slate-900">Billing Issues</h2>
            <Link href="/platform/billing" className="text-sm underline">
              Open billing
            </Link>
          </div>

          {billingIssues.length === 0 ? (
            <div className="mt-5 rounded-xl border border-green-200 bg-green-50 px-4 py-10 text-sm text-green-700">
              No billing issues detected right now.
            </div>
          ) : (
            <div className="mt-5 space-y-3">
              {billingIssues.map(({ studio, subscription }) => {
                const plan = subscription ? getPlan(subscription.subscription_plans) : null;

                return (
                  <div key={studio.id} className="rounded-xl border bg-slate-50 p-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <Link
                          href={`/platform/studios/${studio.id}`}
                          className="font-medium underline text-slate-900"
                        >
                          {studio.name}
                        </Link>
                        <p className="mt-1 text-sm text-slate-500">
                          Plan: {plan?.name ?? "No plan"}
                        </p>
                      </div>

                      <span
                        className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${statusBadgeClass(
                          subscription?.status ?? "inactive"
                        )}`}
                      >
                        {statusLabel(subscription?.status ?? "inactive")}
                      </span>
                    </div>

                    <p className="mt-3 text-sm text-slate-600">
                      Period end: {formatDate(subscription?.current_period_end ?? null)}
                    </p>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <div className="grid gap-6 xl:grid-cols-[1.15fr_0.85fr]">
        <div className="rounded-2xl border bg-white p-6 shadow-sm">
          <div className="flex items-center justify-between gap-4">
            <h2 className="text-xl font-semibold text-slate-900">Studios</h2>
            <Link href="/platform/studios" className="text-sm underline">
              Open full list
            </Link>
          </div>

          {typedStudios.length === 0 ? (
            <div className="mt-5 rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-10 text-sm text-slate-500">
              No studios yet.
            </div>
          ) : (
            <div className="mt-5 overflow-hidden rounded-xl border">
              <table className="min-w-full divide-y divide-slate-200 text-sm">
                <thead className="bg-slate-50">
                  <tr>
                    <th className="px-4 py-3 text-left font-medium text-slate-600">Studio</th>
                    <th className="px-4 py-3 text-left font-medium text-slate-600">Plan</th>
                    <th className="px-4 py-3 text-left font-medium text-slate-600">Status</th>
                    <th className="px-4 py-3 text-left font-medium text-slate-600">Organizers</th>
                    <th className="px-4 py-3 text-left font-medium text-slate-600">Events</th>
                    <th className="px-4 py-3 text-left font-medium text-slate-600">Registrations</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 bg-white">
                  {typedStudios.slice(0, 12).map((studio) => {
                    const subscription = subscriptionByStudioId.get(studio.id);
                    const plan = subscription ? getPlan(subscription.subscription_plans) : null;

                    return (
                      <tr key={studio.id}>
                        <td className="px-4 py-3 text-slate-900">
                          <Link
                            href={`/platform/studios/${studio.id}`}
                            className="font-medium underline"
                          >
                            {studio.name}
                          </Link>
                        </td>
                        <td className="px-4 py-3 text-slate-700">{plan?.name ?? "—"}</td>
                        <td className="px-4 py-3">
                          <span
                            className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${statusBadgeClass(
                              subscription?.status ?? "inactive"
                            )}`}
                          >
                            {statusLabel(subscription?.status ?? "inactive")}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-slate-700">
                          {organizersByStudioId.get(studio.id) ?? 0}
                        </td>
                        <td className="px-4 py-3 text-slate-700">
                          {eventsByStudioId.get(studio.id) ?? 0}
                        </td>
                        <td className="px-4 py-3 text-slate-700">
                          {registrationsByStudioId.get(studio.id) ?? 0}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="space-y-6">
          <div className="rounded-2xl border bg-white p-6 shadow-sm">
            <h2 className="text-xl font-semibold text-slate-900">Recent Studios</h2>

            {recentStudios.length === 0 ? (
              <div className="mt-5 rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-10 text-sm text-slate-500">
                No recent studios yet.
              </div>
            ) : (
              <div className="mt-5 space-y-3">
                {recentStudios.map((studio) => {
                  const subscription = subscriptionByStudioId.get(studio.id);
                  const plan = subscription ? getPlan(subscription.subscription_plans) : null;

                  return (
                    <div key={studio.id} className="rounded-xl border bg-slate-50 p-4">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <Link
                            href={`/platform/studios/${studio.id}`}
                            className="font-medium underline text-slate-900"
                          >
                            {studio.name}
                          </Link>
                          <p className="mt-1 text-sm text-slate-500">
                            Created {formatDate(studio.created_at)}
                          </p>
                        </div>

                        <span
                          className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${statusBadgeClass(
                            subscription?.status ?? "inactive"
                          )}`}
                        >
                          {statusLabel(subscription?.status ?? "inactive")}
                        </span>
                      </div>

                      <p className="mt-3 text-sm text-slate-600">
                        {plan?.name ?? "No plan"} • {organizersByStudioId.get(studio.id) ?? 0} organizers •{" "}
                        {publicEventsByStudioId.get(studio.id) ?? 0} public events
                      </p>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}