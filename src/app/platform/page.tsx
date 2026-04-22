import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requirePlatformAdmin } from "@/lib/auth/platform";
import { getBillingPlan } from "@/lib/billing/plans";

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
  if (status === "active") return "bg-green-50 text-green-700 ring-1 ring-green-200";
  if (status === "trialing") return "bg-blue-50 text-blue-700 ring-1 ring-blue-200";
  if (status === "past_due") return "bg-amber-50 text-amber-700 ring-1 ring-amber-200";
  if (status === "cancelled") return "bg-red-50 text-red-700 ring-1 ring-red-200";
  return "bg-slate-100 text-slate-700 ring-1 ring-slate-200";
}

function statusLabel(status: string) {
  if (status === "trialing") return "Trial";
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

function isOrganizerWorkspace(params: {
  studioName: string;
  subscription: SubscriptionRow | undefined;
}) {
  const { studioName, subscription } = params;
  const plan = subscription ? getPlan(subscription.subscription_plans) : null;
  const planCode = plan?.code?.toLowerCase() ?? "";
  const sharedPlan = planCode ? getBillingPlan(planCode as never) : null;

  if (sharedPlan?.audience === "organizer") {
    return true;
  }

  const normalizedName = studioName.trim().toLowerCase();
  return (
    normalizedName.endsWith(" organizer") ||
    normalizedName.includes(" organizer ") ||
    normalizedName.endsWith(" events") ||
    normalizedName.includes(" festival")
  );
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

    supabase.from("organizers").select("id, studio_id, active"),

    supabase.from("events").select("id, studio_id, visibility, status, event_type"),

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

  const studioWorkspaces = typedStudios.filter((studio) => {
    const subscription = subscriptionByStudioId.get(studio.id);
    return !isOrganizerWorkspace({
      studioName: studio.name,
      subscription,
    });
  });

  const organizerWorkspaces = typedStudios.filter((studio) => {
    const subscription = subscriptionByStudioId.get(studio.id);
    return isOrganizerWorkspace({
      studioName: studio.name,
      subscription,
    });
  });

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
  const revenueByStudioId = new Map<string, number>();
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
      const amount = Number(registration.total_amount ?? 0);
      grossRegistrationVolume += amount;
      revenueByStudioId.set(
        studioId,
        (revenueByStudioId.get(studioId) ?? 0) + amount
      );
    }
  }

  const studioWorkspaceIds = new Set(studioWorkspaces.map((studio) => studio.id));
  const organizerWorkspaceIds = new Set(organizerWorkspaces.map((studio) => studio.id));

  const studioSubscriptions = typedSubscriptions.filter((subscription) =>
    studioWorkspaceIds.has(subscription.studio_id)
  );
  const organizerSubscriptions = typedSubscriptions.filter((subscription) =>
    organizerWorkspaceIds.has(subscription.studio_id)
  );

  const activeStudioWorkspaces = studioSubscriptions.filter(
    (s) => s.status === "active"
  ).length;
  const trialingStudioWorkspaces = studioSubscriptions.filter(
    (s) => s.status === "trialing"
  ).length;
  const pastDueStudioWorkspaces = studioSubscriptions.filter(
    (s) => s.status === "past_due"
  ).length;
  const cancelledStudioWorkspaces = studioSubscriptions.filter(
    (s) => s.status === "cancelled"
  ).length;

  const activeOrganizerWorkspaces = organizerSubscriptions.filter(
    (s) => s.status === "active"
  ).length;
  const trialingOrganizerWorkspaces = organizerSubscriptions.filter(
    (s) => s.status === "trialing"
  ).length;

  const totalOrganizerAccounts = typedOrganizers.length;
  const activeOrganizerAccounts = typedOrganizers.filter((o) => o.active).length;

  const totalEvents = typedEvents.length;
  const publicEvents = typedEvents.filter(
    (event) => event.status === "published" && event.visibility === "public"
  ).length;

  const studioPublicEvents = typedEvents.filter(
    (event) =>
      studioWorkspaceIds.has(event.studio_id) &&
      event.status === "published" &&
      event.visibility === "public"
  ).length;

  const organizerPublicEvents = typedEvents.filter(
    (event) =>
      organizerWorkspaceIds.has(event.studio_id) &&
      event.status === "published" &&
      event.visibility === "public"
  ).length;

  const totalRegistrations = typedRegistrations.length;
  const paidRegistrations = typedRegistrations.filter(
    (registration) => registration.payment_status === "paid"
  ).length;

  const studioPlanMix = studioSubscriptions.reduce<Record<string, number>>(
    (acc, subscription) => {
      const plan = getPlan(subscription.subscription_plans);
      const key = plan?.name ?? "No plan";
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    },
    {}
  );

  const organizerPlanMix = organizerSubscriptions.reduce<Record<string, number>>(
    (acc, subscription) => {
      const plan = getPlan(subscription.subscription_plans);
      const key = plan?.name ?? "No plan";
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    },
    {}
  );

  const billingIssues = typedStudios
    .map((studio) => {
      const subscription = subscriptionByStudioId.get(studio.id);
      return {
        studio,
        subscription,
        workspaceType: organizerWorkspaceIds.has(studio.id) ? "Organizer" : "Studio",
      };
    })
    .filter(({ subscription }) => {
      if (!subscription) return true;
      return subscription.status === "past_due" || subscription.status === "cancelled";
    });

  const recentStudios = studioWorkspaces.slice(0, 8);
  const recentOrganizers = organizerWorkspaces.slice(0, 8);

  return (
    <div className="space-y-8 bg-[linear-gradient(180deg,rgba(255,247,237,0.42)_0%,rgba(255,255,255,0)_20%)] p-1">
      <section className="overflow-hidden rounded-[32px] border border-[var(--brand-border)] bg-white shadow-sm">
        <div className="bg-[linear-gradient(135deg,var(--brand-primary)_0%,#4b2e83_100%)] px-6 py-8 text-white md:px-8">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-3xl">
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-white/70">
                DanceFlow Platform Admin
              </p>
              <h1 className="mt-3 text-3xl font-semibold tracking-tight md:text-4xl">
                Platform Dashboard
              </h1>
              <p className="mt-3 text-sm leading-7 text-white/85 md:text-base">
                Monitor subscription health, workspace growth, organizer adoption, public events, and registration activity across the platform without mixing studio and organizer counts together.
              </p>
            </div>

            <div className="flex flex-wrap gap-3">
              <Link
                href="/platform/studios"
                className="rounded-xl border border-white/20 bg-white/10 px-4 py-2 text-sm font-medium text-white hover:bg-white/15"
              >
                Studio Directory
              </Link>
              <Link
                href="/platform/organizers"
                className="rounded-xl border border-white/20 bg-white/10 px-4 py-2 text-sm font-medium text-white hover:bg-white/15"
              >
                Organizer Directory
              </Link>
              <Link
                href="/platform/billing"
                className="rounded-xl bg-white px-4 py-2 text-sm font-medium text-[var(--brand-primary)] hover:bg-white/90"
              >
                Billing Health
              </Link>
            </div>
          </div>
        </div>

        <div className="border-t border-[var(--brand-border)] bg-[var(--brand-primary-soft)]/35 px-6 py-5 md:px-8">
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <div className="rounded-2xl border border-sky-200 bg-sky-50 p-4">
              <p className="text-sm text-sky-700">Studio Workspaces</p>
              <p className="mt-1 text-2xl font-semibold text-sky-950">
                {studioWorkspaces.length}
              </p>
            </div>

            <div className="rounded-2xl border border-violet-200 bg-violet-50 p-4">
              <p className="text-sm text-violet-700">Organizer Workspaces</p>
              <p className="mt-1 text-2xl font-semibold text-violet-950">
                {organizerWorkspaces.length}
              </p>
            </div>

            <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
              <p className="text-sm text-emerald-700">Public Events</p>
              <p className="mt-1 text-2xl font-semibold text-emerald-950">
                {publicEvents}
              </p>
            </div>

            <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4">
              <p className="text-sm text-amber-700">Gross Reg Volume</p>
              <p className="mt-1 text-2xl font-semibold text-amber-950">
                {formatMoney(grossRegistrationVolume, "USD")}
              </p>
            </div>
          </div>
        </div>
      </section>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-sm text-slate-500">Studio Active + Trial</p>
          <p className="mt-2 text-3xl font-semibold text-slate-950">
            {activeStudioWorkspaces + trialingStudioWorkspaces}
          </p>
          <p className="mt-2 text-sm text-slate-500">
            {activeStudioWorkspaces} active • {trialingStudioWorkspaces} trial
          </p>
        </div>

        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-sm text-slate-500">Organizer Active + Trial</p>
          <p className="mt-2 text-3xl font-semibold text-slate-950">
            {activeOrganizerWorkspaces + trialingOrganizerWorkspaces}
          </p>
          <p className="mt-2 text-sm text-slate-500">
            {activeOrganizerWorkspaces} active • {trialingOrganizerWorkspaces} trial
          </p>
        </div>

        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-sm text-slate-500">Studio Billing Issues</p>
          <p className="mt-2 text-3xl font-semibold text-slate-950">
            {pastDueStudioWorkspaces + cancelledStudioWorkspaces}
          </p>
          <p className="mt-2 text-sm text-slate-500">
            {pastDueStudioWorkspaces} past due • {cancelledStudioWorkspaces} cancelled
          </p>
        </div>

        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-sm text-slate-500">Organizer Accounts</p>
          <p className="mt-2 text-3xl font-semibold text-slate-950">
            {totalOrganizerAccounts}
          </p>
          <p className="mt-2 text-sm text-slate-500">
            {activeOrganizerAccounts} active
          </p>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-sm text-slate-500">Studio Public Events</p>
          <p className="mt-2 text-3xl font-semibold text-slate-950">{studioPublicEvents}</p>
        </div>

        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-sm text-slate-500">Organizer Public Events</p>
          <p className="mt-2 text-3xl font-semibold text-slate-950">
            {organizerPublicEvents}
          </p>
        </div>

        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-sm text-slate-500">Registrations</p>
          <p className="mt-2 text-3xl font-semibold text-slate-950">{totalRegistrations}</p>
        </div>

        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-sm text-slate-500">Paid Registrations</p>
          <p className="mt-2 text-3xl font-semibold text-slate-950">{paidRegistrations}</p>
        </div>
      </div>

      <div className="grid gap-6 xl:grid-cols-[1.05fr_0.95fr]">
        <div className="rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h2 className="text-xl font-semibold text-slate-900">Subscription Mix</h2>
              <p className="mt-1 text-sm text-slate-500">
                See studio and organizer plan distribution separately.
              </p>
            </div>

            <Link href="/platform/billing" className="text-sm font-medium underline">
              Open billing
            </Link>
          </div>

          <div className="mt-5 grid gap-6 md:grid-cols-2">
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <p className="text-sm font-semibold text-slate-900">Studio Plans</p>
              <div className="mt-4 space-y-3">
                {Object.keys(studioPlanMix).length === 0 ? (
                  <p className="text-sm text-slate-500">No studio subscriptions yet.</p>
                ) : (
                  Object.entries(studioPlanMix).map(([planName, count]) => (
                    <div key={planName} className="flex items-center justify-between text-sm">
                      <span className="text-slate-600">{planName}</span>
                      <span className="font-semibold text-slate-950">{count}</span>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <p className="text-sm font-semibold text-slate-900">Organizer Plans</p>
              <div className="mt-4 space-y-3">
                {Object.keys(organizerPlanMix).length === 0 ? (
                  <p className="text-sm text-slate-500">No organizer subscriptions yet.</p>
                ) : (
                  Object.entries(organizerPlanMix).map(([planName, count]) => (
                    <div key={planName} className="flex items-center justify-between text-sm">
                      <span className="text-slate-600">{planName}</span>
                      <span className="font-semibold text-slate-950">{count}</span>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>

          <div className="mt-6 rounded-xl border border-slate-200 bg-slate-50 p-4">
            <p className="text-sm text-slate-500">Gross Registration Volume</p>
            <p className="mt-1 text-2xl font-semibold text-slate-900">
              {formatMoney(grossRegistrationVolume, "USD")}
            </p>
            <p className="mt-1 text-sm text-slate-500">
              Based on paid and partially paid event registrations.
            </p>
          </div>
        </div>

        <div className="rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h2 className="text-xl font-semibold text-slate-900">Billing Issues</h2>
              <p className="mt-1 text-sm text-slate-500">
                Workspaces that need payment or subscription attention.
              </p>
            </div>

            <Link href="/platform/billing" className="text-sm font-medium underline">
              Open billing
            </Link>
          </div>

          {billingIssues.length === 0 ? (
            <div className="mt-5 rounded-xl border border-green-200 bg-green-50 px-4 py-10 text-sm text-green-700">
              No billing issues detected right now.
            </div>
          ) : (
            <div className="mt-5 space-y-3">
              {billingIssues.slice(0, 8).map(({ studio, subscription, workspaceType }) => {
                const plan = subscription ? getPlan(subscription.subscription_plans) : null;

                return (
                  <div key={studio.id} className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <Link
                          href={`/platform/studios/${studio.id}`}
                          className="font-medium text-slate-900 underline"
                        >
                          {studio.name}
                        </Link>
                        <p className="mt-1 text-sm text-slate-500">
                          {workspaceType} • Plan: {plan?.name ?? "No plan"}
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
        <div className="rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm">
          <div className="grid gap-6 lg:grid-cols-2">
            <div>
              <div className="flex items-center justify-between gap-4">
                <div>
                  <h2 className="text-xl font-semibold text-slate-900">Recent Studios</h2>
                  <p className="mt-1 text-sm text-slate-500">
                    Studio workspace health and usage.
                  </p>
                </div>

                <Link href="/platform/studios" className="text-sm font-medium underline">
                  Open full list
                </Link>
              </div>

              {recentStudios.length === 0 ? (
                <div className="mt-5 rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-10 text-sm text-slate-500">
                  No studios yet.
                </div>
              ) : (
                <div className="mt-5 space-y-3">
                  {recentStudios.map((studio) => {
                    const subscription = subscriptionByStudioId.get(studio.id);
                    const plan = subscription ? getPlan(subscription.subscription_plans) : null;

                    return (
                      <div key={studio.id} className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <div>
                            <Link
                              href={`/platform/studios/${studio.id}`}
                              className="font-medium text-slate-900 underline"
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
                          {plan?.name ?? "No plan"} • {eventsByStudioId.get(studio.id) ?? 0} events •{" "}
                          {registrationsByStudioId.get(studio.id) ?? 0} registrations
                        </p>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div>
              <div className="flex items-center justify-between gap-4">
                <div>
                  <h2 className="text-xl font-semibold text-slate-900">Recent Organizers</h2>
                  <p className="mt-1 text-sm text-slate-500">
                    Organizer workspace activity and event usage.
                  </p>
                </div>

                <Link href="/platform/organizers" className="text-sm font-medium underline">
                  Open full list
                </Link>
              </div>

              {recentOrganizers.length === 0 ? (
                <div className="mt-5 rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-10 text-sm text-slate-500">
                  No organizers yet.
                </div>
              ) : (
                <div className="mt-5 space-y-3">
                  {recentOrganizers.map((studio) => {
                    const subscription = subscriptionByStudioId.get(studio.id);
                    const plan = subscription ? getPlan(subscription.subscription_plans) : null;

                    return (
                      <div key={studio.id} className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <div>
                            <Link
                              href={`/platform/studios/${studio.id}`}
                              className="font-medium text-slate-900 underline"
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
                          {plan?.name ?? "No plan"} • {organizersByStudioId.get(studio.id) ?? 0} organizer accounts •{" "}
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

        <div className="space-y-6">
          <div className="rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm">
            <h2 className="text-xl font-semibold text-slate-900">Platform Actions</h2>

            <div className="mt-5 grid gap-3">
              <Link
                href="/platform/studios"
                className="rounded-xl border border-slate-300 px-4 py-3 hover:bg-slate-50"
              >
                Review studio directory
              </Link>

              <Link
                href="/platform/organizers"
                className="rounded-xl border border-slate-300 px-4 py-3 hover:bg-slate-50"
              >
                Review organizer directory
              </Link>

              <Link
                href="/platform/billing"
                className="rounded-xl border border-slate-300 px-4 py-3 hover:bg-slate-50"
              >
                Resolve billing issues
              </Link>

              <Link
                href="/platform/subscriptions"
                className="rounded-xl border border-slate-300 px-4 py-3 hover:bg-slate-50"
              >
                Review subscriptions
              </Link>
            </div>
          </div>

          <div className="rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm">
            <h2 className="text-xl font-semibold text-slate-900">Workspace Mix</h2>

            <div className="mt-5 space-y-4">
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                <p className="text-sm text-slate-500">Studios</p>
                <p className="mt-1 text-2xl font-semibold text-slate-900">
                  {studioWorkspaces.length}
                </p>
              </div>

              <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                <p className="text-sm text-slate-500">Organizers</p>
                <p className="mt-1 text-2xl font-semibold text-slate-900">
                  {organizerWorkspaces.length}
                </p>
              </div>

              <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                <p className="text-sm text-slate-500">Public Event Split</p>
                <p className="mt-1 text-sm text-slate-700">
                  Studios: {studioPublicEvents} • Organizers: {organizerPublicEvents}
                </p>
              </div>

              <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                <p className="text-sm text-slate-500">Revenue Mix</p>
                <p className="mt-1 text-sm text-slate-700">
                  Platform registrations total {formatMoney(grossRegistrationVolume, "USD")}
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}