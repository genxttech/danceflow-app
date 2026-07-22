import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requirePlatformAdmin } from "@/lib/auth/platform";
import {
  createPlatformAdminAction,
  enterStudioContextAction,
  setStudioWorkspaceActiveAction,
  repairStudioPortalLinksAction,
} from "@/app/platform/actions";
import { getBillingPlan } from "@/lib/billing/plans";

type Params = Promise<{
  id: string;
}>;

type StudioRow = {
  id: string;
  name: string;
  created_at: string;
  subscription_status?: string | null;
  active: boolean | null;
  last_workspace_access_at: string | null;
  last_workspace_access_user_id: string | null;
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

type PlatformAdminActionRow = {
  id: string;
  target_type: string;
  target_id: string;
  action_type: string;
  note: string | null;
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

type ClientPortalDiagnosticRow = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  updated_at: string | null;
};

type ClientAccountLinkDiagnosticRow = {
  client_id: string;
  user_id: string | null;
  status: string;
  relationship_type: string | null;
  is_primary: boolean | null;
  invited_email: string | null;
  linked_at: string | null;
  created_at: string | null;
  updated_at: string | null;
};

type ProfileDiagnosticRow = {
  id: string;
  full_name: string | null;
  email: string | null;
  created_at: string | null;
  updated_at: string | null;
  platform_role: string | null;
};

type PortalInviteDeliveryRow = {
  id: string;
  recipient_email: string | null;
  related_id: string | null;
  status: string | null;
  error_message: string | null;
  provider_message_id: string | null;
  sent_at: string | null;
  created_at: string;
};

type AuthUserDiagnosticRow = {
  id: string;
  email?: string | null;
  email_confirmed_at?: string | null;
  last_sign_in_at?: string | null;
  created_at?: string | null;
};

function getPlan(
  value:
    | { code: string; name: string }
    | { code: string; name: string }[]
    | null
) {
  return Array.isArray(value) ? value[0] : value;
}

const PLATFORM_DISPLAY_TIME_ZONE = "America/New_York";

function formatDate(value: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: PLATFORM_DISPLAY_TIME_ZONE,
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

function formatDateTime(value: string | null) {
  if (!value) return "Never";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: PLATFORM_DISPLAY_TIME_ZONE,
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(value));
}

function formatMoney(value: number, currency = "USD") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(value);
}

function normalizeEmail(value: string | null | undefined) {
  return String(value ?? "").trim().toLowerCase();
}

function fullName(firstName: string | null, lastName: string | null) {
  const name = [firstName, lastName].filter(Boolean).join(" ").trim();
  return name || "Unnamed client";
}

function shortId(value: string | null | undefined) {
  if (!value) return "—";
  return value.length > 12 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value;
}

function deliveryBadgeClass(status: string | null | undefined) {
  if (status === "sent") return "bg-green-50 text-green-700 ring-1 ring-green-200";
  if (status === "failed") return "bg-red-50 text-red-700 ring-1 ring-red-200";
  if (status === "pending" || status === "queued") return "bg-amber-50 text-amber-700 ring-1 ring-amber-200";
  return "bg-slate-100 text-slate-700 ring-1 ring-slate-200";
}

function diagnosticBadgeClass(status: "ok" | "warning" | "danger" | "neutral") {
  if (status === "ok") return "bg-green-50 text-green-700 ring-1 ring-green-200";
  if (status === "warning") return "bg-amber-50 text-amber-700 ring-1 ring-amber-200";
  if (status === "danger") return "bg-red-50 text-red-700 ring-1 ring-red-200";
  return "bg-slate-100 text-slate-700 ring-1 ring-slate-200";
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

function adminActionLabel(value: string) {
  if (value === "reviewed") return "Reviewed";
  if (value === "follow_up") return "Follow-up";
  if (value === "suspended_access") return "Suspended access";
  if (value === "restored_access") return "Restored access";
  if (value === "resolved") return "Resolved";
  return "Note";
}

export default async function PlatformStudioDetailPage({
  params,
}: {
  params: Params;
}) {
  await requirePlatformAdmin();

  const { id } = await params;
  const supabase = await createClient();
  const adminSupabase = createAdminClient();

  const [
    { data: studio, error: studioError },
    { data: subscription, error: subscriptionError },
    { data: organizers, error: organizersError },
    { data: events, error: eventsError },
    { data: registrations, error: registrationsError },
    { data: adminActions, error: adminActionsError },
    { data: portalClients, error: portalClientsError },
    { data: portalAccountLinks, error: portalAccountLinksError },
    { data: portalInviteDeliveries, error: portalInviteDeliveriesError },
  ] = await Promise.all([
    supabase
      .from("studios")
      .select("id, name, created_at, subscription_status, active, last_workspace_access_at, last_workspace_access_user_id")
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

    supabase
      .from("platform_admin_actions")
      .select("id, target_type, target_id, action_type, note, created_at")
      .eq("target_type", "workspace")
      .eq("target_id", id)
      .order("created_at", { ascending: false })
      .limit(25),

    adminSupabase
      .from("clients")
      .select("id, first_name, last_name, email, updated_at")
      .eq("studio_id", id)
      .not("email", "is", null)
      .order("updated_at", { ascending: false })
      .limit(150),

    adminSupabase
      .from("client_account_links")
      .select(
        "client_id, user_id, status, relationship_type, is_primary, invited_email, linked_at, created_at, updated_at"
      )
      .eq("studio_id", id),

    adminSupabase
      .from("outbound_deliveries")
      .select("id, recipient_email, related_id, status, error_message, provider_message_id, sent_at, created_at")
      .eq("studio_id", id)
      .eq("template_key", "client_portal_invite")
      .eq("related_table", "clients")
      .order("created_at", { ascending: false })
      .limit(150),
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

  if (adminActionsError) {
    throw new Error(`Failed to load admin actions: ${adminActionsError.message}`);
  }

  if (portalClientsError) {
    throw new Error(`Failed to load portal diagnostic clients: ${portalClientsError.message}`);
  }

  if (portalAccountLinksError) {
    throw new Error(`Failed to load portal account links: ${portalAccountLinksError.message}`);
  }

  if (portalInviteDeliveriesError) {
    throw new Error(`Failed to load portal invite deliveries: ${portalInviteDeliveriesError.message}`);
  }

  const typedStudio = studio as StudioRow;
  const typedSubscription = (subscription ?? null) as SubscriptionRow | null;
  const typedOrganizers = (organizers ?? []) as OrganizerRow[];
  const typedEvents = (events ?? []) as EventRow[];
  const typedRegistrations = (registrations ?? []) as RegistrationRow[];
  const typedAdminActions = (adminActions ?? []) as PlatformAdminActionRow[];
  const typedPortalClients = (portalClients ?? []) as ClientPortalDiagnosticRow[];
  const typedPortalAccountLinks =
    (portalAccountLinks ?? []) as ClientAccountLinkDiagnosticRow[];
  const typedPortalInviteDeliveries = (portalInviteDeliveries ?? []) as PortalInviteDeliveryRow[];

  /*
   * A client can have several lifecycle rows. Never let an unordered stale
   * invitation row override a valid linked relationship in diagnostics.
   */
  const accountLinksByClientId = new Map<
    string,
    ClientAccountLinkDiagnosticRow[]
  >();

  for (const link of typedPortalAccountLinks) {
    const rows = accountLinksByClientId.get(link.client_id) ?? [];
    rows.push(link);
    accountLinksByClientId.set(link.client_id, rows);
  }

  function linkPriority(link: ClientAccountLinkDiagnosticRow) {
    if (
      link.status === "linked" &&
      link.relationship_type === "self" &&
      link.is_primary === true
    ) {
      return 500;
    }

    if (link.status === "linked") return 400;
    if (["invited", "claim_pending"].includes(link.status)) return 300;
    if (link.status === "conflict") return 200;
    return 100;
  }

  function linkTimestamp(link: ClientAccountLinkDiagnosticRow) {
    const value = link.updated_at ?? link.created_at ?? link.linked_at;
    const parsed = value ? new Date(value).getTime() : 0;
    return Number.isFinite(parsed) ? parsed : 0;
  }

  const accountLinkByClientId = new Map<
    string,
    ClientAccountLinkDiagnosticRow
  >();

  for (const [clientId, rows] of accountLinksByClientId) {
    const selected = [...rows].sort((left, right) => {
      const priorityDifference = linkPriority(right) - linkPriority(left);
      if (priorityDifference !== 0) return priorityDifference;
      return linkTimestamp(right) - linkTimestamp(left);
    })[0];

    if (selected) accountLinkByClientId.set(clientId, selected);
  }
  const portalClientIds = new Set(typedPortalClients.map((client) => client.id));
  const filteredPortalInviteDeliveries = typedPortalInviteDeliveries.filter((delivery) =>
    delivery.related_id ? portalClientIds.has(delivery.related_id) : false
  );

  const portalEmails = Array.from(
    new Set(typedPortalClients.map((client) => normalizeEmail(client.email)).filter(Boolean))
  );
  const portalProfileIds = Array.from(
    new Set(
      typedPortalAccountLinks
        .filter((link) => link.status === "linked")
        .map((link) => link.user_id)
        .filter((userId): userId is string => Boolean(userId)),
    ),
  );

  let portalProfiles: ProfileDiagnosticRow[] = [];
  let portalAuthUsers: AuthUserDiagnosticRow[] = [];
  let portalAuthLookupError: string | null = null;

  if (portalProfileIds.length > 0 || portalEmails.length > 0) {
    const profileRowsById = new Map<string, ProfileDiagnosticRow>();

    if (portalProfileIds.length > 0) {
      const { data: profilesById, error: profilesByIdError } = await adminSupabase
        .from("profiles")
        .select("id, full_name, email, created_at, updated_at, platform_role")
        .in("id", portalProfileIds);

      if (profilesByIdError) {
        throw new Error(`Failed to load portal diagnostic profiles: ${profilesByIdError.message}`);
      }

      for (const profile of (profilesById ?? []) as ProfileDiagnosticRow[]) {
        profileRowsById.set(profile.id, profile);
      }
    }

    if (portalEmails.length > 0) {
      const { data: profilesByEmail, error: profilesByEmailError } = await adminSupabase
        .from("profiles")
        .select("id, full_name, email, created_at, updated_at, platform_role")
        .in("email", portalEmails);

      if (profilesByEmailError) {
        throw new Error(`Failed to load portal diagnostic profiles: ${profilesByEmailError.message}`);
      }

      for (const profile of (profilesByEmail ?? []) as ProfileDiagnosticRow[]) {
        profileRowsById.set(profile.id, profile);
      }
    }

    portalProfiles = Array.from(profileRowsById.values());
  }

  try {
    const emailSet = new Set(portalEmails);
    const profileIdSet = new Set(portalProfileIds);
    const matchedUsers = new Map<string, AuthUserDiagnosticRow>();
    const perPage = 200;

    for (let page = 1; page <= 50; page += 1) {
      const { data: authUsersData, error: authUsersError } =
        await adminSupabase.auth.admin.listUsers({ page, perPage });

      if (authUsersError) {
        portalAuthLookupError = authUsersError.message;
        break;
      }

      for (const user of authUsersData.users ?? []) {
        if (
          profileIdSet.has(user.id) ||
          emailSet.has(normalizeEmail(user.email))
        ) {
          matchedUsers.set(user.id, {
            id: user.id,
            email: user.email,
            email_confirmed_at: user.email_confirmed_at ?? null,
            last_sign_in_at: user.last_sign_in_at ?? null,
            created_at: user.created_at ?? null,
          });
        }
      }

      if ((authUsersData.users ?? []).length < perPage) break;
    }

    portalAuthUsers = Array.from(matchedUsers.values());
  } catch (error) {
    portalAuthLookupError =
      error instanceof Error
        ? error.message
        : "Unable to load auth users for portal diagnostics.";
  }

  const profileById = new Map(portalProfiles.map((profile) => [profile.id, profile]));
  const profileByEmail = new Map(
    portalProfiles
      .map((profile) => [normalizeEmail(profile.email), profile] as const)
      .filter(([email]) => Boolean(email))
  );
  const authById = new Map(portalAuthUsers.map((user) => [user.id, user]));
  const authByEmail = new Map(
    portalAuthUsers
      .map((user) => [normalizeEmail(user.email), user] as const)
      .filter(([email]) => Boolean(email))
  );
  const deliveriesByClientId = new Map<string, PortalInviteDeliveryRow[]>();

  for (const delivery of filteredPortalInviteDeliveries) {
    if (!delivery.related_id) continue;
    const existing = deliveriesByClientId.get(delivery.related_id) ?? [];
    existing.push(delivery);
    deliveriesByClientId.set(delivery.related_id, existing);
  }

  const portalDiagnostics = typedPortalClients.map((client) => {
    const email = normalizeEmail(client.email);
    const accountLink = accountLinkByClientId.get(client.id) ?? null;
    const linkedUserId =
      accountLink?.status === "linked" ? accountLink.user_id : null;
    const linkedProfile = linkedUserId ? profileById.get(linkedUserId) ?? null : null;
    const matchingProfile = email ? profileByEmail.get(email) ?? null : null;
    const linkedAuthUser = linkedUserId ? authById.get(linkedUserId) ?? null : null;
    const matchingAuthUser = email ? authByEmail.get(email) ?? null : null;
    const recentDeliveries = deliveriesByClientId.get(client.id) ?? [];
    const latestDelivery = recentDeliveries[0] ?? null;

    let status: "ok" | "warning" | "danger" | "neutral" = "neutral";
    let label = "No portal activity";

    if (linkedUserId && linkedProfile && linkedAuthUser) {
      status = "ok";
      label = "Linked";
    } else if (linkedUserId) {
      status = "danger";
      label = "Broken link";
    } else if (
      accountLink &&
      ["invited", "claim_pending"].includes(accountLink.status) &&
      !matchingAuthUser &&
      !matchingProfile
    ) {
      status = "neutral";
      label = "Invitation pending";
    } else if (matchingAuthUser || matchingProfile) {
      status = "warning";
      label = "Repair available";
    } else if (latestDelivery?.status === "failed") {
      status = "danger";
      label = "Invite failed";
    } else if (latestDelivery) {
      status = "neutral";
      label = "Invite sent";
    }

    return {
      client,
      accountLink,
      linkedUserId,
      email,
      linkedProfile,
      matchingProfile,
      linkedAuthUser,
      matchingAuthUser,
      latestDelivery,
      recentDeliveries,
      status,
      label,
    };
  });

  const portalLinkedCount = portalDiagnostics.filter((item) => item.status === "ok").length;
  const portalRepairCount = portalDiagnostics.filter((item) => item.label === "Repair available").length;
  const portalBrokenCount = portalDiagnostics.filter((item) => item.status === "danger").length;
  const portalInviteFailedCount = filteredPortalInviteDeliveries.filter((delivery) => delivery.status === "failed").length;

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

            <div className="rounded-xl border border-sky-200 bg-sky-50 p-4">
              <p className="text-sm text-sky-700">Last Workspace Access</p>
              <p className="mt-1 font-medium text-sky-950">
                {formatDateTime(typedStudio.last_workspace_access_at)}
              </p>
              <p className="mt-1 text-xs text-sky-700/80">
                {typedStudio.last_workspace_access_user_id
                  ? `User ${typedStudio.last_workspace_access_user_id}`
                  : "No workspace access user recorded yet."}
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

      <section className="rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Platform Diagnostics</p>
            <h2 className="mt-2 text-xl font-semibold text-slate-950">Portal account diagnostics</h2>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
              Internal support view for portal auth/profile/client linking. These implementation details are platform-admin-only and should not be exposed to studio-facing pages.
            </p>
          </div>

          <form action={repairStudioPortalLinksAction}>
            <input type="hidden" name="studioId" value={typedStudio.id} />
            <input type="hidden" name="returnTo" value={`/platform/studios/${typedStudio.id}`} />
            <button
              type="submit"
              className="rounded-xl bg-slate-950 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
            >
              Repair matching portal links
            </button>
          </form>
        </div>

        <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-5">
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <p className="text-sm text-slate-500">Clients checked</p>
            <p className="mt-1 text-3xl font-semibold text-slate-950">{portalDiagnostics.length}</p>
          </div>
          <div className="rounded-2xl border border-green-200 bg-green-50 p-4">
            <p className="text-sm text-green-700">Linked</p>
            <p className="mt-1 text-3xl font-semibold text-green-950">{portalLinkedCount}</p>
          </div>
          <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4">
            <p className="text-sm text-amber-700">Repair available</p>
            <p className="mt-1 text-3xl font-semibold text-amber-950">{portalRepairCount}</p>
          </div>
          <div className="rounded-2xl border border-red-200 bg-red-50 p-4">
            <p className="text-sm text-red-700">Broken / failed</p>
            <p className="mt-1 text-3xl font-semibold text-red-950">{portalBrokenCount}</p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <p className="text-sm text-slate-500">Invite failures</p>
            <p className="mt-1 text-3xl font-semibold text-slate-950">{portalInviteFailedCount}</p>
          </div>
        </div>

        {portalAuthLookupError ? (
          <div className="mt-5 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
            Auth lookup warning: {portalAuthLookupError}. The profile/client link diagnostics still loaded, but auth-user visibility may be incomplete.
          </div>
        ) : null}

        {portalDiagnostics.length === 0 ? (
          <div className="mt-5 rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-4 py-10 text-sm text-slate-500">
            No clients with portal email or portal account links were found for this workspace.
          </div>
        ) : (
          <div className="mt-5 overflow-hidden rounded-2xl border border-slate-200">
            <div className="grid grid-cols-12 gap-3 bg-slate-50 px-4 py-3 text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
              <div className="col-span-3">Client</div>
              <div className="col-span-2">Status</div>
              <div className="col-span-2">Auth / Profile</div>
              <div className="col-span-2">Client Link</div>
              <div className="col-span-3">Latest Invite</div>
            </div>

            <div className="divide-y divide-slate-200">
              {portalDiagnostics.slice(0, 30).map((item) => (
                <div key={item.client.id} className="grid grid-cols-12 gap-3 px-4 py-4 text-sm">
                  <div className="col-span-3">
                    <p className="font-semibold text-slate-950">
                      {fullName(item.client.first_name, item.client.last_name)}
                    </p>
                    <p className="mt-1 text-xs text-slate-500">{item.client.email ?? "No email"}</p>
                    <p className="mt-1 font-mono text-[11px] text-slate-400">client {shortId(item.client.id)}</p>
                  </div>

                  <div className="col-span-2">
                    <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${diagnosticBadgeClass(item.status)}`}>
                      {item.label}
                    </span>
                    <p className="mt-2 text-xs leading-5 text-slate-500">
                      {item.label === "Repair available"
                        ? "Matching auth/profile data exists but the client link is missing."
                        : item.label === "Broken link"
                          ? "Client link points to a missing profile or auth user."
                          : item.label === "Invite failed"
                            ? "Most recent portal invite failed to send."
                            : item.label === "Invitation pending"
                              ? "Invite exists, but the client has not created or authenticated an account yet."
                              : item.label === "Linked"
                                ? "Client, profile, and auth user are aligned."
                                : "No confirmed portal linkage found yet."}
                    </p>
                  </div>

                  <div className="col-span-2 space-y-1 text-xs text-slate-600">
                    <p>Auth: {item.linkedAuthUser || item.matchingAuthUser ? "found" : "missing"}</p>
                    <p>Profile: {item.linkedProfile || item.matchingProfile ? "found" : "missing"}</p>
                    <p>Confirmed: {(item.linkedAuthUser ?? item.matchingAuthUser)?.email_confirmed_at ? "yes" : "no"}</p>
                    <p>Last sign-in: {formatDateTime((item.linkedAuthUser ?? item.matchingAuthUser)?.last_sign_in_at ?? null)}</p>
                  </div>

                  <div className="col-span-2 space-y-1 text-xs text-slate-600">
                    <p>account link user</p>
                    <p className="font-mono text-slate-500">{shortId(item.linkedUserId)}</p>
                    <p>auth.users</p>
                    <p className="font-mono text-slate-500">{shortId((item.linkedAuthUser ?? item.matchingAuthUser)?.id)}</p>
                    <p>profiles</p>
                    <p className="font-mono text-slate-500">{shortId((item.linkedProfile ?? item.matchingProfile)?.id)}</p>
                  </div>

                  <div className="col-span-3">
                    {item.latestDelivery ? (
                      <div className="space-y-1 text-xs text-slate-600">
                        <span className={`inline-flex rounded-full px-2.5 py-1 font-medium ${deliveryBadgeClass(item.latestDelivery.status)}`}>
                          {item.latestDelivery.status ?? "unknown"}
                        </span>
                        <p>{formatDateTime(item.latestDelivery.sent_at ?? item.latestDelivery.created_at)}</p>
                        <p>{item.latestDelivery.recipient_email ?? "No recipient"}</p>
                        {item.latestDelivery.provider_message_id ? (
                          <p className="font-mono text-slate-500">provider {shortId(item.latestDelivery.provider_message_id)}</p>
                        ) : null}
                        {item.latestDelivery.error_message ? (
                          <p className="text-red-700">{item.latestDelivery.error_message}</p>
                        ) : null}
                      </div>
                    ) : (
                      <p className="text-xs text-slate-500">No portal invite delivery record found.</p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {portalDiagnostics.length > 30 ? (
          <p className="mt-3 text-xs text-slate-500">
            Showing the 30 most recently updated portal-related clients. Use SQL diagnostics for full workspace exports.
          </p>
        ) : null}
      </section>

      <section className="grid gap-6 xl:grid-cols-[0.95fr_1.05fr]">
        <div className="rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Admin Controls</p>
          <h2 className="mt-2 text-xl font-semibold text-slate-950">Workspace review actions</h2>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            Add an internal note, mark the workspace reviewed, flag follow-up, or intentionally suspend/restore workspace access.
          </p>

          <form action={createPlatformAdminAction} className="mt-5 rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <input type="hidden" name="targetType" value="workspace" />
            <input type="hidden" name="targetId" value={typedStudio.id} />
            <input type="hidden" name="returnTo" value={`/platform/studios/${typedStudio.id}`} />
            <label className="text-sm font-semibold text-slate-800" htmlFor="workspace-admin-note">
              Internal admin note
            </label>
            <textarea
              id="workspace-admin-note"
              name="note"
              rows={3}
              placeholder="Example: Owner replied and confirmed they are still evaluating during trial. Follow up next Friday."
              className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none transition focus:border-[var(--brand-primary)] focus:ring-2 focus:ring-[var(--brand-primary-soft)]"
            />
            <div className="mt-3 flex flex-wrap gap-2">
              <button name="actionType" value="reviewed" className="rounded-xl bg-slate-950 px-3 py-2 text-xs font-semibold text-white">
                Mark Reviewed
              </button>
              <button name="actionType" value="follow_up" className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-800">
                Flag Follow-up
              </button>
              <button name="actionType" value="note" className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-800">
                Save Note
              </button>
            </div>
          </form>

          <form action={setStudioWorkspaceActiveAction} className="mt-4 rounded-2xl border border-rose-200 bg-rose-50 p-4">
            <input type="hidden" name="studioId" value={typedStudio.id} />
            <input type="hidden" name="active" value={typedStudio.active === false ? "true" : "false"} />
            <input type="hidden" name="returnTo" value={`/platform/studios/${typedStudio.id}`} />
            <label className="text-sm font-semibold text-rose-950" htmlFor="workspace-access-note">
              {typedStudio.active === false ? "Restore workspace access" : "Suspend workspace access"}
            </label>
            <p className="mt-1 text-xs leading-5 text-rose-800">
              Use this only when access should intentionally change. The action is logged in the admin history below.
            </p>
            <textarea
              id="workspace-access-note"
              name="note"
              rows={2}
              placeholder="Reason for access change"
              className="mt-2 w-full rounded-xl border border-rose-200 px-3 py-2 text-sm outline-none transition focus:border-rose-300 focus:ring-2 focus:ring-rose-100"
            />
            <button type="submit" className="mt-3 rounded-xl bg-rose-700 px-3 py-2 text-xs font-semibold text-white">
              {typedStudio.active === false ? "Restore Access" : "Suspend Access"}
            </button>
          </form>
        </div>

        <div className="rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Admin History</p>
          <h2 className="mt-2 text-xl font-semibold text-slate-950">Recent workspace notes</h2>
          {typedAdminActions.length === 0 ? (
            <div className="mt-5 rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-4 py-10 text-sm text-slate-500">
              No admin actions have been logged for this workspace yet.
            </div>
          ) : (
            <div className="mt-5 space-y-3">
              {typedAdminActions.map((action) => (
                <div key={action.id} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <p className="font-semibold text-slate-950">{adminActionLabel(action.action_type)}</p>
                    <p className="text-xs text-slate-500">{formatDateTime(action.created_at)}</p>
                  </div>
                  {action.note ? <p className="mt-2 text-sm leading-6 text-slate-700">{action.note}</p> : null}
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

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