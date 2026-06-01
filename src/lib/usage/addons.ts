import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { getCurrentStudioPlanForUser, type WorkspacePlanCode } from "@/lib/billing/access";

export type UsageFeatureKey =
  | "ai_action"
  | "sms_message"
  | "sms_segment"
  | "email_campaign_recipient";

export type UsageWorkspaceType = "studio" | "organizer";

export type UsageAllowanceResult = {
  allowed: boolean;
  workspaceType: UsageWorkspaceType | null;
  studioId: string | null;
  organizerId: string | null;
  featureKey: UsageFeatureKey;
  planCode: WorkspacePlanCode;
  includedAllowance: number;
  addonAllowance: number;
  totalAllowance: number;
  quantityUsed: number;
  quantityRequested: number;
  quantityRemaining: number;
  periodStart: string;
  periodEnd: string;
  reason?: "not_signed_in" | "no_workspace" | "inactive_subscription" | "limit_reached";
};

type UsageSummaryRow = {
  quantity_used: number | null;
};

type UsageEntitlementRow = {
  quantity_included: number | null;
};

function getCurrentMonthlyPeriod(now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

  return {
    periodStart: start.toISOString().slice(0, 10),
    periodEnd: end.toISOString().slice(0, 10),
  };
}

export function getIncludedUsageAllowance(args: {
  planCode: WorkspacePlanCode;
  featureKey: UsageFeatureKey;
}) {
  const { planCode, featureKey } = args;

  if (featureKey === "ai_action") {
    if (planCode === "growth") return 200;
    if (planCode === "pro") return 500;
    if (planCode === "organizer") return 100;
    return 0;
  }

  if (featureKey === "sms_message" || featureKey === "sms_segment") {
    return 0;
  }

  if (featureKey === "email_campaign_recipient") {
    if (planCode === "growth") return 1000;
    if (planCode === "pro") return 5000;
    if (planCode === "organizer") return 1000;
    return 0;
  }

  return 0;
}

function emptyAllowance(args: {
  featureKey: UsageFeatureKey;
  quantityRequested: number;
  reason: UsageAllowanceResult["reason"];
}): UsageAllowanceResult {
  const { periodStart, periodEnd } = getCurrentMonthlyPeriod();

  return {
    allowed: false,
    workspaceType: null,
    studioId: null,
    organizerId: null,
    featureKey: args.featureKey,
    planCode: null,
    includedAllowance: 0,
    addonAllowance: 0,
    totalAllowance: 0,
    quantityUsed: 0,
    quantityRequested: args.quantityRequested,
    quantityRemaining: 0,
    periodStart,
    periodEnd,
    reason: args.reason,
  };
}

export async function getUsageAllowance(args: {
  featureKey: UsageFeatureKey;
  quantity?: number;
}): Promise<UsageAllowanceResult> {
  const quantityRequested = Math.max(1, args.quantity ?? 1);
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return emptyAllowance({
      featureKey: args.featureKey,
      quantityRequested,
      reason: "not_signed_in",
    });
  }

  const context = await getCurrentStudioContext();
  const contextWithOrganizer = context as { organizerId?: string | null } | null;
  const studioId = context?.studioId ?? null;
  const organizerId = contextWithOrganizer?.organizerId ?? null;
  const workspaceType: UsageWorkspaceType | null = organizerId ? "organizer" : studioId ? "studio" : null;

  if (!workspaceType) {
    return emptyAllowance({
      featureKey: args.featureKey,
      quantityRequested,
      reason: "no_workspace",
    });
  }

  // V1 meters studio plans directly. Organizer allowance is included for the schema
  // and future organizer AI/SMS work, but most current AI actions are studio-scoped.
  const subscription = await getCurrentStudioPlanForUser();
  const status = subscription?.status ?? null;
  const planCode = subscription?.planCode ?? (workspaceType === "organizer" ? "organizer" : null);

  if (status !== "active" && status !== "trialing" && workspaceType === "studio") {
    return {
      ...emptyAllowance({
        featureKey: args.featureKey,
        quantityRequested,
        reason: "inactive_subscription",
      }),
      workspaceType,
      studioId,
      organizerId,
      planCode,
    };
  }

  const { periodStart, periodEnd } = getCurrentMonthlyPeriod();
  const includedAllowance = getIncludedUsageAllowance({
    planCode,
    featureKey: args.featureKey,
  });

  let summaryQuery = supabase
    .from("usage_monthly_summaries")
    .select("quantity_used")
    .eq("feature_key", args.featureKey)
    .eq("period_start", periodStart)
    .limit(1);

  if (workspaceType === "organizer") {
    summaryQuery = summaryQuery.eq("organizer_id", organizerId ?? "");
  } else {
    summaryQuery = summaryQuery.eq("studio_id", studioId ?? "");
  }

  const { data: summary } = await summaryQuery.maybeSingle<UsageSummaryRow>();

  let entitlementQuery = supabase
    .from("usage_addon_entitlements")
    .select("quantity_included")
    .eq("feature_key", args.featureKey)
    .eq("status", "active");

  if (workspaceType === "organizer") {
    entitlementQuery = entitlementQuery.eq("organizer_id", organizerId ?? "");
  } else {
    entitlementQuery = entitlementQuery.eq("studio_id", studioId ?? "");
  }

  const { data: entitlements } = await entitlementQuery;

  const addonAllowance = (entitlements ?? []).reduce(
    (total, row) => total + Math.max(0, row.quantity_included ?? 0),
    0,
  );
  const quantityUsed = Math.max(0, summary?.quantity_used ?? 0);
  const totalAllowance = includedAllowance + addonAllowance;
  const quantityRemaining = Math.max(0, totalAllowance - quantityUsed);
  const allowed = totalAllowance > 0 && quantityUsed + quantityRequested <= totalAllowance;

  return {
    allowed,
    workspaceType,
    studioId,
    organizerId,
    featureKey: args.featureKey,
    planCode,
    includedAllowance,
    addonAllowance,
    totalAllowance,
    quantityUsed,
    quantityRequested,
    quantityRemaining,
    periodStart,
    periodEnd,
    reason: allowed ? undefined : "limit_reached",
  };
}

export async function recordUsageEvent(args: {
  featureKey: UsageFeatureKey;
  quantity?: number;
  source: string;
  relatedTable?: string;
  relatedId?: string;
  metadata?: Record<string, unknown>;
}) {
  const quantity = Math.max(1, args.quantity ?? 1);
  const allowance = await getUsageAllowance({
    featureKey: args.featureKey,
    quantity,
  });

  if (!allowance.allowed || !allowance.workspaceType) {
    return { ok: false, allowance };
  }

  const supabase = await createClient();

  const { error } = await supabase.rpc("record_usage_event", {
    p_studio_id: allowance.workspaceType === "studio" ? allowance.studioId : null,
    p_organizer_id: allowance.workspaceType === "organizer" ? allowance.organizerId : null,
    p_workspace_type: allowance.workspaceType,
    p_feature_key: args.featureKey,
    p_quantity: quantity,
    p_source: args.source,
    p_related_table: args.relatedTable ?? null,
    p_related_id: args.relatedId ?? null,
    p_metadata: args.metadata ?? {},
    p_period_start: allowance.periodStart,
    p_period_end: allowance.periodEnd,
  });

  if (error) {
    console.error("Usage event recording failed", {
      featureKey: args.featureKey,
      source: args.source,
      workspaceType: allowance.workspaceType,
      studioId: allowance.studioId,
      organizerId: allowance.organizerId,
      message: error.message,
      details: error.details,
      hint: error.hint,
      code: error.code,
    });
  }

  return { ok: !error, error, allowance };
}

export function getUsageLimitMessage(allowance: UsageAllowanceResult, label = "usage") {
  if (allowance.reason === "inactive_subscription") {
    return "Your subscription must be active before this feature can be used.";
  }

  if (allowance.totalAllowance <= 0) {
    return `${label} is not included on your current plan.`;
  }

  return `This workspace has reached its monthly ${label} limit. Upgrade or add more credits to continue.`;
}
