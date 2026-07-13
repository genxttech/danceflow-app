import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getIncludedUsageAllowance } from "@/lib/usage/addons";
import { resolvePortalRelationship } from "@/lib/student-identity/portal-context";

type PlanCode = "starter" | "growth" | "pro" | null;

type PortalClient = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  is_independent_instructor: boolean | null;
};

export type LumiPortalAccess = {
  admin: ReturnType<typeof createAdminClient>;
  studio: { id: string; name: string; slug: string };
  client: PortalClient;
  planCode: PlanCode;
  enabled: boolean;
  eligible: boolean;
  allowed: boolean;
  reason: "available" | "studio_disabled" | "plan_required" | "inactive_student" | "instructor_portal";
};

function isActiveStatus(value: string | null | undefined) {
  return value === "active" || value === "trialing";
}

function normalizePlan(value: string | null | undefined): PlanCode {
  return value === "starter" || value === "growth" || value === "pro"
    ? value
    : null;
}

export async function resolveLumiPortalAccess(
  studioSlug: string,
  requestedClientId?: string | null,
): Promise<LumiPortalAccess> {
  const authClient = await createClient();
  const {
    data: { user },
  } = await authClient.auth.getUser();

  if (!user) {
    redirect(
      `/login?intent=public&next=${encodeURIComponent(`/portal/${studioSlug}/journey`)}`,
    );
  }

  const admin = createAdminClient();
  const { data: studio } = await admin
    .from("studios")
    .select(
      "id, name, slug, billing_plan, subscription_status, billing_override_enabled, billing_override_expires_at",
    )
    .eq("slug", studioSlug)
    .maybeSingle();

  if (!studio) redirect("/app");

  const relationship = await resolvePortalRelationship({
    userId: user.id,
    studioId: studio.id,
    requestedClientId,
  });

  if (!relationship) redirect(`/portal/${studioSlug}`);

  const { data: client } = await admin
    .from("clients")
    .select("id, first_name, last_name, is_independent_instructor")
    .eq("studio_id", studio.id)
    .eq("id", relationship.clientId)
    .maybeSingle<PortalClient>();

  if (!client) redirect(`/portal/${studioSlug}`);

  const [{ data: settings }, { data: subscription }] = await Promise.all([
    admin
      .from("studio_settings")
      .select("lumi_enabled")
      .eq("studio_id", studio.id)
      .maybeSingle(),
    admin
      .from("studio_subscriptions")
      .select("status, subscription_plans (code)")
      .eq("studio_id", studio.id)
      .maybeSingle(),
  ]);

  const planRelation = Array.isArray(subscription?.subscription_plans)
    ? subscription.subscription_plans[0]
    : subscription?.subscription_plans;
  const overrideExpiresAt = studio.billing_override_expires_at
    ? new Date(studio.billing_override_expires_at)
    : null;
  const overrideActive = Boolean(
    studio.billing_override_enabled &&
      (!overrideExpiresAt || overrideExpiresAt.getTime() > Date.now()),
  );
  const planCode = normalizePlan(
    planRelation?.code ?? studio.billing_plan,
  );
  const billingActive =
    overrideActive ||
    isActiveStatus(subscription?.status ?? studio.subscription_status);
  const planAllowed =
    billingActive && (planCode === "growth" || planCode === "pro");
  const enabled = settings?.lumi_enabled === true;

  const nowIso = new Date().toISOString();
  const recentIso = new Date(
    Date.now() - 60 * 24 * 60 * 60 * 1000,
  ).toISOString();
  const today = nowIso.slice(0, 10);

  const [membership, packageRow, upcomingLesson, recentLesson, eventRegistration] =
    await Promise.all([
      admin
        .from("client_memberships")
        .select("id")
        .eq("studio_id", studio.id)
        .eq("client_id", client.id)
        .in("status", ["active", "trialing"])
        .limit(1)
        .maybeSingle(),
      admin
        .from("client_packages")
        .select("id, client_package_items (quantity_remaining, is_unlimited)")
        .eq("studio_id", studio.id)
        .eq("client_id", client.id)
        .eq("active", true)
        .limit(10),
      admin
        .from("appointments")
        .select("id")
        .eq("studio_id", studio.id)
        .eq("client_id", client.id)
        .gte("starts_at", nowIso)
        .neq("status", "cancelled")
        .limit(1)
        .maybeSingle(),
      admin
        .from("appointments")
        .select("id")
        .eq("studio_id", studio.id)
        .eq("client_id", client.id)
        .gte("starts_at", recentIso)
        .lt("starts_at", nowIso)
        .in("status", ["attended", "completed"])
        .limit(1)
        .maybeSingle(),
      admin
        .from("event_registrations")
        .select("id, events!inner(start_date)")
        .eq("studio_id", studio.id)
        .eq("client_id", client.id)
        .in("status", ["confirmed", "pending", "checked_in"])
        .gte("events.start_date", today)
        .limit(1)
        .maybeSingle(),
    ]);

  const hasActivePackageBalance = (packageRow.data ?? []).some((pkg) =>
    (pkg.client_package_items ?? []).some(
      (item) =>
        item.is_unlimited === true || Number(item.quantity_remaining ?? 0) > 0,
    ),
  );
  const eligible = Boolean(
    membership.data ||
      hasActivePackageBalance ||
      upcomingLesson.data ||
      recentLesson.data ||
      eventRegistration.data,
  );
  const instructorPortal = client.is_independent_instructor === true;

  const reason: LumiPortalAccess["reason"] = instructorPortal
    ? "instructor_portal"
    : !enabled
      ? "studio_disabled"
      : !planAllowed
        ? "plan_required"
        : !eligible
          ? "inactive_student"
          : "available";

  return {
    admin,
    studio: { id: studio.id, name: studio.name, slug: studio.slug },
    client,
    planCode,
    enabled,
    eligible,
    allowed: reason === "available",
    reason,
  };
}

export async function getLumiUsageAllowance(
  access: LumiPortalAccess,
  quantity = 1,
) {
  const periodStart = new Date(
    Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1),
  );
  const periodEnd = new Date(
    Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 1),
  );
  const periodStartKey = periodStart.toISOString().slice(0, 10);
  const periodEndKey = periodEnd.toISOString().slice(0, 10);
  const includedAllowance = getIncludedUsageAllowance({
    planCode: access.planCode,
    featureKey: "ai_action",
  });

  const [{ data: summary }, { data: entitlements }] = await Promise.all([
    access.admin
      .from("usage_monthly_summaries")
      .select("quantity_used")
      .eq("studio_id", access.studio.id)
      .eq("feature_key", "ai_action")
      .eq("period_start", periodStartKey)
      .limit(1)
      .maybeSingle(),
    access.admin
      .from("usage_addon_entitlements")
      .select("quantity_included")
      .eq("studio_id", access.studio.id)
      .eq("feature_key", "ai_action")
      .eq("status", "active"),
  ]);

  const addonAllowance = (entitlements ?? []).reduce(
    (sum, row) => sum + Math.max(0, row.quantity_included ?? 0),
    0,
  );
  const used = Math.max(0, summary?.quantity_used ?? 0);
  const total = includedAllowance + addonAllowance;

  return {
    allowed: access.allowed && total > 0 && used + quantity <= total,
    used,
    total,
    remaining: Math.max(0, total - used),
    periodStart: periodStartKey,
    periodEnd: periodEndKey,
  };
}

export async function recordLumiUsage(
  access: LumiPortalAccess,
  metadata: Record<string, unknown>,
) {
  const allowance = await getLumiUsageAllowance(access, 1);
  if (!allowance.allowed) return false;

  const { error } = await access.admin.rpc("record_usage_event", {
    p_studio_id: access.studio.id,
    p_organizer_id: null,
    p_workspace_type: "studio",
    p_feature_key: "ai_action",
    p_quantity: 1,
    p_source: "lumi_journey_assistant",
    p_related_table: "clients",
    p_related_id: access.client.id,
    p_metadata: metadata,
    p_period_start: allowance.periodStart,
    p_period_end: allowance.periodEnd,
  });

  if (error) console.error("LUMI usage recording failed", error.message);
  return !error;
}
