"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";

function normalizeChecklistType(value: FormDataEntryValue | string | null | undefined) {
  const checklistTypeRaw = String(value ?? "studio").trim();
  return checklistTypeRaw === "organizer" ? "organizer" : "studio";
}

export async function dismissWorkspaceOnboardingAction(formData: FormData) {
  const checklistType = normalizeChecklistType(formData.get("checklistType"));

  const supabase = await createClient();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    throw new Error("You must be signed in to hide the setup checklist.");
  }

  const context = await getCurrentStudioContext();
  const now = new Date().toISOString();

  const { error } = await supabase.from("workspace_onboarding_preferences").upsert(
    {
      studio_id: context.studioId,
      user_id: user.id,
      checklist_type: checklistType,
      dismissed_at: now,
      updated_at: now,
    },
    {
      onConflict: "studio_id,user_id,checklist_type",
    }
  );

  if (error) {
    throw new Error(`Could not hide setup checklist: ${error.message}`);
  }

  revalidatePath("/app");
  revalidatePath("/app/onboarding");
}

export async function completeWorkspaceOnboardingAction(checklistTypeInput: "studio" | "organizer") {
  const checklistType = normalizeChecklistType(checklistTypeInput);

  const supabase = await createClient();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    throw new Error("You must be signed in to complete the setup checklist.");
  }

  const context = await getCurrentStudioContext();
  const now = new Date().toISOString();

  const { error } = await supabase.from("workspace_onboarding_preferences").upsert(
    {
      studio_id: context.studioId,
      user_id: user.id,
      checklist_type: checklistType,
      completed_at: now,
      updated_at: now,
    },
    {
      onConflict: "studio_id,user_id,checklist_type",
    }
  );

  if (error) {
    throw new Error(`Could not complete setup checklist: ${error.message}`);
  }

  revalidatePath("/app");
  revalidatePath("/app/onboarding");
}


type OnboardingMilestoneSyncInput = {
  key: string;
  title: string;
  domain: string;
  complete: boolean;
  sequence: number;
};

type OnboardingProjectSyncInput = {
  checklistType: "studio" | "organizer";
  milestones: OnboardingMilestoneSyncInput[];
  readinessScore: number;
  nextMilestoneKey: string | null;
};

const ALLOWED_ONBOARDING_MILESTONE_KEYS = new Set([
  "settings",
  "instructors",
  "clients",
  "schedule",
  "packages",
  "payouts",
  "portal-invites",
  "public-growth",
  "organizer-profile",
  "create-event",
  "registration-test",
  "publish-event",
  "discovery-ready",
  // Reserved migration and retail stages for the guided onboarding redesign.
  "migration-source-selected",
  "clients-migrated",
  "staff-migrated",
  "packages-reconciled",
  "memberships-reconciled",
  "products-migrated",
  "inventory-reconciled",
  "retail-orders-reconciled",
  "digital-entitlements-verified",
  "future-schedule-migrated",
  "communications-tested",
  "documents-ready",
  "aria-defaults-active",
  "final-reconciliation-complete",
  "go-live-approved",
]);

function sanitizeMilestoneSyncInput(
  milestones: OnboardingMilestoneSyncInput[],
) {
  return milestones
    .filter((milestone) => ALLOWED_ONBOARDING_MILESTONE_KEYS.has(milestone.key))
    .slice(0, 50)
    .map((milestone, index) => ({
      key: milestone.key,
      title: String(milestone.title || milestone.key).slice(0, 160),
      domain: String(milestone.domain || "essentials").slice(0, 80),
      complete: Boolean(milestone.complete),
      sequence: Number.isFinite(milestone.sequence)
        ? Math.max(0, Math.min(1000, Math.trunc(milestone.sequence)))
        : index,
    }));
}

export async function syncWorkspaceOnboardingProjectAction(
  input: OnboardingProjectSyncInput,
) {
  const checklistType = normalizeChecklistType(input.checklistType);
  const milestones = sanitizeMilestoneSyncInput(input.milestones ?? []);
  const readinessScore = Math.max(
    0,
    Math.min(100, Math.round(Number(input.readinessScore) || 0)),
  );
  const nextMilestoneKey =
    input.nextMilestoneKey &&
    ALLOWED_ONBOARDING_MILESTONE_KEYS.has(input.nextMilestoneKey)
      ? input.nextMilestoneKey
      : null;

  const supabase = await createClient();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    throw new Error("You must be signed in to synchronize onboarding progress.");
  }

  const context = await getCurrentStudioContext();
  const now = new Date().toISOString();
  const completedMilestones = milestones.filter(
    (milestone) => milestone.complete,
  ).length;
  const allComplete =
    milestones.length > 0 && completedMilestones === milestones.length;
  const currentPhase =
    milestones.find((milestone) => !milestone.complete)?.domain ?? "launch";

  const { data: project, error: projectError } = await supabase
    .from("onboarding_projects")
    .upsert(
      {
        studio_id: context.studioId,
        checklist_type: checklistType,
        status: allComplete ? "ready_for_launch" : "active",
        current_phase: currentPhase,
        readiness_score: readinessScore,
        next_milestone_key: nextMilestoneKey,
        assigned_owner_user_id: user.id,
        last_activity_at: now,
        updated_by: user.id,
        created_by: user.id,
        updated_at: now,
      },
      { onConflict: "studio_id,checklist_type" },
    )
    .select("id")
    .single<{ id: string }>();

  if (projectError || !project) {
    throw new Error(
      `Could not synchronize onboarding project: ${projectError?.message ?? "Unknown error."}`,
    );
  }

  if (milestones.length > 0) {
    const { error: milestoneError } = await supabase
      .from("onboarding_milestones")
      .upsert(
        milestones.map((milestone) => ({
          onboarding_project_id: project.id,
          studio_id: context.studioId,
          milestone_key: milestone.key,
          domain_key: milestone.domain,
          title: milestone.title,
          status: milestone.complete ? "completed" : "not_started",
          required_for_launch: true,
          sequence_number: milestone.sequence,
          evidence: { source: "workspace_activity" },
          completed_at: milestone.complete ? now : null,
          completed_by: milestone.complete ? user.id : null,
          updated_at: now,
        })),
        { onConflict: "onboarding_project_id,milestone_key" },
      );

    if (milestoneError) {
      throw new Error(
        `Could not synchronize onboarding milestones: ${milestoneError.message}`,
      );
    }
  }

  const { error: snapshotError } = await supabase
    .from("onboarding_readiness_snapshots")
    .insert({
      onboarding_project_id: project.id,
      studio_id: context.studioId,
      readiness_score: readinessScore,
      completed_milestones: completedMilestones,
      total_milestones: milestones.length,
      domain_scores: milestones.reduce<Record<string, { completed: number; total: number }>>(
        (scores, milestone) => {
          const current = scores[milestone.domain] ?? { completed: 0, total: 0 };
          current.total += 1;
          if (milestone.complete) current.completed += 1;
          scores[milestone.domain] = current;
          return scores;
        },
        {},
      ),
      snapshot_reason: "workspace_sync",
    });

  if (snapshotError) {
    throw new Error(
      `Could not record onboarding readiness: ${snapshotError.message}`,
    );
  }

  revalidatePath("/app");
  revalidatePath("/app/onboarding");
}


const ALLOWED_ONBOARDING_SOURCES = new Set([
  "new_studio",
  "mindbody",
  "wellnessliving",
  "pike13",
  "square",
  "vagaro",
  "studio_director",
  "spreadsheets",
  "other",
]);

export async function saveOnboardingPathAction(formData: FormData) {
  const checklistType = normalizeChecklistType(formData.get("checklistType"));
  const sourceInput = String(formData.get("sourceSystem") ?? "").trim();
  const sourceSystem = ALLOWED_ONBOARDING_SOURCES.has(sourceInput)
    ? sourceInput
    : "other";
  const onboardingMode = sourceSystem === "new_studio" ? "guided" : "assisted_migration";

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("You must be signed in to update onboarding.");

  const context = await getCurrentStudioContext();
  const now = new Date().toISOString();
  const { error } = await supabase.from("onboarding_projects").upsert(
    {
      studio_id: context.studioId,
      checklist_type: checklistType,
      source_system: sourceSystem,
      onboarding_mode: onboardingMode,
      status: "active",
      current_phase: sourceSystem === "new_studio" ? "essentials" : "migration",
      assigned_owner_user_id: user.id,
      last_activity_at: now,
      updated_by: user.id,
      created_by: user.id,
      updated_at: now,
    },
    { onConflict: "studio_id,checklist_type" },
  );

  if (error) throw new Error(`Could not update onboarding path: ${error.message}`);

  revalidatePath("/app/onboarding");
  revalidatePath("/app/settings/import");
}
