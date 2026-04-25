import Link from "next/link";
import { redirect } from "next/navigation";
import { CalendarDays, Globe2, Sparkles, Users } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";

type OrganizerRow = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  contact_email: string | null;
  city: string | null;
  state: string | null;
  active: boolean;
  created_at: string;
};

type EventCountRow = {
  organizer_id: string | null;
  count: number;
};

type StudioBillingRow = {
  stripe_connected_account_id: string | null;
};

function activeBadgeClass(active: boolean) {
  return active
    ? "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200"
    : "bg-slate-100 text-slate-700 ring-1 ring-slate-200";
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

function canManageOrganizers(role: string | null | undefined, isPlatformAdminRole: boolean) {
  if (isPlatformAdminRole) return true;
  return role === "organizer_owner" || role === "organizer_admin";
}

function canManageBilling(role: string | null | undefined, isPlatformAdminRole: boolean) {
  if (isPlatformAdminRole) return true;
  return role === "organizer_owner";
}

function StatCard({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: string | number;
  icon: React.ComponentType<{ className?: string }>;
}) {
  return (
    <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm text-slate-500">{label}</p>
          <p className="mt-2 text-3xl font-semibold text-slate-950">{value}</p>
        </div>
        <div className="rounded-2xl bg-[var(--brand-primary-soft)] p-3 text-[var(--brand-primary)]">
          <Icon className="h-5 w-5" />
        </div>
      </div>
    </div>
  );
}

export default async function OrganizersPage() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const context = await getCurrentStudioContext();

  if (!canManageOrganizers(context.studioRole, context.isPlatformAdmin)) {
    redirect("/app");
  }

  const studioId = context.studioId;

  const [
    { data: organizers, error: organizersError },
    { data: eventCountRows, error: eventCountError },
    { data: billingStudio, error: billingStudioError },
  ] = await Promise.all([
    supabase
      .from("organizers")
      .select(`
        id,
        name,
        slug,
        description,
        contact_email,
        city,
        state,
        active,
        created_at
      `)
      .eq("studio_id", studioId)
      .order("name", { ascending: true }),

    supabase
      .from("events")
      .select("organizer_id")
      .eq("studio_id", studioId)
      .not("organizer_id", "is", null),

    supabase
      .from("studios")
      .select("stripe_connected_account_id")
      .eq("id", studioId)
      .maybeSingle<StudioBillingRow>(),
  ]);

  if (organizersError) {
    throw new Error(`Failed to load organizers: ${organizersError.message}`);
  }

  if (eventCountError) {
    throw new Error(`Failed to load organizer event counts: ${eventCountError.message}`);
  }

  if (billingStudioError) {
    throw new Error(`Failed to load billing readiness: ${billingStudioError.message}`);
  }

  const typedOrganizers = (organizers ?? []) as OrganizerRow[];
  const activeCount = typedOrganizers.filter((item) => item.active).length;
  const hasOrganizer = typedOrganizers.length > 0;
  const primaryOrganizer = typedOrganizers[0] ?? null;

  const organizerEventCounts = new Map<string, number>();
  for (const row of ((eventCountRows ?? []) as EventCountRow[])) {
    if (!row.organizer_id) continue;
    organizerEventCounts.set(
      row.organizer_id,
      (organizerEventCounts.get(row.organizer_id) ?? 0) + 1
    );
  }

  const linkedOrganizerCount = typedOrganizers.filter(
    (organizer) => (organizerEventCounts.get(organizer.id) ?? 0) > 0
  ).length;

  const totalLinkedEvents = Array.from(organizerEventCounts.values()).reduce(
    (sum, count) => sum + count,
    0
  );

  const payoutsReady = Boolean(billingStudio?.stripe_connected_account_id);
  const showBilling = canManageBilling(context.studioRole, context.isPlatformAdmin);

  return (
    <div className="space-y-8 bg-[linear-gradient(180deg,rgba(255,247,237,0.45)_0%,rgba(255,255,255,0)_22%)] p-1">
      <section className="overflow-hidden rounded-[32px] border border-[var(--brand-border)] bg-white shadow-sm">
        <div className="bg-[linear-gradient(135deg,var(--brand-primary)_0%,#4b2e83_100%)] px-6 py-8 text-white md:px-8">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-3xl">
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-white/70">
                DanceFlow Organizer Workspace
              </p>
              <h1 className="mt-3 text-3xl font-semibold tracking-tight md:text-4xl">
                Organizers
              </h1>
              <p className="mt-3 max-w-2xl text-sm leading-7 text-white/85 md:text-base">
                Manage the organizer identity that owns, publishes, and powers
                public event discovery across your event ecosystem.
              </p>
            </div>

            <div className="flex flex-wrap gap-3">
              <Link
                href="/app/events"
                className="rounded-xl border border-white/20 bg-white/10 px-4 py-2 text-sm font-medium text-white hover:bg-white/15"
              >
                Back to Events
              </Link>

              {hasOrganizer && primaryOrganizer ? (
                <Link
                  href={`/app/organizers/${primaryOrganizer.id}`}
                  className="rounded-xl bg-white px-4 py-2 text-sm font-medium text-[var(--brand-primary)] hover:bg-white/90"
                >
                  View Organizer
                </Link>
              ) : (
                <Link
                  href="/app/organizers/new"
                  className="rounded-xl bg-white px-4 py-2 text-sm font-medium text-[var(--brand-primary)] hover:bg-white/90"
                >
                  Create Organizer
                </Link>
              )}
            </div>
          </div>
        </div>

        <div className="border-t border-[var(--brand-border)] bg-[var(--brand-primary-soft)]/35 px-6 py-5 md:px-8">
          <div className="grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
            <div className="rounded-2xl border border-sky-200 bg-sky-50 p-5">
              <h2 className="text-lg font-semibold text-sky-950">
                One organizer identity per account
              </h2>
              <p className="mt-2 text-sm leading-7 text-sky-900">
                This workspace can only own one organizer profile. That keeps organizer
                accounts from being shared or sublet across multiple brands.
              </p>
            </div>

            <div className="rounded-2xl border border-orange-200 bg-orange-50 p-5">
              <h2 className="text-lg font-semibold text-orange-950">
                Link the organizer to events
              </h2>
              <p className="mt-2 text-sm leading-7 text-orange-900">
                Events without an organizer are more likely to miss discovery and
                publishing readiness requirements.
              </p>
            </div>
          </div>
        </div>
      </section>

      {!payoutsReady && showBilling ? (
        <section className="rounded-[28px] border border-amber-200 bg-amber-50 p-5 shadow-sm">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div className="max-w-2xl">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-amber-700">
                Payout setup needed
              </p>
              <p className="mt-2 text-sm leading-7 text-amber-900">
                Connect payouts before taking paid registrations so ticket money can be routed correctly to your organizer business.
              </p>
            </div>

            <Link
              href="/app/settings/billing"
              className="inline-flex items-center justify-center rounded-xl bg-amber-900 px-4 py-3 text-sm font-medium text-white hover:bg-amber-800"
            >
              Billing &amp; Payments
            </Link>
          </div>
        </section>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Total Organizers" value={typedOrganizers.length} icon={Users} />
        <StatCard label="Active Organizers" value={activeCount} icon={Sparkles} />
        <StatCard label="Linked Organizers" value={linkedOrganizerCount} icon={Globe2} />
        <StatCard label="Linked Events" value={totalLinkedEvents} icon={CalendarDays} />
      </div>

      <section className="overflow-hidden rounded-[32px] border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-200 px-6 py-4">
          <h2 className="text-lg font-semibold text-slate-900">Organizer Profile</h2>
          <p className="mt-1 text-sm text-slate-500">
            Manage the organizer identity used across public event pages and discovery.
          </p>
        </div>

        {!hasOrganizer ? (
          <div className="px-6 py-12 text-center">
            <p className="text-base font-medium text-slate-900">No organizer yet</p>
            <p className="mt-2 text-sm text-slate-500">
              Create your organizer profile before publishing events publicly.
            </p>

            <div className="mt-6">
              <Link
                href="/app/organizers/new"
                className="rounded-xl bg-[var(--brand-primary)] px-4 py-2 text-white hover:opacity-95"
              >
                Create Organizer
              </Link>
            </div>
          </div>
        ) : (
          <div className="divide-y divide-slate-200">
            {typedOrganizers.map((organizer) => {
              const linkedEventCount = organizerEventCounts.get(organizer.id) ?? 0;

              return (
                <div key={organizer.id} className="px-6 py-5">
                  <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-lg font-semibold text-slate-900">
                          {organizer.name}
                        </h3>

                        <span
                          className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${activeBadgeClass(
                            organizer.active
                          )}`}
                        >
                          {organizer.active ? "Active" : "Inactive"}
                        </span>

                        {linkedEventCount > 0 ? (
                          <span className="inline-flex rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700 ring-1 ring-emerald-200">
                            {linkedEventCount} linked event{linkedEventCount === 1 ? "" : "s"}
                          </span>
                        ) : (
                          <span className="inline-flex rounded-full bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-700 ring-1 ring-amber-200">
                            No linked events
                          </span>
                        )}
                      </div>

                      <p className="mt-2 text-sm text-slate-500">
                        /organizers/{organizer.slug}
                      </p>

                      {organizer.description ? (
                        <p className="mt-2 max-w-2xl text-sm leading-7 text-slate-600">
                          {organizer.description}
                        </p>
                      ) : null}

                      <div className="mt-3 flex flex-wrap gap-4 text-sm text-slate-500">
                        <span>
                          {organizer.city || organizer.state
                            ? [organizer.city, organizer.state].filter(Boolean).join(", ")
                            : "No location"}
                        </span>
                        <span>{organizer.contact_email || "No contact email"}</span>
                      </div>
                    </div>

                    <div className="flex shrink-0 flex-col items-start gap-3 lg:items-end">
                      <div className="text-left lg:text-right">
                        <p className="text-sm text-slate-500">Created</p>
                        <p className="mt-1 font-medium text-slate-900">
                          {formatDateTime(organizer.created_at)}
                        </p>
                      </div>

                      <Link
                        href={`/app/organizers/${organizer.id}`}
                        className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
                      >
                        View Organizer
                      </Link>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}