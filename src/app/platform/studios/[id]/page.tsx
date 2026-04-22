import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requirePlatformAdmin } from "@/lib/auth/platform";
import { enterStudioContextAction } from "@/app/platform/actions";
import { getBillingPlan } from "@/lib/billing/plans";

type Params = Promise<{
  id: string;
}>;

type StudioRow = {
  id: string;
  name: string;
  created_at: string;
  subscription_status?: string | null;
};

type SubscriptionRow = {
  id: string;
  studio_id: string;
  status: string;
  billing_interval: string | null;
  current_period_start: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean | null;
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
  start_date: string | null;
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

function eventTypeLabel(value: string) {
  if (value === "group_class") return "Group Class";
  if (value === "practice_party") return "Practice Party";
  if (value === "workshop") return "Workshop";
  if (value === "social_dance") return "Social Dance";
  if (value === "competition") return "Competition";
  if (value === "showcase") return "Showcase";
  if (value === "festival") return "Festival";
  if (value === "special_event") return "Special Event";
  return value.replaceAll("_", " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function isOrganizerWorkspace(params: {
  studioName: string;
  subscription: SubscriptionRow | null;
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
    supabase
      .from("studios")
      .select("id, name, created_at, subscription_status")
      .eq("id", id)
      .maybeSingle(),

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

  if (studioError) {
    throw new Error(`Failed to load workspace: ${studioError.message}`);
  }

  if (!studio) {
    notFound();
  }

  if (subscriptionError) {
    throw new Error(`Failed to load subscription: ${subscriptionError.message}`);
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

  const typedStudio = studio as StudioRow;
  const typedSubscription = (subscription ?? null) as SubscriptionRow | null;
  const typedOrganizers = (organizers ?? []) as OrganizerRow[];
  const typedEvents = (events ?? []) as EventRow[];
  const typedRegistrations = (registrations ?? []) as RegistrationRow[];

  const workspaceType = isOrganizerWorkspace({
    studioName: typedStudio.name,
    subscription: typedSubscription,
  })
    ? "organizer"
    : "studio";

  const workspaceTypeLabel =
    workspaceType === "organizer" ? "Organizer Workspace" : "Studio Workspace";

  const plan = typedSubscription ? getPlan(typedSubscription.subscription_plans) : null;
  const organizerById = new Map(typedOrganizers.map((organizer) => [organizer.id, organizer]));
  const studioEventIds = new Set(typedEvents.map((event) => event.id));

  const workspaceRegistrations = typedRegistrations.filter((registration) =>
    studioEventIds.has(registration.event_id)
  );

  const activeOrganizers = typedOrganizers.filter((organizer) => organizer.active).length;
  const publicEvents = typedEvents.filter(
    (event) => event.status === "published" && event.visibility === "public"
  ).length;
  const paidRegistrations = workspaceRegistrations.filter(
    (registration) => registration.payment_status === "paid"
  ).length;

  const grossRevenue = workspaceRegistrations.reduce((sum, registration) => {
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
    <div className="space-y-8 bg-[linear-gradient(180deg,rgba(255,247,237,0.42)_0%,rgba(255,255,255,0)_20%)] p-1">
      <section className="overflow-hidden rounded-[32px] border border-[var(--brand-border)] bg-white shadow-sm">
        <div className="bg-[linear-gradient(135deg,var(--brand-primary)_0%,#4b2e83_100%)] px-6 py-8 text-white md:px-8">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-3xl">
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-white/70">
                DanceFlow Platform {workspaceTypeLabel}
              </p>
              <h1 className="mt-3 text-3xl font-semibold tracking-tight md:text-4xl">
                {typedStudio.name}
              </h1>
              <p className="mt-3 text-sm leading-7 text-white/85 md:text-base">
                {workspaceType === "organizer"
                  ? "Review organizer billing health, event activity, registration volume, and public event presence from one admin view."
                  : "Review studio billing health, organizer access, event activity, and overall workspace usage from one admin view."}
              </p>
              <p className="mt-2 text-xs text-white/70">{typedStudio.id}</p>
            </div>

            <div className="flex flex-wrap gap-3">
              <Link
                href={workspaceType === "organizer" ? "/platform/organizers" : "/platform/studios"}
                className="rounded-xl border border-white/20 bg-white/10 px-4 py-2 text-sm font-medium text-white hover:bg-white/15"
              >
                Back to {workspaceType === "organizer" ? "Organizers" : "Studios"}
              </Link>

              <form action={enterStudioContextAction}>
                <input type="hidden" name="studioId" value={typedStudio.id} />
                <button
                  type="submit"
                  className="rounded-xl bg-white px-4 py-2 text-sm font-medium text-[var(--brand-primary)] hover:bg-white/90"
                >
                  Open Workspace
                </button>
              </form>
            </div>
          </div>
        </div>

        <div className="border-t border-[var(--brand-border)] bg-[var(--brand-primary-soft)]/35 px-6 py-5 md:px-8">
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <div
              className={`rounded-2xl p-4 ${
                workspaceType === "organizer"
                  ? "border border-violet-200 bg-violet-50"
                  : "border border-sky-200 bg-sky-50"
              }`}
            >
              <p
                className={`text-sm ${
                  workspaceType === "organizer" ? "text-violet-700" : "text-sky-700"
                }`}
              >
                Workspace Type
              </p>
              <p
                className={`mt-1 text-2xl font-semibold ${
                  workspaceType === "organizer" ? "text-violet-950" : "text-sky-950"
                }`}
              >
                {workspaceTypeLabel}
              </p>
            </div>

            <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
              <p className="text-sm text-emerald-700">Plan</p>
              <p className="mt-1 text-2xl font-semibold text-emerald-950">
                {plan?.name ?? "No plan"}
              </p>
            </div>

            <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4">
              <p className="text-sm text-amber-700">Subscription</p>
              <p className="mt-1">
                <span
                  className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${statusBadgeClass(
                    typedSubscription?.status ?? typedStudio.subscription_status ?? "inactive"
                  )}`}
                >
                  {statusLabel(
                    typedSubscription?.status ?? typedStudio.subscription_status ?? "inactive"
                  )}
                </span>
              </p>
            </div>

            <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4">
              <p className="text-sm text-rose-700">
                {workspaceType === "organizer"
                  ? "Gross Registration Revenue"
                  : "Workspace Revenue"}
              </p>
              <p className="mt-1 text-2xl font-semibold text-rose-950">
                {formatMoney(grossRevenue, "USD")}
              </p>
            </div>
          </div>
        </div>
      </section>

      <div className="grid gap-4 md:grid-cols-3 xl:grid-cols-6">
        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-sm text-slate-500">Plan</p>
          <p className="mt-2 text-2xl font-semibold text-slate-950">
            {plan?.name ?? "No plan"}
          </p>
        </div>

        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-sm text-slate-500">Subscription</p>
          <p className="mt-2">
            <span
              className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${statusBadgeClass(
                typedSubscription?.status ?? typedStudio.subscription_status ?? "inactive"
              )}`}
            >
              {statusLabel(
                typedSubscription?.status ?? typedStudio.subscription_status ?? "inactive"
              )}
            </span>
          </p>
        </div>

        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-sm text-slate-500">Billing Interval</p>
          <p className="mt-2 text-2xl font-semibold text-slate-950">
            {typedSubscription?.billing_interval === "year"
              ? "Yearly"
              : typedSubscription?.billing_interval === "month"
                ? "Monthly"
                : "—"}
          </p>
        </div>

        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-sm text-slate-500">
            {workspaceType === "organizer" ? "Organizer Accounts" : "Organizers"}
          </p>
          <p className="mt-2 text-3xl font-semibold text-slate-950">
            {typedOrganizers.length}
          </p>
          <p className="mt-1 text-sm text-slate-500">{activeOrganizers} active</p>
        </div>

        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-sm text-slate-500">Events</p>
          <p className="mt-2 text-3xl font-semibold text-slate-950">{typedEvents.length}</p>
          <p className="mt-1 text-sm text-slate-500">{publicEvents} public</p>
        </div>

        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-sm text-slate-500">Registrations</p>
          <p className="mt-2 text-3xl font-semibold text-slate-950">
            {workspaceRegistrations.length}
          </p>
          <p className="mt-1 text-sm text-slate-500">{paidRegistrations} paid</p>
        </div>
      </div>

      <div className="grid gap-6 xl:grid-cols-[1.05fr_0.95fr]">
        <div className="rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h2 className="text-xl font-semibold text-slate-900">Billing Overview</h2>
              <p className="mt-1 text-sm text-slate-500">
                See the current subscription state and billing timing for this workspace.
              </p>
            </div>

            <Link href="/platform/billing" className="text-sm font-medium underline">
              Open billing
            </Link>
          </div>

          <div className="mt-5 grid gap-4 md:grid-cols-2">
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
              <p className="text-sm text-slate-500">Current Period Start</p>
              <p className="mt-1 font-medium text-slate-900">
                {formatDate(typedSubscription?.current_period_start ?? null)}
              </p>
            </div>

            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
              <p className="text-sm text-slate-500">Current Period End</p>
              <p className="mt-1 font-medium text-slate-900">
                {formatDate(typedSubscription?.current_period_end ?? null)}
              </p>
            </div>

            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
              <p className="text-sm text-slate-500">Trial Ends</p>
              <p className="mt-1 font-medium text-slate-900">
                {formatDate(typedSubscription?.trial_ends_at ?? null)}
              </p>
            </div>

            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
              <p className="text-sm text-slate-500">Cancel at Period End</p>
              <p className="mt-1 font-medium text-slate-900">
                {typedSubscription?.cancel_at_period_end ? "Yes" : "No"}
              </p>
            </div>
          </div>
        </div>

        <div className="rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-xl font-semibold text-slate-900">Workspace Summary</h2>
          <div className="mt-5 space-y-4">
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
              <p className="text-sm text-slate-500">Created</p>
              <p className="mt-1 font-medium text-slate-900">
                {formatDate(typedStudio.created_at)}
              </p>
            </div>

            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
              <p className="text-sm text-slate-500">
                {workspaceType === "organizer" ? "Public Event Presence" : "Organizer Access"}
              </p>
              <p className="mt-1 font-medium text-slate-900">
                {workspaceType === "organizer"
                  ? `${publicEvents} published public events`
                  : `${activeOrganizers} active organizer accounts`}
              </p>
            </div>

            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
              <p className="text-sm text-slate-500">
                {workspaceType === "organizer" ? "Registration Volume" : "Workspace Usage"}
              </p>
              <p className="mt-1 font-medium text-slate-900">
                {workspaceType === "organizer"
                  ? `${workspaceRegistrations.length} registrations across ${typedEvents.length} events`
                  : `${typedEvents.length} events with ${workspaceRegistrations.length} registrations`}
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className="grid gap-6 xl:grid-cols-[1.1fr_0.9fr]">
        <div className="rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h2 className="text-xl font-semibold text-slate-900">Recent Events</h2>
              <p className="mt-1 text-sm text-slate-500">
                {workspaceType === "organizer"
                  ? "Recent event activity for this organizer workspace."
                  : "Recent event activity connected to this studio workspace."}
              </p>
            </div>
          </div>

          {recentEvents.length === 0 ? (
            <div className="mt-5 rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-10 text-sm text-slate-500">
              No events found for this workspace.
            </div>
          ) : (
            <div className="mt-5 space-y-3">
              {recentEvents.map((event) => {
                const organizer = event.organizer_id
                  ? organizerById.get(event.organizer_id)
                  : null;

                return (
                  <div key={event.id} className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <p className="font-medium text-slate-900">{event.name}</p>
                        <p className="mt-1 text-sm text-slate-500">
                          {eventTypeLabel(event.event_type)} • {event.visibility} •{" "}
                          {formatDate(event.start_date ?? event.created_at)}
                        </p>
                        {organizer ? (
                          <p className="mt-1 text-sm text-slate-500">
                            Organizer: {organizer.name}
                          </p>
                        ) : null}
                      </div>

                      <span
                        className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${statusBadgeClass(
                          event.status
                        )}`}
                      >
                        {statusLabel(event.status)}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h2 className="text-xl font-semibold text-slate-900">
                {workspaceType === "organizer" ? "Organizer Accounts" : "Linked Organizers"}
              </h2>
              <p className="mt-1 text-sm text-slate-500">
                {workspaceType === "organizer"
                  ? "Organizer records attached to this organizer workspace."
                  : "Organizer records associated with this studio workspace."}
              </p>
            </div>

            <Link href="/platform/organizers" className="text-sm font-medium underline">
              Open organizers
            </Link>
          </div>

          {recentOrganizers.length === 0 ? (
            <div className="mt-5 rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-10 text-sm text-slate-500">
              No organizers found for this workspace.
            </div>
          ) : (
            <div className="mt-5 space-y-3">
              {recentOrganizers.map((organizer) => (
                <div
                  key={organizer.id}
                  className="rounded-xl border border-slate-200 bg-slate-50 p-4"
                >
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="font-medium text-slate-900">{organizer.name}</p>
                      <p className="mt-1 text-sm text-slate-500">
                        /{organizer.slug} • Created {formatDate(organizer.created_at)}
                      </p>
                    </div>

                    <span
                      className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${
                        organizer.active
                          ? "bg-green-50 text-green-700 ring-1 ring-green-200"
                          : "bg-slate-100 text-slate-700 ring-1 ring-slate-200"
                      }`}
                    >
                      {organizer.active ? "Active" : "Inactive"}
                    </span>
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