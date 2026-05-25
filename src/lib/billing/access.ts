import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import {
  organizerPlanHasFeature,
  planHasFeature,
  requiredOrganizerPlanForFeature,
  requiredPlanForFeature,
  type BillingFeature,
} from "./plans";
import type { AppRole } from "@/lib/auth/permissions";

type StudioSubscriptionAccessRow = {
  status: string;
  subscription_plans:
    | { code: string; name: string }
    | { code: string; name: string }[]
    | null;
};

type StudioBillingAccessRow = {
  billing_plan: string | null;
  subscription_status: string | null;
  billing_override_enabled: boolean | null;
  billing_override_reason: string | null;
  billing_override_expires_at: string | null;
};

export type WorkspacePlanCode =
  | "starter"
  | "growth"
  | "pro"
  | "organizer"
  | null;

export type WorkspaceCapabilities = {
  studioId: string | null;
  status: string | null;
  planCode: WorkspacePlanCode;
  planName: string | null;
  isActive: boolean;
  canUseStudioAdmin: boolean;
  maxStudioAdmins: number;
  canUseFrontDesk: boolean;
  canUseIndependentInstructor: boolean;
  canUseOrganizerAdmin: boolean;
  maxOrganizerAdmins: number;
  hasPublicEventModule: boolean;
  canManageMemberships: boolean;
  canManagePackages: boolean;
  canUseAdvancedReports: boolean;
};

function getPlan(
  value:
    | { code: string; name: string }
    | { code: string; name: string }[]
    | null
) {
  return Array.isArray(value) ? value[0] : value;
}

function buildBillingUpgradeUrl(feature: BillingFeature) {
  const search = new URLSearchParams({
    reason: "feature_required",
    feature,
    requiredPlan: requiredPlanForFeature(feature),
  });

  return `/app/settings/billing?${search.toString()}`;
}


function buildOrganizerBillingUpgradeUrl(feature: BillingFeature) {
  const search = new URLSearchParams({
    reason: "feature_required",
    feature,
    requiredPlan: requiredOrganizerPlanForFeature(feature),
    account: "organizer",
  });

  return `/app/settings/billing?${search.toString()}`;
}

function isActiveBillingStatus(value: string | null | undefined) {
  return value === "active" || value === "trialing";
}

function isOrganizerRole(value: string | null | undefined) {
  return ["organizer_owner", "organizer_admin", "organizer_staff"].includes(
    value ?? "",
  );
}

type EventFeatureAccessRow = {
  id: string;
  studio_id: string | null;
  organizer_id: string | null;
};

type OrganizerBillingAccessRow = {
  id: string;
  billing_plan: string | null;
  subscription_status: string | null;
};

export type EventWorkspaceAccess = {
  eventId: string;
  studioId: string | null;
  organizerId: string | null;
  studioRole: string | null;
  organizerRole: string | null;
  isPlatformAdmin: boolean;
  accountType: "studio" | "organizer" | "platform";
};

export async function organizerHasFeatureForEvent(args: {
  eventId: string;
  feature: BillingFeature;
  allowedOrganizerRoles?: string[];
}) {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return false;

  const { data: event } = await supabase
    .from("events")
    .select("id, studio_id, organizer_id")
    .eq("id", args.eventId)
    .maybeSingle<EventFeatureAccessRow>();

  if (!event?.organizer_id) return false;

  const allowedRoles = args.allowedOrganizerRoles ?? [
    "organizer_owner",
    "organizer_admin",
    "organizer_staff",
  ];

  const { data: organizerUser } = await supabase
    .from("organizer_users")
    .select("role")
    .eq("organizer_id", event.organizer_id)
    .eq("user_id", user.id)
    .eq("active", true)
    .maybeSingle<{ role: string }>();

  if (!organizerUser?.role || !allowedRoles.includes(organizerUser.role)) {
    return false;
  }

  const { data: organizer } = await supabase
    .from("organizers")
    .select("id, billing_plan, subscription_status")
    .eq("id", event.organizer_id)
    .maybeSingle<OrganizerBillingAccessRow>();

  if (!organizer || !isActiveBillingStatus(organizer.subscription_status)) {
    return false;
  }

  return organizerPlanHasFeature(organizer.billing_plan, args.feature);
}

export async function requireEventWorkspaceFeature(args: {
  eventId: string;
  feature: BillingFeature;
  allowedOrganizerRoles?: string[];
}): Promise<EventWorkspaceAccess> {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const context = await getCurrentStudioContext();

  const { data: event, error: eventError } = await supabase
    .from("events")
    .select("id, studio_id, organizer_id")
    .eq("id", args.eventId)
    .maybeSingle<EventFeatureAccessRow>();

  if (eventError || !event) {
    redirect("/app/events");
  }

  if (context?.isPlatformAdmin) {
    return {
      eventId: event.id,
      studioId: event.studio_id,
      organizerId: event.organizer_id,
      studioRole: "platform_admin",
      organizerRole: null,
      isPlatformAdmin: true,
      accountType: "platform",
    };
  }

  const allowedOrganizerRoles = args.allowedOrganizerRoles ?? [
    "organizer_owner",
    "organizer_admin",
    "organizer_staff",
  ];

  if (event.organizer_id) {
    const { data: organizerUser } = await supabase
      .from("organizer_users")
      .select("role")
      .eq("organizer_id", event.organizer_id)
      .eq("user_id", user.id)
      .eq("active", true)
      .maybeSingle<{ role: string }>();

    const organizerRole = organizerUser?.role ?? null;

    if (organizerRole && allowedOrganizerRoles.includes(organizerRole)) {
      const { data: organizer } = await supabase
        .from("organizers")
        .select("id, billing_plan, subscription_status")
        .eq("id", event.organizer_id)
        .maybeSingle<OrganizerBillingAccessRow>();

      if (
        organizer &&
        isActiveBillingStatus(organizer.subscription_status) &&
        organizerPlanHasFeature(organizer.billing_plan, args.feature)
      ) {
        return {
          eventId: event.id,
          studioId: event.studio_id,
          organizerId: event.organizer_id,
          studioRole: context?.studioRole ?? null,
          organizerRole,
          isPlatformAdmin: false,
          accountType: "organizer",
        };
      }

      redirect(buildOrganizerBillingUpgradeUrl(args.feature));
    }
  }

  if (event.studio_id && context?.studioId === event.studio_id) {
    const allowed = await studioHasFeature(args.feature);

    if (!allowed) {
      redirect(buildBillingUpgradeUrl(args.feature));
    }

    return {
      eventId: event.id,
      studioId: event.studio_id,
      organizerId: event.organizer_id,
      studioRole: context.studioRole ?? null,
      organizerRole: isOrganizerRole(context.studioRole) ? context.studioRole : null,
      isPlatformAdmin: false,
      accountType: "studio",
    };
  }

  redirect("/app/events");
}

function normalizePlanCode(value: string | null | undefined): WorkspacePlanCode {
  const normalized = (value ?? "").trim().toLowerCase();

  if (
    normalized === "starter" ||
    normalized === "growth" ||
    normalized === "pro" ||
    normalized === "organizer"
  ) {
    return normalized;
  }

  return null;
}

function buildCapabilities(planCode: WorkspacePlanCode, status: string | null): WorkspaceCapabilities {
  const active = status === "active" || status === "trialing";

  if (!active) {
    return {
      studioId: null,
      status,
      planCode,
      planName: null,
      isActive: false,
      canUseStudioAdmin: false,
      maxStudioAdmins: 0,
      canUseFrontDesk: false,
      canUseIndependentInstructor: false,
      canUseOrganizerAdmin: false,
      maxOrganizerAdmins: 0,
      hasPublicEventModule: false,
      canManageMemberships: false,
      canManagePackages: false,
      canUseAdvancedReports: false,
    };
  }

  switch (planCode) {
    case "starter":
      return {
        studioId: null,
        status,
        planCode,
        planName: "Starter",
        isActive: true,
        canUseStudioAdmin: false,
        maxStudioAdmins: 0,
        canUseFrontDesk: false,
        canUseIndependentInstructor: true,
        canUseOrganizerAdmin: false,
        maxOrganizerAdmins: 0,
        hasPublicEventModule: false,
        canManageMemberships: false,
        canManagePackages: false,
        canUseAdvancedReports: false,
      };

    case "growth":
      return {
        studioId: null,
        status,
        planCode,
        planName: "Growth",
        isActive: true,
        canUseStudioAdmin: true,
        maxStudioAdmins: 1,
        canUseFrontDesk: true,
        canUseIndependentInstructor: true,
        canUseOrganizerAdmin: false,
        maxOrganizerAdmins: 0,
        hasPublicEventModule: false,
        canManageMemberships: true,
        canManagePackages: true,
        canUseAdvancedReports: true,
      };

    case "pro":
      return {
        studioId: null,
        status,
        planCode,
        planName: "Pro",
        isActive: true,
        canUseStudioAdmin: true,
        maxStudioAdmins: 999,
        canUseFrontDesk: true,
        canUseIndependentInstructor: true,
        canUseOrganizerAdmin: false,
        maxOrganizerAdmins: 0,
        hasPublicEventModule: true,
        canManageMemberships: true,
        canManagePackages: true,
        canUseAdvancedReports: true,
      };

    case "organizer":
      return {
        studioId: null,
        status,
        planCode,
        planName: "Organizer",
        isActive: true,
        canUseStudioAdmin: false,
        maxStudioAdmins: 0,
        canUseFrontDesk: false,
        canUseIndependentInstructor: false,
        canUseOrganizerAdmin: true,
        maxOrganizerAdmins: 999,
        hasPublicEventModule: true,
        canManageMemberships: false,
        canManagePackages: false,
        canUseAdvancedReports: true,
      };

    default:
      return {
        studioId: null,
        status,
        planCode,
        planName: null,
        isActive: true,
        canUseStudioAdmin: false,
        maxStudioAdmins: 0,
        canUseFrontDesk: false,
        canUseIndependentInstructor: false,
        canUseOrganizerAdmin: false,
        maxOrganizerAdmins: 0,
        hasPublicEventModule: false,
        canManageMemberships: false,
        canManagePackages: false,
        canUseAdvancedReports: false,
      };
  }
}

export async function getCurrentStudioPlanForUser() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return null;
  }

  const context = await getCurrentStudioContext();
  const studioId = context?.studioId ?? null;

  if (!studioId) {
    return null;
  }

  const [
    { data: studio, error: studioError },
    { data: subscription, error: subscriptionError },
  ] = await Promise.all([
    supabase
      .from("studios")
      .select(
        `
        billing_plan,
        subscription_status,
        billing_override_enabled,
        billing_override_reason,
        billing_override_expires_at
      `
      )
      .eq("id", studioId)
      .maybeSingle(),

    supabase
      .from("studio_subscriptions")
      .select(
        `
        status,
        subscription_plans (
          code,
          name
        )
      `
      )
      .eq("studio_id", studioId)
      .maybeSingle(),
  ]);

  const typedStudio = studio as StudioBillingAccessRow | null;

  const overrideExpiresAt = typedStudio?.billing_override_expires_at
    ? new Date(typedStudio.billing_override_expires_at)
    : null;

  const overrideActive = Boolean(
    typedStudio?.billing_override_enabled &&
      (!overrideExpiresAt || overrideExpiresAt.getTime() >= Date.now())
  );

  if (overrideActive) {
    const overridePlanCode =
      normalizePlanCode(typedStudio?.billing_plan ?? "pro") ?? "pro";

    return {
      studioId,
      status: "active",
      planCode: overridePlanCode,
      planName: overridePlanCode === "pro" ? "Pro" : overridePlanCode,
    };
  }

  if (subscriptionError || !subscription) {
    const fallbackPlanCode = normalizePlanCode(typedStudio?.billing_plan ?? null);
    const fallbackStatus = typedStudio?.subscription_status ?? "inactive";

    return {
      studioId,
      status: studioError ? "inactive" : fallbackStatus,
      planCode: fallbackPlanCode,
      planName: fallbackPlanCode,
    };
  }

  const typedSubscription = subscription as StudioSubscriptionAccessRow;
  const plan = getPlan(typedSubscription.subscription_plans);

  return {
    studioId,
    status: typedSubscription.status,
    planCode: normalizePlanCode(plan?.code ?? typedStudio?.billing_plan ?? null),
    planName: plan?.name ?? null,
  };
}

export async function getCurrentWorkspaceCapabilitiesForUser(): Promise<WorkspaceCapabilities | null> {
  const subscription = await getCurrentStudioPlanForUser();

  if (!subscription) {
    return null;
  }

  const capabilities = buildCapabilities(subscription.planCode, subscription.status);

  return {
    ...capabilities,
    studioId: subscription.studioId,
    planName: subscription.planName ?? capabilities.planName,
  };
}

export async function studioHasFeature(feature: BillingFeature) {
  const subscription = await getCurrentStudioPlanForUser();

  if (!subscription) return false;
  if (subscription.status !== "active" && subscription.status !== "trialing") {
    return false;
  }

  return planHasFeature(subscription.planCode, feature);
}

export async function requireStudioFeature(feature: BillingFeature) {
  const allowed = await studioHasFeature(feature);

  if (!allowed) {
    redirect(buildBillingUpgradeUrl(feature));
  }
}

export function canPlanUseRole(planCode: WorkspacePlanCode, role: AppRole) {
  switch (role) {
    case "studio_owner":
      return planCode === "starter" || planCode === "growth" || planCode === "pro";

    case "studio_admin":
      return planCode === "growth" || planCode === "pro";

    case "front_desk":
      return planCode === "growth" || planCode === "pro";

    case "instructor":
      return planCode === "starter" || planCode === "growth" || planCode === "pro";

    case "independent_instructor":
      return planCode === "starter" || planCode === "growth" || planCode === "pro";

    case "organizer_owner":
      return planCode === "organizer";

    case "organizer_admin":
      return planCode === "organizer";

    case "platform_admin":
      return true;

    default:
      return false;
  }
}

export function includedStudioAdminSeats(planCode: WorkspacePlanCode) {
  if (planCode === "growth") return 1;
  if (planCode === "pro") return 999;
  return 0;
}

export function includedOrganizerAdminSeats(planCode: WorkspacePlanCode) {
  if (planCode === "organizer") return 999;
  return 0;
}

export function hasAvailableStudioAdminSeat(args: {
  planCode: WorkspacePlanCode;
  currentStudioAdminCount: number;
}) {
  const allowed = includedStudioAdminSeats(args.planCode);
  return args.currentStudioAdminCount < allowed;
}

export function hasAvailableOrganizerAdminSeat(args: {
  planCode: WorkspacePlanCode;
  currentOrganizerAdminCount: number;
}) {
  const allowed = includedOrganizerAdminSeats(args.planCode);
  return args.currentOrganizerAdminCount < allowed;
}

export function canAssignRoleUnderPlan(args: {
  planCode: WorkspacePlanCode;
  targetRole: AppRole;
  currentStudioAdminCount?: number;
  currentOrganizerAdminCount?: number;
}) {
  const {
    planCode,
    targetRole,
    currentStudioAdminCount = 0,
    currentOrganizerAdminCount = 0,
  } = args;

  if (!canPlanUseRole(planCode, targetRole)) {
    return false;
  }

  if (targetRole === "studio_admin") {
    return hasAvailableStudioAdminSeat({
      planCode,
      currentStudioAdminCount,
    });
  }

  if (targetRole === "organizer_admin") {
    return hasAvailableOrganizerAdminSeat({
      planCode,
      currentOrganizerAdminCount,
    });
  }

  return true;
}

export function requiresOwnerGrantedExportOverride(role: AppRole, permission: string) {
  if (role === "platform_admin") return false;
  if (role === "studio_owner" || role === "organizer_owner") return false;

  if (role === "studio_admin") {
    return permission !== "export_reports";
  }

  if (role === "organizer_admin") {
    return permission !== "export_reports" && permission !== "export_events";
  }

  return true;
}