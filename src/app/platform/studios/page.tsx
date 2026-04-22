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
  status: string;
  visibility: string;
};

type SearchParams = Promise<{
  q?: string;
  status?: string;
  plan?: string;
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

export default async function PlatformStudiosPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  await requirePlatformAdmin();

  const query = await searchParams;
  const q = (query.q ?? "").trim().toLowerCase();
  const statusFilter = (query.status ?? "").trim().toLowerCase();
  const planFilter = (query.plan ?? "").trim().toLowerCase();

  const supabase = await createClient();

  const [
    { data: studios, error: studiosError },
    { data: subscriptions, error: subscriptionsError },
    { data: organizers, error: organizersError },
    { data: events, error: eventsError },
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

    supabase.from("organizers").select("id, studio_id, active"),

    supabase.from("events").select("id, studio_id, status, visibility"),
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

  const typedStudios = (studios ?? []) as StudioRow[];
  const typedSubscriptions = (subscriptions ?? []) as SubscriptionRow[];
  const typedOrganizers = (organizers ?? []) as OrganizerRow[];
  const typedEvents = (events ?? []) as EventRow[];

  const subscriptionByStudioId = new Map(
    typedSubscriptions.map((subscription) => [subscription.studio_id, subscription])
  );

  const organizerCounts = new Map<string, { total: number; active: number }>();
  for (const organizer of typedOrganizers) {
    const current = organizerCounts.get(organizer.studio_id) ?? { total: 0, active: 0 };
    current.total += 1;
    if (organizer.active) current.active += 1;
    organizerCounts.set(organizer.studio_id, current);
  }

  const eventCounts = new Map<string, { total: number; publicPublished: number }>();
  for (const event of typedEvents) {
    const current = eventCounts.get(event.studio_id) ?? { total: 0, publicPublished: 0 };
    current.total += 1;
    if (event.status === "published" && event.visibility === "public") {
      current.publicPublished += 1;
    }
    eventCounts.set(event.studio_id, current);
  }

  const studioOnlyWorkspaces = typedStudios.filter((studio) => {
    const subscription = subscriptionByStudioId.get(studio.id);
    return !isOrganizerWorkspace({
      studioName: studio.name,
      subscription,
    });
  });

  const organizerWorkspaceCount = typedStudios.length - studioOnlyWorkspaces.length;

  const filteredStudios = studioOnlyWorkspaces.filter((studio) => {
    const subscription = subscriptionByStudioId.get(studio.id);
    const plan = subscription ? getPlan(subscription.subscription_plans) : null;
    const planCode = plan?.code?.toLowerCase() ?? "";
    const planName = plan?.name?.toLowerCase() ?? "";
    const subscriptionStatus = subscription?.status?.toLowerCase() ?? "inactive";

    if (statusFilter && subscriptionStatus !== statusFilter) {
      return false;
    }

    if (planFilter && planCode !== planFilter && planName !== planFilter) {
      return false;
    }

    if (q) {
      const haystack = [
        studio.name,
        plan?.name ?? "",
        plan?.code ?? "",
        subscription?.status ?? "",
      ]
        .join(" ")
        .toLowerCase();

      if (!haystack.includes(q)) {
        return false;
      }
    }

    return true;
  });

  const availablePlans = Array.from(
    new Set(
      studioOnlyWorkspaces
        .map((studio) => {
          const subscription = subscriptionByStudioId.get(studio.id);
          return subscription ? getPlan(subscription.subscription_plans)?.name : null;
        })
        .filter((value): value is string => Boolean(value))
    )
  ).sort((a, b) => a.localeCompare(b));

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
                Studio Directory
              </h1>
              <p className="mt-3 text-sm leading-7 text-white/85 md:text-base">
                Review real studio workspaces only. Organizer workspaces are intentionally excluded from this directory so the platform admin view stays clear.
              </p>
            </div>

            <div className="flex flex-wrap gap-3">
              <Link
                href="/platform/organizers"
                className="rounded-xl border border-white/20 bg-white/10 px-4 py-2 text-sm font-medium text-white hover:bg-white/15"
              >
                Open Organizer Directory
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
          <div className="grid gap-4 md:grid-cols-3">
            <div className="rounded-2xl border border-sky-200 bg-sky-50 p-4">
              <p className="text-sm text-sky-700">Studio Workspaces</p>
              <p className="mt-1 text-2xl font-semibold text-sky-950">
                {studioOnlyWorkspaces.length}
              </p>
            </div>

            <div className="rounded-2xl border border-violet-200 bg-violet-50 p-4">
              <p className="text-sm text-violet-700">Organizer Workspaces Excluded</p>
              <p className="mt-1 text-2xl font-semibold text-violet-950">
                {organizerWorkspaceCount}
              </p>
            </div>

            <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4">
              <p className="text-sm text-amber-700">Filtered Results</p>
              <p className="mt-1 text-2xl font-semibold text-amber-950">
                {filteredStudios.length}
              </p>
            </div>
          </div>
        </div>
      </section>

      <form className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="grid gap-4 md:grid-cols-[1fr_220px_220px_auto]">
          <div>
            <label htmlFor="q" className="mb-1 block text-sm font-medium text-slate-700">
              Search studios
            </label>
            <input
              id="q"
              name="q"
              defaultValue={query.q ?? ""}
              className="w-full rounded-xl border border-slate-300 px-3 py-2"
              placeholder="Studio name, plan, status"
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

          <div>
            <label htmlFor="plan" className="mb-1 block text-sm font-medium text-slate-700">
              Plan
            </label>
            <select
              id="plan"
              name="plan"
              defaultValue={query.plan ?? ""}
              className="w-full rounded-xl border border-slate-300 px-3 py-2"
            >
              <option value="">All</option>
              {availablePlans.map((planName) => (
                <option key={planName} value={planName.toLowerCase()}>
                  {planName}
                </option>
              ))}
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
              href="/platform/studios"
              className="rounded-xl border border-slate-300 px-4 py-2 hover:bg-slate-50"
            >
              Reset
            </Link>
          </div>
        </div>
      </form>

      <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-200 px-6 py-4">
          <h2 className="text-lg font-semibold text-slate-900">Studio Directory</h2>
          <p className="mt-1 text-sm text-slate-500">
            Showing {filteredStudios.length} of {studioOnlyWorkspaces.length} studio workspaces.
          </p>
        </div>

        {filteredStudios.length === 0 ? (
          <div className="px-6 py-12 text-center">
            <p className="text-base font-medium text-slate-900">No studios found</p>
            <p className="mt-2 text-sm text-slate-500">
              Adjust your filters and try again.
            </p>
          </div>
        ) : (
          <div className="overflow-hidden">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50">
                <tr>
                  <th className="px-4 py-3 text-left font-medium text-slate-600">Studio</th>
                  <th className="px-4 py-3 text-left font-medium text-slate-600">Plan</th>
                  <th className="px-4 py-3 text-left font-medium text-slate-600">Status</th>
                  <th className="px-4 py-3 text-left font-medium text-slate-600">Billing</th>
                  <th className="px-4 py-3 text-left font-medium text-slate-600">Organizers</th>
                  <th className="px-4 py-3 text-left font-medium text-slate-600">Events</th>
                  <th className="px-4 py-3 text-left font-medium text-slate-600">Created</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 bg-white">
                {filteredStudios.map((studio) => {
                  const subscription = subscriptionByStudioId.get(studio.id);
                  const plan = subscription ? getPlan(subscription.subscription_plans) : null;
                  const organizerStats = organizerCounts.get(studio.id) ?? {
                    total: 0,
                    active: 0,
                  };
                  const eventStats = eventCounts.get(studio.id) ?? {
                    total: 0,
                    publicPublished: 0,
                  };

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
                        <div>
                          <p>
                            {subscription?.billing_interval === "year"
                              ? "Yearly"
                              : subscription?.billing_interval === "month"
                                ? "Monthly"
                                : "—"}
                          </p>
                          <p className="mt-1 text-xs text-slate-500">
                            Ends {formatDate(subscription?.current_period_end ?? null)}
                          </p>
                        </div>
                      </td>

                      <td className="px-4 py-4 text-slate-700">
                        {organizerStats.total}
                        <span className="ml-1 text-xs text-slate-500">
                          ({organizerStats.active} active)
                        </span>
                      </td>

                      <td className="px-4 py-4 text-slate-700">
                        {eventStats.total}
                        <span className="ml-1 text-xs text-slate-500">
                          ({eventStats.publicPublished} public)
                        </span>
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