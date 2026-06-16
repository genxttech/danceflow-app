import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import EventForm from "../EventForm";
import { planHasBasicEventListings, planHasOrganizerSuite } from "@/lib/billing/plans";

type OrganizerOption = {
  id: string;
  name: string;
  active: boolean;
};

type WorkspaceRow = {
  id: string;
  name: string | null;
  public_name: string | null;
  billing_plan: string | null;
  subscription_status: string | null;
};

type SubscriptionRow = {
  status: string | null;
  subscription_plan_id: string | null;
};

type SubscriptionPlanRow = {
  code: string | null;
};

function isOrganizerWorkspaceRole(role: string | null | undefined) {
  return role === "organizer_owner" || role === "organizer_admin";
}

function canManageEvents(role: string | null | undefined, isPlatformAdminRole: boolean) {
  if (isPlatformAdminRole) return true;

  return (
    role === "studio_owner" ||
    role === "studio_admin" ||
    role === "organizer_owner" ||
    role === "organizer_admin"
  );
}

function canManageOrganizers(role: string | null | undefined, isPlatformAdminRole: boolean) {
  if (isPlatformAdminRole) return true;
  return role === "organizer_owner" || role === "organizer_admin";
}

function isActiveOrTrialing(status: string | null | undefined) {
  const normalized = (status ?? "").trim().toLowerCase();
  return normalized === "active" || normalized === "trialing";
}

function getEffectiveBillingPlan(
  workspace: WorkspaceRow | null | undefined,
  subscriptionPlan: SubscriptionPlanRow | null | undefined
) {
  return (
    subscriptionPlan?.code?.trim().toLowerCase() ||
    workspace?.billing_plan?.trim().toLowerCase() ||
    ""
  );
}

function getEffectiveSubscriptionStatus(
  workspace: WorkspaceRow | null | undefined,
  subscription: SubscriptionRow | null | undefined
) {
  return (
    subscription?.status?.trim().toLowerCase() ||
    workspace?.subscription_status?.trim().toLowerCase() ||
    ""
  );
}

function canUseStudioHostedEvents(params: {
  workspace: WorkspaceRow | null | undefined;
  subscription: SubscriptionRow | null | undefined;
  subscriptionPlan: SubscriptionPlanRow | null | undefined;
}) {
  const planCode = getEffectiveBillingPlan(params.workspace, params.subscriptionPlan);
  const status = getEffectiveSubscriptionStatus(params.workspace, params.subscription);

  return isActiveOrTrialing(status) && planHasBasicEventListings(planCode);
}

function canUseOrganizerSuite(params: {
  workspace: WorkspaceRow | null | undefined;
  subscription: SubscriptionRow | null | undefined;
  subscriptionPlan: SubscriptionPlanRow | null | undefined;
  organizerWorkspace: boolean;
  isPlatformAdminRole: boolean;
}) {
  if (params.isPlatformAdminRole || params.organizerWorkspace) return true;

  const planCode = getEffectiveBillingPlan(params.workspace, params.subscriptionPlan);
  const status = getEffectiveSubscriptionStatus(params.workspace, params.subscription);

  return isActiveOrTrialing(status) && planHasOrganizerSuite(planCode);
}

export default async function NewEventPage() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const context = await getCurrentStudioContext();
  const studioId = context.studioId;

  if (!canManageEvents(context.studioRole, context.isPlatformAdmin)) {
    redirect("/app/events");
  }

  const [
    { data: workspace, error: workspaceError },
    { data: organizers, error: organizersError },
    { data: subscriptionRows, error: subscriptionsError },
  ] = await Promise.all([
    supabase
      .from("studios")
      .select("id, name, public_name, billing_plan, subscription_status")
      .eq("id", studioId)
      .maybeSingle<WorkspaceRow>(),

    supabase
      .from("organizers")
      .select("id, name, active")
      .eq("studio_id", studioId)
      .eq("active", true)
      .order("name", { ascending: true }),

    supabase
      .from("studio_subscriptions")
      .select("status, subscription_plan_id")
      .eq("studio_id", studioId)
      .order("created_at", { ascending: false })
      .limit(1),
  ]);

  if (workspaceError) {
    throw new Error(`Failed to load workspace: ${workspaceError.message}`);
  }

  if (organizersError) {
    throw new Error(`Failed to load organizers: ${organizersError.message}`);
  }

  if (subscriptionsError) {
    throw new Error(`Failed to load subscription: ${subscriptionsError.message}`);
  }

  const latestSubscription = ((subscriptionRows ?? []) as SubscriptionRow[])[0] ?? null;
  let subscriptionPlan: SubscriptionPlanRow | null = null;

  if (latestSubscription?.subscription_plan_id) {
    const { data: plan, error: planError } = await supabase
      .from("subscription_plans")
      .select("code")
      .eq("id", latestSubscription.subscription_plan_id)
      .maybeSingle<SubscriptionPlanRow>();

    if (planError) {
      throw new Error(`Failed to load subscription plan: ${planError.message}`);
    }

    subscriptionPlan = plan;
  }

  const organizerWorkspace = isOrganizerWorkspaceRole(context.studioRole);
  const studioHostedEvents =
    !organizerWorkspace &&
    canUseStudioHostedEvents({
      workspace,
      subscription: latestSubscription,
      subscriptionPlan,
    });
  const eventCommerceEnabled = canUseOrganizerSuite({
    workspace,
    subscription: latestSubscription,
    subscriptionPlan,
    organizerWorkspace,
    isPlatformAdminRole: context.isPlatformAdmin,
  });
  const canCreateOrganizer = canManageOrganizers(
    context.studioRole,
    context.isPlatformAdmin
  );

  const typedOrganizers = (organizers ?? []) as OrganizerOption[];
  const singleOrganizer = typedOrganizers[0] ?? null;

  return (
    <div className="space-y-8 bg-[linear-gradient(180deg,rgba(255,247,237,0.45)_0%,rgba(255,255,255,0)_22%)] p-1">
      <section className="overflow-hidden rounded-[32px] border border-[var(--brand-border)] bg-white shadow-sm">
        <div className="bg-[linear-gradient(135deg,var(--brand-primary)_0%,#4b2e83_100%)] px-6 py-8 text-white md:px-8">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-3xl">
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-white/70">
                {organizerWorkspace ? "DanceFlow Organizer Workspace" : "DanceFlow Events"}
              </p>
              <h1 className="mt-3 text-3xl font-semibold tracking-tight md:text-4xl">
                New Event
              </h1>
              <p className="mt-3 max-w-2xl text-sm leading-7 text-white/85 md:text-base">
                {organizerWorkspace
                  ? "Create an organizer-linked event for public discovery, registrations, and event operations."
                  : studioHostedEvents
                    ? "Create a basic public event listing. Your studio name will be used as the event host; ticketing, QR check-in, and settlement require Organizer Suite."
                    : "Create an organizer-linked event and optionally publish it into the public dance directory."}
              </p>
            </div>

            <div className="flex flex-wrap gap-3">
              <Link
                href="/app/events"
                className="rounded-xl border border-white/20 bg-white/10 px-4 py-2 text-sm font-medium text-white hover:bg-white/15"
              >
                Back to Events
              </Link>
            </div>
          </div>
        </div>

        {organizerWorkspace ? (
          <div className="border-t border-[var(--brand-border)] bg-[var(--brand-primary-soft)]/35 px-6 py-5 md:px-8">
            <div className="rounded-2xl border border-sky-200 bg-sky-50 p-5">
              <h2 className="text-lg font-semibold text-sky-950">
                One organizer profile is expected for this workspace
              </h2>
              <p className="mt-2 text-sm leading-7 text-sky-900">
                Organizer accounts should create events under their single organizer
                profile so public listings and registrations stay tied to the correct brand.
              </p>
            </div>
          </div>
        ) : studioHostedEvents ? (
          <div className="border-t border-[var(--brand-border)] bg-[var(--brand-primary-soft)]/35 px-6 py-5 md:px-8">
            <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-5">
              <h2 className="text-lg font-semibold text-emerald-950">
                This will be a studio-hosted event
              </h2>
              <p className="mt-2 text-sm leading-7 text-emerald-900">
Active studio plans can publish basic public event listings without creating a separate organizer.
                Your studio name will be used as the public event host. Ticketing, QR check-in, settlements, and organizer ARIA require Organizer Suite.
              </p>
            </div>
          </div>
        ) : null}
      </section>

      {typedOrganizers.length === 0 && !studioHostedEvents ? (
        <div className="rounded-[32px] border border-slate-200 bg-white p-8 text-center shadow-sm">
          <p className="text-base font-medium text-slate-900">
            Create an organizer first
          </p>
          <p className="mt-2 text-sm text-slate-500">
            Public events in the dance directory must belong to an organizer.
          </p>

          {canCreateOrganizer ? (
            <div className="mt-6">
              <Link
                href="/app/organizers/new"
                className="rounded-xl bg-slate-900 px-4 py-2 text-white hover:bg-slate-800"
              >
                Create Organizer
              </Link>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="space-y-6">
          {organizerWorkspace && singleOrganizer ? (
            <div className="rounded-[28px] border border-emerald-200 bg-emerald-50 p-5 shadow-sm">
              <p className="text-sm font-semibold uppercase tracking-[0.16em] text-emerald-700">
                Organizer Assignment
              </p>
              <h2 className="mt-2 text-xl font-semibold text-emerald-950">
                This event will be created under {singleOrganizer.name}
              </h2>
              <p className="mt-2 text-sm leading-7 text-emerald-900">
                The form should use this organizer by default for this organizer workspace.
              </p>
            </div>
          ) : null}

          <EventForm
              mode="create"
              organizers={typedOrganizers}
              organizerWorkspace={organizerWorkspace}
              eventCommerceEnabled={eventCommerceEnabled}
              initialValues={{
                organizerId:
                  organizerWorkspace && singleOrganizer ? singleOrganizer.id : undefined,
                visibility: "public",
                publicDirectoryEnabled: false,
                beginnerFriendly: false,
                waitlistEnabled: false,
              }}
            />
        </div>
      )}
    </div>
  );
}