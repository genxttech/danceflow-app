"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getBillingPlan } from "@/lib/billing/plans";

const APP_SELECTED_STUDIO_COOKIE = "app_selected_studio_id";

type PaidIntent = "studio" | "organizer";

type ActiveWorkspaceRow = {
  studio_id: string;
  role: string;
  studios:
    | {
        id: string;
        name: string;
        slug: string | null;
        public_name: string | null;
      }
    | {
        id: string;
        name: string;
        slug: string | null;
        public_name: string | null;
      }[]
    | null;
};

function buildTrialCompleteUrl(params: {
  audience: PaidIntent;
  planCode: string;
}) {
  const search = new URLSearchParams({
    intent: params.audience,
    plan: params.planCode,
  });

  return `/get-started/complete?${search.toString()}`;
}

function buildSignupUrl(params: {
  audience: PaidIntent;
  planCode: string;
}) {
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

function validatePaidIntent(params: {
  planCodeRaw: string;
  intentRaw: string;
}) {
  const planCode = params.planCodeRaw.trim().toLowerCase();
  const intent = params.intentRaw.trim().toLowerCase();
  const plan = getBillingPlan(planCode);

  if (!plan) return null;
  if (intent !== "studio" && intent !== "organizer") return null;
  if (plan.audience !== intent) return null;

  return {
    plan,
    intent: intent as PaidIntent,
  };
}

function normalizeWorkspaceName(
  preferredName: string | null | undefined,
  fullName: string | null | undefined,
  kind: PaidIntent
) {
  const preferred = (preferredName || "").trim();
  if (preferred) return preferred;

  const base = (fullName || "My").trim() || "My";
  return kind === "studio" ? `${base} Studio` : `${base} Organizer`;
}

function slugifyWorkspaceName(value: string) {
  return value
    .toLowerCase()
    .trim()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

function getStudioFromJoin(value: ActiveWorkspaceRow["studios"]) {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
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
    normalized.includes(" festival") ||
    normalized.includes(" event");

  if (kind === "organizer") {
    return looksOrganizer;
  }

  return !looksOrganizer;
}

async function buildUniqueStudioSlug(baseName: string) {
  const supabase = await createClient();

  const baseSlug = slugifyWorkspaceName(baseName) || "danceflow-workspace";
  const candidateSlugs = [
    baseSlug,
    `${baseSlug}-workspace`,
    `${baseSlug}-${Math.random().toString(36).slice(2, 8)}`,
  ];

  const { data: existingStudios, error } = await supabase
    .from("studios")
    .select("slug")
    .in("slug", candidateSlugs);

  if (error) {
    throw new Error(error.message);
  }

  const used = new Set((existingStudios ?? []).map((row) => row.slug));
  const available = candidateSlugs.find((slug) => !used.has(slug));

  if (available) {
    return available;
  }

  return `${baseSlug}-${Date.now().toString(36)}`;
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

async function getCurrentUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  return { supabase, user };
}

function getCurrentUserFullName(user: {
  user_metadata?: Record<string, unknown> | null;
}) {
  return typeof user.user_metadata?.full_name === "string"
    ? user.user_metadata.full_name
    : typeof user.user_metadata?.name === "string"
      ? user.user_metadata.name
      : null;
}

function getCurrentUserWorkspaceName(user: {
  user_metadata?: Record<string, unknown> | null;
}) {
  return typeof user.user_metadata?.workspace_name === "string"
    ? user.user_metadata.workspace_name
    : null;
}

async function getActiveWorkspacesForUser(userId: string) {
  const supabase = await createClient();

  const { data, error } = await supabase
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
    .eq("user_id", userId)
    .eq("active", true)
    .order("created_at", { ascending: true });

  if (error) {
    throw new Error(`Could not load workspaces: ${error.message}`);
  }

  return (data ?? []) as ActiveWorkspaceRow[];
}

async function getSelectedWorkspaceIdFromCookie() {
  const cookieStore = await cookies();
  return cookieStore.get(APP_SELECTED_STUDIO_COOKIE)?.value ?? null;
}

function pickExistingWorkspaceForIntent(
  rows: ActiveWorkspaceRow[],
  selectedWorkspaceId: string | null,
  kind: PaidIntent
) {
  if (!rows.length) return null;

  const selectedRow = selectedWorkspaceId
    ? rows.find((row) => row.studio_id === selectedWorkspaceId) ?? null
    : null;

  const selectedStudio = selectedRow ? getStudioFromJoin(selectedRow.studios) : null;

  if (selectedRow && workspaceMatchesIntent(selectedStudio?.name, kind)) {
    return selectedRow;
  }

  const intentMatch =
    rows.find((row) => {
      const studio = getStudioFromJoin(row.studios);
      return workspaceMatchesIntent(studio?.name, kind);
    }) ?? null;

  if (intentMatch) {
    return intentMatch;
  }

  if (kind === "studio") {
    return rows[0];
  }

  return null;
}

async function createWorkspaceForCurrentUser(params: {
  kind: PaidIntent;
  workspaceName?: string | null;
}) {
  const { supabase, user } = await getCurrentUser();

  const fullName = getCurrentUserFullName(user);
  const metadataWorkspaceName = getCurrentUserWorkspaceName(user);

  const workspaceName = normalizeWorkspaceName(
    params.workspaceName ?? metadataWorkspaceName,
    fullName,
    params.kind
  );

  const workspaceSlug = await buildUniqueStudioSlug(workspaceName);

  const { data: studio, error: studioError } = await supabase
    .from("studios")
    .insert({
      name: workspaceName,
      slug: workspaceSlug,
      subscription_status: "not_started",
    })
    .select("id")
    .single();

  if (studioError || !studio) {
    throw new Error(studioError?.message || "Could not create workspace.");
  }

  const { error: settingsError } = await supabase.from("studio_settings").insert({
    studio_id: studio.id,
  });

  if (settingsError) {
    throw new Error(settingsError.message);
  }

  const { error: profileUpsertError } = await supabase.from("profiles").upsert(
    {
      id: user.id,
    },
    { onConflict: "id" }
  );

  if (profileUpsertError) {
    throw new Error(profileUpsertError.message);
  }

  const { error: roleError } = await supabase.from("user_studio_roles").insert({
    studio_id: studio.id,
    user_id: user.id,
    role: "studio_owner",
    active: true,
  });

  if (roleError) {
    throw new Error(roleError.message);
  }

  return studio.id;
}

async function ensureWorkspaceForCurrentUser(params: {
  kind: PaidIntent;
  workspaceName?: string | null;
}) {
  const { user } = await getCurrentUser();

  const [roles, selectedWorkspaceId] = await Promise.all([
    getActiveWorkspacesForUser(user.id),
    getSelectedWorkspaceIdFromCookie(),
  ]);

  const existingWorkspace = pickExistingWorkspaceForIntent(
    roles,
    selectedWorkspaceId,
    params.kind
  );

  if (existingWorkspace?.studio_id) {
    await setSelectedWorkspaceCookie(existingWorkspace.studio_id);
    return existingWorkspace.studio_id;
  }

  const createdStudioId = await createWorkspaceForCurrentUser({
    kind: params.kind,
    workspaceName: params.workspaceName,
  });

  await setSelectedWorkspaceCookie(createdStudioId);
  return createdStudioId;
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

export async function startPaidPathAction(formData: FormData) {
  const planCodeRaw =
    typeof formData.get("planCode") === "string"
      ? String(formData.get("planCode"))
      : "";

  const plan = getBillingPlan(planCodeRaw.trim().toLowerCase());

  if (!plan) {
    redirect("/get-started");
  }

  const { supabase } = await getCurrentUser().catch(() => ({ supabase: null as never }));

  if (!supabase) {
    redirect(
      buildSignupUrl({
        audience: plan.audience,
        planCode: plan.code,
      })
    );
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect(
      buildSignupUrl({
        audience: plan.audience,
        planCode: plan.code,
      })
    );
  }

  redirect(
    buildTrialCompleteUrl({
      audience: plan.audience,
      planCode: plan.code,
    })
  );
}

export async function beginPaidTrialCheckoutAction(formData: FormData) {
  const planCodeRaw =
    typeof formData.get("planCode") === "string"
      ? String(formData.get("planCode"))
      : "";

  const intentRaw =
    typeof formData.get("intent") === "string"
      ? String(formData.get("intent"))
      : "";

  const workspaceName =
    typeof formData.get("workspaceName") === "string"
      ? String(formData.get("workspaceName")).trim()
      : "";

  const validated = validatePaidIntent({
    planCodeRaw,
    intentRaw,
  });

  if (!validated) {
    redirect("/get-started");
  }

  await ensureWorkspaceForCurrentUser({
    kind: validated.intent,
    workspaceName: workspaceName || null,
  });

  redirect(
    `/app/settings/billing?recommended=${encodeURIComponent(
      validated.plan.code
    )}&entry=trial-complete&path=${encodeURIComponent(validated.intent)}`
  );
}

export async function continueExplorerIntoDiscoveryAction() {
  redirect("/discover");
}