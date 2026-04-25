"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getBillingPlan, type PlanAudience } from "@/lib/billing/plans";

const APP_SELECTED_STUDIO_COOKIE = "app_selected_studio_id";

type PaidIntent = PlanAudience;

type WorkspaceRoleRow = {
  studio_id: string;
  role: string;
  studios:
    | {
        id: string;
        name: string | null;
        slug: string | null;
        public_name: string | null;
      }
    | {
        id: string;
        name: string | null;
        slug: string | null;
        public_name: string | null;
      }[]
    | null;
};

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function normalizeLocalNextPath(value: string) {
  if (!value) return "";
  if (!value.startsWith("/")) return "";
  if (value.startsWith("//")) return "";
  return value;
}

function buildTrialCompleteUrl(params: { audience: PaidIntent; planCode: string }) {
  const search = new URLSearchParams({
    intent: params.audience,
    plan: params.planCode,
  });

  return `/get-started/complete?${search.toString()}`;
}

function buildSignupUrl(params: { audience: PaidIntent; planCode: string }) {
  const next = buildTrialCompleteUrl({
    audience: params.audience,
    planCode: params.planCode,
  });

  const search = new URLSearchParams({
    intent: params.audience,
    plan: params.planCode,
    next,
  });

  return `/signup?${search.toString()}`;
}

function buildCheckoutUrl(params: {
  audience: PaidIntent;
  planCode: string;
  entry?: string;
}) {
  const search = new URLSearchParams({
    planCode: params.planCode,
    path: params.audience,
    entry: params.entry ?? "trial-complete",
  });

  return `/api/billing/checkout?${search.toString()}`;
}

function validatePaidIntent(params: { planCodeRaw: string; intentRaw?: string }) {
  const planCode = params.planCodeRaw.trim().toLowerCase();
  const plan = getBillingPlan(planCode);

  if (!plan) return null;

  const intentRaw = (params.intentRaw || plan.audience).trim().toLowerCase();
  if (intentRaw !== "studio" && intentRaw !== "organizer") return null;
  if (plan.audience !== intentRaw) return null;

  return {
    plan,
    intent: intentRaw as PaidIntent,
  };
}

function slugifyWorkspaceName(value: string) {
  return value
    .toLowerCase()
    .trim()
    .replace(/["']/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

function getStudioFromJoin(value: WorkspaceRoleRow["studios"]) {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function splitFullName(fullNameRaw: string | null | undefined) {
  const fullName = fullNameRaw?.trim() || "";

  if (!fullName) {
    return {
      firstName: "Studio",
      lastName: "Owner",
    };
  }

  const parts = fullName.split(/\s+/).filter(Boolean);
  const firstName = parts[0] || "Studio";
  const lastName = parts.length > 1 ? parts.slice(1).join(" ") : "Owner";

  return { firstName, lastName };
}

function getCurrentUserFullName(user: {
  user_metadata?: Record<string, unknown> | null;
  email?: string | null;
}) {
  const metadata = user.user_metadata ?? {};

  if (typeof metadata.full_name === "string" && metadata.full_name.trim()) {
    return metadata.full_name.trim();
  }

  if (typeof metadata.name === "string" && metadata.name.trim()) {
    return metadata.name.trim();
  }

  const emailName = user.email?.split("@")[0]?.replace(/[._-]+/g, " ").trim();
  return emailName || "My";
}

function getCurrentUserWorkspaceName(user: {
  user_metadata?: Record<string, unknown> | null;
}) {
  const metadata = user.user_metadata ?? {};

  if (
    typeof metadata.workspace_name === "string" &&
    metadata.workspace_name.trim()
  ) {
    return metadata.workspace_name.trim();
  }

  if (
    typeof metadata.studio_name === "string" &&
    metadata.studio_name.trim()
  ) {
    return metadata.studio_name.trim();
  }

  if (
    typeof metadata.business_name === "string" &&
    metadata.business_name.trim()
  ) {
    return metadata.business_name.trim();
  }

  return null;
}

function normalizeWorkspaceName(params: {
  preferredName?: string | null;
  fullName?: string | null;
  kind: PaidIntent;
}) {
  const preferred = params.preferredName?.trim();
  if (preferred) return preferred;

  const base = params.fullName?.trim() || "My";
  return params.kind === "studio" ? `${base} Studio` : `${base} Events`;
}

function workspaceMatchesIntent(
  workspaceName: string | null | undefined,
  kind: PaidIntent
) {
  const normalized = (workspaceName ?? "").trim().toLowerCase();
  if (!normalized) return false;

  const looksOrganizer =
    normalized.endsWith(" organizer") ||
    normalized.includes(" organizer ") ||
    normalized.endsWith(" events") ||
    normalized.includes(" event") ||
    normalized.includes(" festival") ||
    normalized.includes(" competition");

  return kind === "organizer" ? looksOrganizer : !looksOrganizer;
}

async function buildUniqueStudioSlug(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  baseName: string;
}) {
  const baseSlug = slugifyWorkspaceName(params.baseName) || "danceflow-workspace";
  const candidateSlugs = [
    baseSlug,
    `${baseSlug}-workspace`,
    `${baseSlug}-${Math.random().toString(36).slice(2, 8)}`,
  ];

  const { data: existingStudios, error } = await params.supabase
    .from("studios")
    .select("slug")
    .in("slug", candidateSlugs);

  if (error) {
    throw new Error(`Could not check workspace slug: ${error.message}`);
  }

  const used = new Set((existingStudios ?? []).map((row) => row.slug));
  const available = candidateSlugs.find((slug) => !used.has(slug));

  return available ?? `${baseSlug}-${Date.now().toString(36)}`;
}

async function setSelectedWorkspaceCookie(studioId: string) {
  const cookieStore = await cookies();

  cookieStore.set(APP_SELECTED_STUDIO_COOKIE, studioId, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  });
}

async function getActiveOwnerWorkspacesForUser(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  userId: string;
}) {
  const { data, error } = await params.supabase
    .from("user_studio_roles")
    .select(
      `
        studio_id,
        role,
        studios (
          id,
          name,
          slug,
          public_name
        )
      `
    )
    .eq("user_id", params.userId)
    .eq("active", true)
    .eq("role", "studio_owner")
    .order("created_at", { ascending: true });

  if (error) {
    throw new Error(`Could not load workspaces: ${error.message}`);
  }

  return (data ?? []) as WorkspaceRoleRow[];
}

async function getSelectedWorkspaceIdFromCookie() {
  const cookieStore = await cookies();
  return cookieStore.get(APP_SELECTED_STUDIO_COOKIE)?.value ?? null;
}

function pickExistingWorkspaceForIntent(params: {
  rows: WorkspaceRoleRow[];
  selectedWorkspaceId: string | null;
  kind: PaidIntent;
}) {
  const { rows, selectedWorkspaceId, kind } = params;
  if (!rows.length) return null;

  const selectedRow = selectedWorkspaceId
    ? rows.find((row) => row.studio_id === selectedWorkspaceId) ?? null
    : null;

  if (selectedRow) {
    const selectedStudio = getStudioFromJoin(selectedRow.studios);
    if (workspaceMatchesIntent(selectedStudio?.name, kind)) {
      return selectedRow;
    }
  }

  return (
    rows.find((row) => {
      const studio = getStudioFromJoin(row.studios);
      return workspaceMatchesIntent(studio?.name, kind);
    }) ?? null
  );
}

async function ensureOwnerInstructorProfile(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  studioId: string;
  userId: string;
  userEmail: string | null;
  fullName: string;
}) {
  const { supabase, studioId, userId, userEmail, fullName } = params;
  const { firstName, lastName } = splitFullName(fullName);

  const { data: existingInstructor, error: existingError } = await supabase
    .from("instructors")
    .select("id, active")
    .eq("studio_id", studioId)
    .eq("profile_user_id", userId)
    .maybeSingle();

  if (existingError) {
    throw new Error(
      `Could not check owner instructor profile: ${existingError.message}`
    );
  }

  if (existingInstructor) {
    if (existingInstructor.active === true) return;

    const { error: reactivateError } = await supabase
      .from("instructors")
      .update({
        active: true,
        first_name: firstName,
        last_name: lastName,
        email: userEmail,
      })
      .eq("id", existingInstructor.id);

    if (reactivateError) {
      throw new Error(
        `Could not reactivate owner instructor profile: ${reactivateError.message}`
      );
    }

    return;
  }

  const { error: insertError } = await supabase.from("instructors").insert({
    studio_id: studioId,
    profile_user_id: userId,
    first_name: firstName,
    last_name: lastName,
    email: userEmail,
    active: true,
    public_profile_enabled: false,
    display_order: 0,
  });

  if (insertError) {
    throw new Error(
      `Could not create owner instructor profile: ${insertError.message}`
    );
  }
}

async function createWorkspaceForUser(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  userId: string;
  userEmail: string | null;
  workspaceName: string;
  kind: PaidIntent;
  ownerFullName: string;
}) {
  const slug = await buildUniqueStudioSlug({
    supabase: params.supabase,
    baseName: params.workspaceName,
  });

  const { data: studio, error: studioError } = await params.supabase
    .from("studios")
    .insert({
      name: params.workspaceName,
      public_name: params.workspaceName,
      slug,
      subscription_status: "not_started",
    })
    .select("id, name, slug")
    .single();

  if (studioError || !studio) {
    throw new Error(
      `Could not create workspace: ${studioError?.message ?? "Unknown error."}`
    );
  }

  const { error: roleError } = await params.supabase
    .from("user_studio_roles")
    .insert({
      user_id: params.userId,
      studio_id: studio.id,
      role: "studio_owner",
      active: true,
    });

  if (roleError) {
    throw new Error(`Could not assign workspace owner: ${roleError.message}`);
  }

  await ensureOwnerInstructorProfile({
    supabase: params.supabase,
    studioId: studio.id,
    userId: params.userId,
    userEmail: params.userEmail,
    fullName: params.ownerFullName,
  });

  const { error: settingsError } = await params.supabase
    .from("studio_settings")
    .upsert(
      {
        studio_id: studio.id,
      },
      { onConflict: "studio_id" }
    );

  if (settingsError) {
    // Do not block checkout if settings defaults are handled elsewhere.
    console.warn("Could not create default studio settings:", settingsError.message);
  }

  return studio;
}

export async function startPaidPathAction(formData: FormData) {
  const planCodeRaw = getString(formData, "planCode") || getString(formData, "planKey");
  const intentRaw = getString(formData, "intent") || getString(formData, "path");
  const workspaceNameRaw =
    getString(formData, "workspaceName") ||
    getString(formData, "studioName") ||
    getString(formData, "businessName");
  const nextPath = normalizeLocalNextPath(getString(formData, "nextPath"));

  const validated = validatePaidIntent({ planCodeRaw, intentRaw });

  if (!validated) {
    redirect("/get-started?error=invalid_plan");
  }

  const { plan, intent } = validated;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect(
      buildSignupUrl({
        audience: intent,
        planCode: plan.code,
      })
    );
  }

  const ownerRows = await getActiveOwnerWorkspacesForUser({
    supabase,
    userId: user.id,
  });
  const selectedWorkspaceId = await getSelectedWorkspaceIdFromCookie();
  const existingWorkspace = pickExistingWorkspaceForIntent({
    rows: ownerRows,
    selectedWorkspaceId,
    kind: intent,
  });

  if (existingWorkspace) {
    await setSelectedWorkspaceCookie(existingWorkspace.studio_id);
    redirect(
      nextPath ||
        buildCheckoutUrl({
          audience: intent,
          planCode: plan.code,
        })
    );
  }

  const ownerFullName = getCurrentUserFullName(user);
  const workspaceName = normalizeWorkspaceName({
    preferredName: workspaceNameRaw || getCurrentUserWorkspaceName(user),
    fullName: ownerFullName,
    kind: intent,
  });

  const studio = await createWorkspaceForUser({
    supabase,
    userId: user.id,
    userEmail: user.email ?? null,
    workspaceName,
    kind: intent,
    ownerFullName,
  });

  await setSelectedWorkspaceCookie(studio.id);

  redirect(
    nextPath ||
      buildCheckoutUrl({
        audience: intent,
        planCode: plan.code,
      })
  );
}

export async function beginPaidTrialCheckoutAction(formData: FormData) {
  const audienceRaw = getString(formData, "audience") || getString(formData, "intent") || "studio";
  const planCodeRaw =
    getString(formData, "planCode") ||
    getString(formData, "plan") ||
    getString(formData, "selectedPlan") ||
    getString(formData, "planKey");
  const workspaceName =
    getString(formData, "workspaceName") ||
    getString(formData, "studioName") ||
    getString(formData, "organizerName") ||
    getString(formData, "businessName");

  const validated = validatePaidIntent({
    planCodeRaw,
    intentRaw: audienceRaw,
  });

  if (!validated) {
    redirect("/get-started?error=invalid_plan");
  }

  const search = new URLSearchParams({
    planCode: validated.plan.code,
    path: validated.intent,
    entry: "trial-complete",
  });

  if (workspaceName) {
    search.set("workspaceName", workspaceName);
  }

  redirect(`/api/billing/checkout?${search.toString()}`);
}

export async function chooseExplorerPathAction() {
  redirect("/get-started/explorer");
}

export async function chooseStudioPathAction() {
  redirect("/get-started/studio");
}

export async function chooseOrganizerPathAction() {
  redirect("/get-started/organizer");
}

export async function continueExplorerIntoDiscoveryAction() {
  redirect("/discover");
}
