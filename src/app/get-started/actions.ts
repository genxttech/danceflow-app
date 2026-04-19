"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getBillingPlan, type PlanCode } from "@/lib/billing/plans";

function normalizeWorkspaceName(
  fullName: string | null | undefined,
  kind: "studio" | "organizer"
) {
  const base = (fullName || "My").trim();
  return kind === "studio" ? `${base} Studio` : `${base} Events`;
}

async function ensureWorkspaceForCurrentUser(kind: "studio" | "organizer") {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { data: existingRole } = await supabase
    .from("user_studio_roles")
    .select("studio_id")
    .eq("user_id", user.id)
    .eq("active", true)
    .limit(1)
    .maybeSingle();

  if (existingRole?.studio_id) {
    return existingRole.studio_id;
  }

  const fullName =
    typeof user.user_metadata?.full_name === "string"
      ? user.user_metadata.full_name
      : typeof user.user_metadata?.name === "string"
      ? user.user_metadata.name
      : null;

  const studioName = normalizeWorkspaceName(fullName, kind);

  const { data: studio, error: studioError } = await supabase
    .from("studios")
    .insert({
      name: studioName,
      subscription_status: "not_started",
    })
    .select("id")
    .single();

  if (studioError || !studio) {
    throw new Error(studioError?.message || "Could not create workspace.");
  }

  const { error: settingsError } = await supabase
    .from("studio_settings")
    .insert({
      studio_id: studio.id,
    });

  if (settingsError) {
    throw new Error(settingsError.message);
  }

  const { error: roleError } = await supabase
    .from("user_studio_roles")
    .insert({
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
      ? String(formData.get("planCode")).trim().toLowerCase()
      : "";

  const plan = getBillingPlan(planCodeRaw);

  if (!plan) {
    redirect("/get-started");
  }

  const kind = plan.audience === "organizer" ? "organizer" : "studio";
  await ensureWorkspaceForCurrentUser(kind);

  redirect(
  `/app/settings/billing?recommended=${encodeURIComponent(plan.code)}&entry=chooser&path=${encodeURIComponent(plan.audience)}`
);
}

export async function continueExplorerIntoDiscoveryAction() {
  redirect("/discover");
}