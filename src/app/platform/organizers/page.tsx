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
  name: string;
  slug: string;
  active: boolean;
  created_at: string;
};

type EventRow = {
  id: string;
  organizer_id: string | null;
  studio_id: string;
  status: string;
  visibility: string;
};

type RegistrationRow = {
  id: string;
  event_id: string;
  payment_status: string | null;
  total_amount: number | null;
};

type SearchParams = Promise<{
  q?: string;
  status?: string;
}>;

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
  if (status === "trialing") return "Trial";
  if (status === "active") return "Active";
  if (status === "past_due") return "Past Due";
  if (status === "cancelled") return "Cancelled";
  if (status === "inactive") return "Inactive";
  return status;
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

export default async function PlatformOrganizersPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  await requirePlatformAdmin();

  const query = await searchParams;
  const q = (query.q ?? "").trim().toLowerCase();
  const statusFilter = (query.status ?? "").trim().toLowerCase();

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

    supabase.from("studio_subscriptions").select(`
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
      .select("id, studio_id, name, slug, active, created_at")
      .order("created_at", { ascending: false }),

    supabase.from("events").select("id, organizer_id, studio_id, status, visibility"),

    supabase.from("event_registrations").select("id, event_id, payment_status, total_amount"),
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

  const organizerWorkspaces = typedStudios.filter((studio) => {
    const subscription = subscriptionByStudioId.get(studio.id);
    return isOrganizerWorkspace({
      studioName: studio.name,
      subscription,
    });
  });

  const organizerCounts = new Map<string, { total: number; active: number }>();
  for (const organizer of typedOrganizers) {
    const current = organizerCounts.get(organizer.studio_id) ?? { total: 0, active: 0 };
    current.total += 1;
    if (organizer.active) current.active += 1;
    organizerCounts.set(organizer.studio_id, current);
  }

  const eventsByStudioId = new Map<string, EventRow[]>();
  for (const event of typedEvents) {
    const current = eventsByStudioId.get(event.studio_id) ?? [];
    current.push(event);
    eventsByStudioId.set(event.studio_id, current);
  }

  const registrationsByEventId = new Map<string, RegistrationRow[]>();
  for (const registration of typedRegistrations) {
    const current = registrationsByEventId.get(registration.event_id) ?? [];
    current.push(registration);
    registrationsByEventId.set(registration.event_id, current);
  }

  const filteredWorkspaces = organizerWorkspaces.filter((studio) => {
    const subscription = subscriptionByStudioId.get(studio.id);
    const subscriptionStatus = subscription?.status?.toLowerCase() ?? "inactive";
    const plan = subscription ? getPlan(subscription.subscription_plans) : null;
    const organizerStats = organizerCounts.get(studio.id) ?? { total: 0, active: 0 };

    if (statusFilter && subscriptionStatus !== statusFilter) {
      return false;
    }

    if (q) {
      const haystack = [
        studio.name,
        plan?.name ?? "",
        plan?.code ?? "",
        subscription?.status ?? "",
        organizerStats.total ? `${organizerStats.total}` : "",
      ]
        .join(" ")
        .toLowerCase();

      if (!haystack.includes(q)) {
        return false;
      }
    }

    return true;
  });

  const totalOrganizerWorkspaces = organizerWorkspaces.length;
  const activeOrganizerWorkspaces = organizerWorkspaces.filter((studio) => {
    const subscription = subscriptionByStudioId.get(studio.id);
    return subscription?.status === "active" || subscription?.status === "trialing";
  }).length;

  const workspacesWithEvents = organizerWorkspaces.filter(
    (studio) => (eventsByStudioId.get(studio.id) ?? []).length > 0
  ).length;

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
                Organizer Directory
              </h1>
              <p className="mt-3 text-sm leading-7 text-white/85 md:text-base">
                Review organizer workspaces separately from studios so the platform admin view clearly reflects organizer subscriptions, event activity, and public event usage.
              </p>
            </div>

            <div className="flex flex-wrap gap-3">
              <Link
                href="/platform/studios"
                className="rounded-xl border border-white/20 bg-white/10 px-4 py-2 text-sm font-medium text-white hover:bg-white/15"
              >
                Open Studio Directory
              </Link>
              <Link
                href="/platform"
                className="rounded-xl bg-white px-4 py-2 text-sm font-medium text-[var(--brand-primary)] hover:bg-white/90"
              >
                Back to Platform Dashboard
              </Link>
            </div>
          </div>
        </div>

        <div className="border-t border-[var(--brand-border)] bg-[var(--brand-primary-soft)]/35 px-6 py-5 md:px-8">
          <div className="grid gap-4 md:grid-cols-4">
            <div className="rounded-2xl border border-violet-200 bg-violet-50 p-4">
              <p className="text-sm text-violet-700">Organizer Workspaces</p>
              <p className="mt-1 text-2xl font-semibold text-violet-950">
                {totalOrganizerWorkspaces}
              </p>
            </div>

            <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
              <p className="text-sm text-emerald-700">Active + Trial</p>
              <p className="mt-1 text-2xl font-semibold text-emerald-950">
                {activeOrganizerWorkspaces}
              </p>
            </div>

            <div className="rounded-2xl border border-sky-200 bg-sky-50 p-4">
              <p className="text-sm text-sky-700">With Events</p>
              <p className="mt-1 text-2xl font-semibold text-sky-950">
                {workspacesWithEvents}
              </p>
            </div>

            <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4">
              <p className="text-sm text-amber-700">Filtered Results</p>
              <p className="mt-1 text-2xl font-semibold text-amber-950">
                {filteredWorkspaces.length}
              </p>
            </div>
          </div>
        </div>
      </section>

      <form className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="grid gap-4 md:grid-cols-[1fr_220px_auto]">
          <div>
            <label htmlFor="q" className="mb-1 block text-sm font-medium text-slate-700">
              Search organizer workspaces
            </label>
            <input
              id="q"
              name="q"
              defaultValue={query.q ?? ""}
              className="w-full rounded-xl border border-slate-300 px-3 py-2"
              placeholder="Organizer workspace, plan, or status"
            />
          </div>

          <div>
            <label htmlFor="status" className="mb-1 block text-sm font-medium text-slate-700">
              Subscription Status
            </label>
            <select
              id="status"
              name="status"
              defaultValue={query.status ?? ""}
              className="w-full rounded-xl border border-slate-300 px-3 py-2"
            >
              <option value="">All</option>
              <option value="active">Active</option>
              <option value="trialing">Trial</option>
              <option value="past_due">Past Due</option>
              <option value="cancelled">Cancelled</option>
              <option value="inactive">Inactive</option>
            </select>
          </div>

          <div className="flex items-end gap-3">
            <button
              type="submit"
              className="rounded-xl bg-slate-900 px-4 py-2 text-white hover:bg-slate-800"
            >
              Apply
            </button>

            <Link
              href="/platform/organizers"
              className="rounded-xl border border-slate-300 px-4 py-2 hover:bg-slate-50"
            >
              Reset
            </Link>
          </div>
        </div>
      </form>

      <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-200 px-6 py-4">
          <h2 className="text-lg font-semibold text-slate-900">Organizer Directory</h2>
          <p className="mt-1 text-sm text-slate-500">
            Showing {filteredWorkspaces.length} of {organizerWorkspaces.length} organizer workspaces.
          </p>
        </div>

        {filteredWorkspaces.length === 0 ? (
          <div className="px-6 py-12 text-center">
            <p className="text-base font-medium text-slate-900">
              No organizer workspaces found
            </p>
            <p className="mt-2 text-sm text-slate-500">
              Adjust your filters and try again.
            </p>
          </div>
        ) : (
          <div className="overflow-hidden">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50">
                <tr>
                  <th className="px-4 py-3 text-left font-medium text-slate-600">
                    Organizer Workspace
                  </th>
                  <th className="px-4 py-3 text-left font-medium text-slate-600">Plan</th>
                  <th className="px-4 py-3 text-left font-medium text-slate-600">Status</th>
                  <th className="px-4 py-3 text-left font-medium text-slate-600">
                    Organizer Accounts
                  </th>
                  <th className="px-4 py-3 text-left font-medium text-slate-600">Events</th>
                  <th className="px-4 py-3 text-left font-medium text-slate-600">
                    Public Events
                  </th>
                  <th className="px-4 py-3 text-left font-medium text-slate-600">
                    Registrations
                  </th>
                  <th className="px-4 py-3 text-left font-medium text-slate-600">Revenue</th>
                  <th className="px-4 py-3 text-left font-medium text-slate-600">Created</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 bg-white">
                {filteredWorkspaces.map((studio) => {
                  const subscription = subscriptionByStudioId.get(studio.id);
                  const plan = subscription ? getPlan(subscription.subscription_plans) : null;
                  const organizerStats = organizerCounts.get(studio.id) ?? {
                    total: 0,
                    active: 0,
                  };
                  const workspaceEvents = eventsByStudioId.get(studio.id) ?? [];
                  const publicEvents = workspaceEvents.filter(
                    (event) => event.status === "published" && event.visibility === "public"
                  ).length;

                  const workspaceRegistrations = workspaceEvents.flatMap(
                    (event) => registrationsByEventId.get(event.id) ?? []
                  );

                  const revenue = workspaceRegistrations.reduce((sum, registration) => {
                    if (
                      registration.payment_status !== "paid" &&
                      registration.payment_status !== "partial"
                    ) {
                      return sum;
                    }

                    return sum + Number(registration.total_amount ?? 0);
                  }, 0);

                  return (
                    <tr key={studio.id}>
                      <td className="px-4 py-4 text-slate-900">
                        <div>
                          <Link
                            href={`/platform/studios/${studio.id}`}
                            className="font-medium underline"
                          >
                            {studio.name}
                          </Link>
                          <p className="mt-1 text-xs text-slate-500">{studio.id}</p>
                        </div>
                      </td>

                      <td className="px-4 py-4 text-slate-700">
                        {plan?.name ?? "No plan"}
                      </td>

                      <td className="px-4 py-4">
                        <span
                          className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${statusBadgeClass(
                            subscription?.status ?? "inactive"
                          )}`}
                        >
                          {statusLabel(subscription?.status ?? "inactive")}
                        </span>
                      </td>

                      <td className="px-4 py-4 text-slate-700">
                        {organizerStats.total}
                        <span className="ml-1 text-xs text-slate-500">
                          ({organizerStats.active} active)
                        </span>
                      </td>

                      <td className="px-4 py-4 text-slate-700">{workspaceEvents.length}</td>

                      <td className="px-4 py-4 text-slate-700">{publicEvents}</td>

                      <td className="px-4 py-4 text-slate-700">
                        {workspaceRegistrations.length}
                      </td>

                      <td className="px-4 py-4 text-slate-700">
                        {formatMoney(revenue, "USD")}
                      </td>

                      <td className="px-4 py-4 text-slate-700">
                        {formatDate(studio.created_at)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}