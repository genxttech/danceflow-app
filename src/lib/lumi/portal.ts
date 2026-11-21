import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolvePortalRelationship } from "@/lib/student-identity/portal-context";
import { resolveStudioBillingPlan } from "@/lib/billing/access";

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
    .select("id, name, slug")
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

  const [{ data: settings }, billingResolution] = await Promise.all([
    admin
      .from("studio_settings")
      .select("lumi_enabled")
      .eq("studio_id", studio.id)
      .maybeSingle(),
    resolveStudioBillingPlan(admin, studio.id),
  ]);

  const planCode = normalizePlan(billingResolution.planCode);
  const billingActive = isActiveStatus(billingResolution.status);
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
