"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { isRedirectError } from "next/dist/client/components/redirect-error";
import { requireSettingsManageAccess } from "@/lib/auth/serverRoleGuard";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  createGustoDemoEmployee,
  getGustoCompany,
  gustoEnvironment,
  getGustoWorkers,
} from "@/lib/integrations/gusto/client";
import { getValidGustoAccessToken } from "@/lib/integrations/gusto/token";

async function gustoContext() {
  const { supabase, studioId } = await requireSettingsManageAccess();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) throw new Error("You must be signed in.");

  const { data: connection, error } = await supabase
    .from("studio_gusto_connections")
    .select(
      "id, status, gusto_company_uuid, gusto_company_name, environment",
    )
    .eq("studio_id", studioId)
    .maybeSingle();

  if (error || !connection) {
    throw new Error("Connect Gusto before managing this integration.");
  }

  return { supabase, studioId, userId: user.id, connection };
}

export async function checkGustoConnectionAction() {
  const { studioId, userId, connection } = await gustoContext();
  const admin = createAdminClient();

  if (
    connection.status !== "connected" ||
    !connection.gusto_company_uuid
  ) {
    redirect(
      "/app/settings/integrations/gusto?status=connection_unavailable",
    );
  }

  try {
    const token = await getValidGustoAccessToken(connection.id);
    const company = await getGustoCompany(
      token,
      connection.gusto_company_uuid,
    );
    const now = new Date().toISOString();

    await admin
      .from("studio_gusto_connections")
      .update({
        gusto_company_name: company.trade_name || company.name,
        last_health_check_at: now,
        last_health_status: "healthy",
        last_error: null,
        updated_at: now,
      })
      .eq("id", connection.id)
      .eq("studio_id", studioId);

    await admin.from("studio_gusto_audit_events").insert({
      studio_id: studioId,
      connection_id: connection.id,
      event_type: "connection_health_check",
      outcome: "succeeded",
      actor_user_id: userId,
      details: {},
    });

    revalidatePath("/app/settings/integrations");
    revalidatePath("/app/settings/integrations/gusto");
    redirect(
      "/app/settings/integrations/gusto?status=health_check_succeeded",
    );
  } catch (error) {
    if (isRedirectError(error)) throw error;

    const message =
      error instanceof Error
        ? error.message
        : "Gusto connection health check failed.";
    const admin = createAdminClient();

    await admin
      .from("studio_gusto_connections")
      .update({
        last_health_check_at: new Date().toISOString(),
        last_health_status: "failed",
        last_error: message,
        updated_at: new Date().toISOString(),
      })
      .eq("id", connection.id);

    await admin.from("studio_gusto_audit_events").insert({
      studio_id: studioId,
      connection_id: connection.id,
      event_type: "connection_health_check",
      outcome: "failed",
      actor_user_id: userId,
      details: { error: message },
    });

    revalidatePath("/app/settings/integrations/gusto");
    redirect(
      "/app/settings/integrations/gusto?status=health_check_failed",
    );
  }
}

export async function disconnectGustoAction() {
  const { supabase, studioId, userId, connection } =
    await gustoContext();
  const admin = createAdminClient();

  const { error: credentialError } = await admin
    .from("studio_gusto_credentials")
    .delete()
    .eq("connection_id", connection.id);

  if (credentialError) throw new Error(credentialError.message);

  const now = new Date().toISOString();
  const { error } = await admin
    .from("studio_gusto_connections")
    .update({
      status: "disconnected",
      gusto_company_uuid: null,
      gusto_company_name: null,
      scopes: [],
      disconnected_at: now,
      last_health_status: null,
      last_error: null,
      updated_at: now,
    })
    .eq("id", connection.id)
    .eq("studio_id", studioId);

  if (error) throw new Error(error.message);

  await admin.from("studio_gusto_audit_events").insert({
    studio_id: studioId,
    connection_id: connection.id,
    event_type: "disconnect",
    outcome: "succeeded",
    actor_user_id: userId,
    details: {},
  });

  revalidatePath("/app/settings/integrations");
  revalidatePath("/app/settings/integrations/gusto");
  redirect("/app/settings/integrations/gusto?status=disconnected");
}


function normalizedIdentity(value: string | null | undefined) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

export async function syncGustoWorkersAction() {
  const { studioId, userId, connection } = await gustoContext();
  if (connection.status !== "connected" || !connection.gusto_company_uuid) {
    redirect("/app/settings/integrations/gusto?status=connection_unavailable");
  }

  const admin = createAdminClient();
  try {
    const token = await getValidGustoAccessToken(connection.id);
    const workers = await getGustoWorkers(token, connection.gusto_company_uuid);
    const now = new Date().toISOString();

    const workerRows = workers.map((worker) => ({
      studio_id: studioId,
      connection_id: connection.id,
      gusto_worker_uuid: worker.uuid,
      gusto_worker_type: worker.worker_type,
      first_name: worker.first_name,
      last_name: worker.last_name,
      email: worker.email,
      active: worker.active,
      onboarding_status: worker.onboarding_status,
      synced_at: now,
      raw_summary: {},
    }));

    if (workerRows.length) {
      const { error } = await admin
        .from("studio_gusto_workers")
        .upsert(workerRows, { onConflict: "connection_id,gusto_worker_uuid" });
      if (error) throw new Error(error.message);
    }

    const { data: instructors, error: instructorError } = await admin
      .from("instructors")
      .select("id, first_name, last_name, email, active")
      .eq("studio_id", studioId)
      .eq("active", true);
    if (instructorError) throw new Error(instructorError.message);

    const { data: existingMatches, error: matchError } = await admin
      .from("studio_gusto_worker_matches")
      .select("instructor_id, gusto_worker_uuid")
      .eq("connection_id", connection.id);
    if (matchError) throw new Error(matchError.message);

    const matchedInstructorIds = new Set(
      (existingMatches ?? []).map((row) => String(row.instructor_id)),
    );
    const matchedWorkerIds = new Set(
      (existingMatches ?? []).map((row) => String(row.gusto_worker_uuid)),
    );

    const automaticMatches = [];
    for (const instructor of instructors ?? []) {
      if (matchedInstructorIds.has(String(instructor.id))) continue;
      const instructorName = normalizedIdentity(
        `${instructor.first_name ?? ""} ${instructor.last_name ?? ""}`,
      );
      const instructorEmail = normalizedIdentity(instructor.email);
      if (!instructorName || !instructorEmail) continue;

      const candidates = workers.filter((worker) =>
        !matchedWorkerIds.has(worker.uuid) &&
        normalizedIdentity(`${worker.first_name ?? ""} ${worker.last_name ?? ""}`) === instructorName &&
        normalizedIdentity(worker.email) === instructorEmail,
      );

      if (candidates.length === 1) {
        const worker = candidates[0];
        automaticMatches.push({
          studio_id: studioId,
          connection_id: connection.id,
          instructor_id: instructor.id,
          gusto_worker_uuid: worker.uuid,
          gusto_worker_type: worker.worker_type,
          match_status: "confirmed",
          match_method: "exact_name_email",
          matched_points: ["full_name", "email"],
          confirmed_by: userId,
          confirmed_at: now,
          updated_at: now,
        });
        matchedWorkerIds.add(worker.uuid);
      }
    }

    if (automaticMatches.length) {
      const { error } = await admin
        .from("studio_gusto_worker_matches")
        .upsert(automaticMatches, { onConflict: "connection_id,instructor_id" });
      if (error) throw new Error(error.message);
    }

    await admin.from("studio_gusto_audit_events").insert({
      studio_id: studioId,
      connection_id: connection.id,
      event_type: "worker_roster_sync",
      outcome: "succeeded",
      actor_user_id: userId,
      details: { workers: workers.length, automatic_matches: automaticMatches.length },
    });

    revalidatePath("/app/settings/integrations/gusto");
    redirect(`/app/settings/integrations/gusto?status=workers_synced&workers=${workers.length}&matched=${automaticMatches.length}`);
  } catch (error) {
    if (isRedirectError(error)) throw error;
    console.error("Gusto worker sync failed", error);
    redirect("/app/settings/integrations/gusto?status=worker_sync_failed");
  }
}

export async function saveGustoWorkerMatchAction(formData: FormData) {
  const { studioId, userId, connection } = await gustoContext();
  const instructorId = String(formData.get("instructorId") ?? "").trim();
  const workerUuid = String(formData.get("workerUuid") ?? "").trim();
  if (!instructorId || !workerUuid) {
    redirect("/app/settings/integrations/gusto?status=worker_match_invalid");
  }

  const admin = createAdminClient();
  const [{ data: instructor }, { data: worker }] = await Promise.all([
    admin.from("instructors").select("id, first_name, last_name, email").eq("id", instructorId).eq("studio_id", studioId).maybeSingle(),
    admin.from("studio_gusto_workers").select("gusto_worker_uuid, gusto_worker_type, first_name, last_name, email").eq("connection_id", connection.id).eq("gusto_worker_uuid", workerUuid).maybeSingle(),
  ]);
  if (!instructor || !worker) redirect("/app/settings/integrations/gusto?status=worker_match_invalid");

  const nameMatches = normalizedIdentity(`${instructor.first_name ?? ""} ${instructor.last_name ?? ""}`) === normalizedIdentity(`${worker.first_name ?? ""} ${worker.last_name ?? ""}`);
  const emailMatches = Boolean(instructor.email && worker.email) && normalizedIdentity(instructor.email) === normalizedIdentity(worker.email);
  const matchedPoints = [nameMatches ? "full_name" : null, emailMatches ? "email" : null].filter(Boolean);

  const { error } = await admin.from("studio_gusto_worker_matches").upsert({
    studio_id: studioId,
    connection_id: connection.id,
    instructor_id: instructorId,
    gusto_worker_uuid: workerUuid,
    gusto_worker_type: worker.gusto_worker_type,
    match_status: "confirmed",
    match_method: "manual",
    matched_points: matchedPoints,
    confirmed_by: userId,
    confirmed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }, { onConflict: "connection_id,instructor_id" });
  if (error) redirect("/app/settings/integrations/gusto?status=worker_match_failed");

  await admin.from("instructor_payroll_profiles").update({
    external_payroll_id: workerUuid,
    updated_by: userId,
    updated_at: new Date().toISOString(),
  }).eq("studio_id", studioId).eq("instructor_id", instructorId);

  revalidatePath("/app/settings/integrations/gusto");
  revalidatePath("/app/instructor-pay");
  redirect("/app/settings/integrations/gusto?status=worker_matched");
}

export async function clearGustoWorkerMatchAction(formData: FormData) {
  const { studioId, connection } = await gustoContext();
  const instructorId = String(formData.get("instructorId") ?? "").trim();
  if (!instructorId) redirect("/app/settings/integrations/gusto?status=worker_match_invalid");
  const admin = createAdminClient();
  await admin.from("studio_gusto_worker_matches").delete().eq("connection_id", connection.id).eq("instructor_id", instructorId);
  await admin.from("instructor_payroll_profiles").update({ external_payroll_id: null, updated_at: new Date().toISOString() }).eq("studio_id", studioId).eq("instructor_id", instructorId);
  revalidatePath("/app/settings/integrations/gusto");
  revalidatePath("/app/instructor-pay");
  redirect("/app/settings/integrations/gusto?status=worker_match_cleared");
}


export async function createGustoDemoWorkerAction(formData: FormData) {
  const { studioId, userId, connection } = await gustoContext();
  const instructorId = String(formData.get("instructorId") ?? "").trim();

  if (
    gustoEnvironment() !== "demo" ||
    connection.environment !== "demo"
  ) {
    redirect("/app/settings/integrations/gusto?status=demo_worker_forbidden");
  }
  if (!connection.gusto_company_uuid || !instructorId) {
    redirect("/app/settings/integrations/gusto?status=demo_worker_invalid");
  }

  const admin = createAdminClient();
  const { data: instructor, error: instructorError } = await admin
    .from("instructors")
    .select("id, first_name, last_name, email")
    .eq("studio_id", studioId)
    .eq("id", instructorId)
    .maybeSingle();

  if (instructorError || !instructor) {
    redirect("/app/settings/integrations/gusto?status=demo_worker_invalid");
  }

  const firstName = String(instructor.first_name ?? "").trim();
  const lastName = String(instructor.last_name ?? "").trim();
  const email = String(instructor.email ?? "").trim();
  if (!firstName || !lastName || !email) {
    redirect("/app/settings/integrations/gusto?status=demo_worker_missing_identity");
  }

  try {
    const token = await getValidGustoAccessToken(connection.id);
    let employee;
    let createdEmail = email;
    let usedAlias = false;

    try {
      employee = await createGustoDemoEmployee(
        token,
        connection.gusto_company_uuid,
        { firstName, lastName, email },
      );
    } catch (creationError) {
      const message =
        creationError instanceof Error ? creationError.message : "";

      if (!message.includes("You already have a team member with this email")) {
        throw creationError;
      }

      const [localPart, domain] = email.split("@");
      if (!localPart || !domain) throw creationError;

      createdEmail = `${localPart}+danceflow-gusto-${instructorId.slice(0, 8)}@${domain}`;
      usedAlias = true;

      employee = await createGustoDemoEmployee(
        token,
        connection.gusto_company_uuid,
        { firstName, lastName, email: createdEmail },
      );
    }

    await admin.from("studio_gusto_audit_events").insert({
      studio_id: studioId,
      connection_id: connection.id,
      event_type: "demo_worker_created",
      outcome: "succeeded",
      actor_user_id: userId,
      details: {
        instructor_id: instructorId,
        gusto_worker_uuid: employee.uuid ?? employee.id ?? null,
        used_email_alias: usedAlias,
        created_email: createdEmail,
      },
    });

    revalidatePath("/app/settings/integrations/gusto");
    redirect("/app/settings/integrations/gusto?status=demo_worker_created");
  } catch (error) {
    if (isRedirectError(error)) throw error;
    const message = error instanceof Error ? error.message : "Gusto demo worker creation failed.";
    console.error("Gusto demo worker creation failed", error);
    await admin.from("studio_gusto_audit_events").insert({
      studio_id: studioId,
      connection_id: connection.id,
      event_type: "demo_worker_created",
      outcome: "failed",
      actor_user_id: userId,
      details: { instructor_id: instructorId, error: message },
    });
    redirect("/app/settings/integrations/gusto?status=demo_worker_failed");
  }
}
