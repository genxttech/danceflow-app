import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import {
  planHasFeature,
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

  const { data: subscription, error: subscriptionError } = await supabase
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
    .maybeSingle();

  if (subscriptionError || !subscription) {
    return {
      studioId,
      status: "inactive",
      planCode: null as WorkspacePlanCode,
      planName: null,
    };
  }

  const typedSubscription = subscription as StudioSubscriptionAccessRow;
  const plan = getPlan(typedSubscription.subscription_plans);

  return {
    studioId,
    status: typedSubscription.status,
    planCode: normalizePlanCode(plan?.code ?? null),
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