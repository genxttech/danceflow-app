import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCronAuthFailure } from "@/lib/security/cron";
import { runScheduledAriaOperationsForStudio } from "@/app/app/automations/actions";

type WorkspaceRoleRow = {
  studio_id: string;
  user_id: string;
  role: string | null;
};

type OrganizerRow = {
  id: string;
  studio_id: string;
};

type OrganizerUserRow = {
  organizer_id: string;
  user_id: string;
  role: string | null;
};

function runBucket(now: Date) {
  const bucket = new Date(now);
  bucket.setUTCMinutes(bucket.getUTCMinutes() < 30 ? 0 : 30, 0, 0);
  return bucket.toISOString();
}

function preferredActor(
  studioRoles: WorkspaceRoleRow[],
  organizerUsers: OrganizerUserRow[],
) {
  const roleRank = (role: string | null) => {
    if (role === "owner" || role === "organizer_owner") return 1;
    if (role === "admin" || role === "organizer_admin") return 2;
    return 3;
  };

  return [...studioRoles, ...organizerUsers]
    .filter((row) => row.user_id)
    .sort((a, b) => roleRank(a.role) - roleRank(b.role))[0]?.user_id ?? null;
}

async function handleRequest(request: NextRequest) {
  const authFailure = getCronAuthFailure(request);
  if (authFailure) return authFailure;

  const adminSupabase = createAdminClient();
  const now = new Date();
  const bucket = runBucket(now);

  const [
    { data: studioRoles, error: studioRolesError },
    { data: organizers, error: organizersError },
  ] = await Promise.all([
    adminSupabase
      .from("user_studio_roles")
      .select("studio_id, user_id, role")
      .eq("active", true),
    adminSupabase.from("organizers").select("id, studio_id"),
  ]);

  if (studioRolesError || organizersError) {
    return NextResponse.json(
      {
        error:
          studioRolesError?.message ||
          organizersError?.message ||
          "Failed to load ARIA workspaces.",
      },
      { status: 500 },
    );
  }

  const typedStudioRoles = (studioRoles ?? []) as WorkspaceRoleRow[];
  const typedOrganizers = (organizers ?? []) as OrganizerRow[];
  const organizerIds = typedOrganizers.map((organizer) => organizer.id);

  const { data: organizerUsers, error: organizerUsersError } =
    organizerIds.length > 0
      ? await adminSupabase
          .from("organizer_users")
          .select("organizer_id, user_id, role")
          .in("organizer_id", organizerIds)
          .eq("active", true)
      : { data: [], error: null };

  if (organizerUsersError) {
    return NextResponse.json(
      { error: organizerUsersError.message },
      { status: 500 },
    );
  }

  const typedOrganizerUsers = (organizerUsers ?? []) as OrganizerUserRow[];
  const organizerById = new Map(
    typedOrganizers.map((organizer) => [organizer.id, organizer]),
  );
  const studioIds = Array.from(
    new Set([
      ...typedStudioRoles.map((row) => row.studio_id),
      ...typedOrganizers.map((row) => row.studio_id),
    ]),
  );

  const totals = {
    workspaces: studioIds.length,
    processed: 0,
    locked: 0,
    skipped: 0,
    failed: 0,
    candidates: 0,
    created: 0,
    updated: 0,
    queued: 0,
    executionSkipped: 0,
    executionFailed: 0,
  };

  for (const studioId of studioIds) {
    const rolesForStudio = typedStudioRoles.filter(
      (row) => row.studio_id === studioId,
    );
    const organizerIdsForStudio = typedOrganizers
      .filter((organizer) => organizer.studio_id === studioId)
      .map((organizer) => organizer.id);
    const organizerUsersForStudio = typedOrganizerUsers.filter((row) =>
      organizerIdsForStudio.includes(row.organizer_id),
    );
    const actorUserId = preferredActor(
      rolesForStudio,
      organizerUsersForStudio,
    );

    if (!actorUserId) {
      totals.skipped += 1;
      continue;
    }

    const { data: lock, error: lockError } = await adminSupabase
      .from("aria_operations_runs")
      .insert({
        studio_id: studioId,
        run_bucket: bucket,
        status: "running",
        started_at: now.toISOString(),
      })
      .select("id")
      .maybeSingle<{ id: string }>();

    if (lockError) {
      if (lockError.code === "23505") {
        totals.locked += 1;
        continue;
      }

      totals.failed += 1;
      console.error("ARIA scheduled run lock failed", {
        studioId,
        error: lockError,
      });
      continue;
    }

    if (!lock?.id) {
      totals.locked += 1;
      continue;
    }

    try {
      const result = await runScheduledAriaOperationsForStudio({
        studioId,
        actorUserId,
        includeStudioSignals: rolesForStudio.length > 0,
        includeOrganizerSignals: organizerUsersForStudio.length > 0,
      });

      totals.processed += 1;
      totals.candidates += result.candidatesCount;
      totals.created += result.createdCount;
      totals.updated += result.updatedCount;
      totals.queued += result.queuedCount;
      totals.executionSkipped += result.skippedCount;
      totals.executionFailed += result.failedCount;

      await adminSupabase
        .from("aria_operations_runs")
        .update({
          status: result.failedCount > 0 ? "completed_with_errors" : "completed",
          summary: result,
          finished_at: new Date().toISOString(),
        })
        .eq("id", lock.id);
    } catch (error) {
      totals.failed += 1;
      const message =
        error instanceof Error
          ? error.message
          : "Scheduled ARIA operations failed";

      console.error("Scheduled ARIA operations failed", {
        studioId,
        error,
      });

      await adminSupabase
        .from("aria_operations_runs")
        .update({
          status: "failed",
          error_message: message.slice(0, 1000),
          finished_at: new Date().toISOString(),
        })
        .eq("id", lock.id);
    }
  }

  return NextResponse.json({
    ok: totals.failed === 0,
    evaluatedAt: now.toISOString(),
    runBucket: bucket,
    totals,
  });
}

export async function GET(request: NextRequest) {
  return handleRequest(request);
}

export async function POST(request: NextRequest) {
  return handleRequest(request);
}
