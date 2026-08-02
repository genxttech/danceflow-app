"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { isRedirectError } from "next/dist/client/components/redirect-error";
import { createAdminClient } from "@/lib/supabase/admin";
import { getValidGustoAccessToken } from "@/lib/integrations/gusto/token";
import {
  createGustoEmployeeJob,
  createGustoPayrollSync,
  approveGustoTimeSheet,
  createGustoTimeSheet,
  getGustoPayrollEmployees,
  getGustoPayrollSync,
  getGustoTimeSheet,
  getGustoUnprocessedPayrolls,
  gustoEnvironment,
  findGustoTimeSheetByDanceFlowKey,
  getGustoEmployeeJobs,
  getGustoPayPeriods,
  getGustoPaySchedules,
  type GustoTimeSheetPayload,
} from "@/lib/integrations/gusto/client";
import {
  requirePayrollDisbursementAccess,
  requirePayrollPrepareAccess,
} from "@/lib/auth/serverRoleGuard";

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function go(payPeriodId: string, status: string): never {
  redirect(
    `/app/instructor-pay/periods/${encodeURIComponent(payPeriodId)}?status=${encodeURIComponent(status)}`,
  );
}

type PeriodOperation = "assign" | "remove" | "approve" | "void";

function periodErrorStatus(operation: PeriodOperation, error: unknown) {
  const message =
    typeof error === "object" && error && "message" in error
      ? String(error.message).toLowerCase()
      : "";

  if (message.includes("pay period not found")) return "pay_period_not_found";
  if (message.includes("only open or in-review periods can receive earnings")) return "pay_period_closed";
  if (message.includes("only open or in-review periods can be changed")) return "pay_period_closed";
  if (message.includes("earning not found")) return "earning_not_found";
  if (message.includes("only pending or approved earnings can be assigned")) return "earning_not_assignable";
  if (message.includes("batched earnings cannot be reassigned")) return "earning_already_batched";
  if (message.includes("already assigned to another pay period")) return "earning_assigned_elsewhere";
  if (message.includes("falls outside the pay-period dates")) return "earning_outside_period";
  if (message.includes("assigned earning not found")) return "assigned_earning_not_found";
  if (message.includes("batched earnings cannot be removed")) return "earning_already_batched";
  if (message.includes("only the studio owner can void")) return "owner_required_to_void";
  if (message.includes("remove all unbatched earnings before voiding")) return "period_not_empty";
  if (message.includes("only an open or in-review pay period can be voided")) return "period_not_voidable";
  if (message.includes("payroll access denied")) return "payroll_access_denied";

  return {
    assign: "assign_failed",
    remove: "remove_failed",
    approve: "approve_failed",
    void: "void_failed",
  }[operation];
}

function logPeriodError(operation: PeriodOperation, error: unknown) {
  const safeError =
    typeof error === "object" && error
      ? {
          message: "message" in error ? String(error.message) : "Unknown error",
          code: "code" in error ? String(error.code) : undefined,
          details: "details" in error ? String(error.details) : undefined,
          hint: "hint" in error ? String(error.hint) : undefined,
        }
      : { message: String(error) };
  console.error(`[Instructor Pay Period] ${operation} failed`, safeError);
}

export async function assignSingleEarningAction(formData: FormData) {
  const payPeriodId = getString(formData, "payPeriodId");
  try {
    const earningId = getString(formData, "earningId");
    if (!payPeriodId || !earningId) go(payPeriodId || "missing", "missing_earning");

    const { supabase, studioId } = await requirePayrollPrepareAccess();
    const { error } = await supabase.rpc("assign_single_earning_to_pay_period", {
      p_studio_id: studioId,
      p_pay_period_id: payPeriodId,
      p_earning_id: earningId,
    });

    if (error) {
      logPeriodError("assign", error);
      go(payPeriodId, periodErrorStatus("assign", error));
    }
    revalidatePath("/app/instructor-pay");
    revalidatePath(`/app/instructor-pay/periods/${payPeriodId}`);
    go(payPeriodId, "earning_assigned");
  } catch (error) {
    if (isRedirectError(error)) throw error;
    logPeriodError("assign", error);
    go(payPeriodId || "missing", periodErrorStatus("assign", error));
  }
}

export async function removeEarningFromPeriodAction(formData: FormData) {
  const payPeriodId = getString(formData, "payPeriodId");
  try {
    const earningId = getString(formData, "earningId");
    if (!payPeriodId || !earningId) go(payPeriodId || "missing", "missing_earning");

    const { supabase, studioId } = await requirePayrollPrepareAccess();
    const { error } = await supabase.rpc("remove_earning_from_pay_period", {
      p_studio_id: studioId,
      p_pay_period_id: payPeriodId,
      p_earning_id: earningId,
    });

    if (error) {
      logPeriodError("remove", error);
      go(payPeriodId, periodErrorStatus("remove", error));
    }
    revalidatePath("/app/instructor-pay");
    revalidatePath(`/app/instructor-pay/periods/${payPeriodId}`);
    go(payPeriodId, "earning_removed");
  } catch (error) {
    if (isRedirectError(error)) throw error;
    logPeriodError("remove", error);
    go(payPeriodId || "missing", periodErrorStatus("remove", error));
  }
}

export async function approvePeriodEarningAction(formData: FormData) {
  const payPeriodId = getString(formData, "payPeriodId");
  try {
    const earningId = getString(formData, "earningId");
    if (!payPeriodId || !earningId) go(payPeriodId || "missing", "missing_earning");

    const { supabase, studioId, user } = await requirePayrollPrepareAccess();
    const { data, error } = await supabase
      .from("instructor_earnings")
      .update({
        status: "approved",
        approved_at: new Date().toISOString(),
        approved_by: user.id,
        updated_at: new Date().toISOString(),
      })
      .eq("id", earningId)
      .eq("studio_id", studioId)
      .eq("pay_period_id", payPeriodId)
      .is("payroll_batch_id", null)
      .eq("status", "pending")
      .select("id")
      .maybeSingle();

    if (error) {
      logPeriodError("approve", error);
      go(payPeriodId, periodErrorStatus("approve", error));
    }
    if (!data) go(payPeriodId, "earning_not_approvable");

    revalidatePath("/app/instructor-pay");
    revalidatePath(`/app/instructor-pay/periods/${payPeriodId}`);
    go(payPeriodId, "earning_approved");
  } catch (error) {
    if (isRedirectError(error)) throw error;
    logPeriodError("approve", error);
    go(payPeriodId || "missing", periodErrorStatus("approve", error));
  }
}

export async function voidEmptyPayPeriodAction(formData: FormData) {
  const payPeriodId = getString(formData, "payPeriodId");
  try {
    const reason = getString(formData, "reason");
    if (!payPeriodId) go("missing", "missing_pay_period");

    const { supabase, studioId } = await requirePayrollDisbursementAccess();
    const { error } = await supabase.rpc("void_empty_payroll_pay_period", {
      p_studio_id: studioId,
      p_pay_period_id: payPeriodId,
      p_reason: reason || null,
    });

    if (error) {
      logPeriodError("void", error);
      go(payPeriodId, periodErrorStatus("void", error));
    }
    revalidatePath("/app/instructor-pay");
    redirect("/app/instructor-pay?status=pay_period_voided");
  } catch (error) {
    if (isRedirectError(error)) throw error;
    logPeriodError("void", error);
    go(payPeriodId || "missing", periodErrorStatus("void", error));
  }
}


export async function generateGustoReadinessAction(formData: FormData) {
  const payPeriodId = getString(formData, "payPeriodId");
  try {
    if (!payPeriodId) go("missing", "missing_pay_period");
    const { supabase, studioId, user } = await requirePayrollPrepareAccess();
    const admin = createAdminClient();

    const [{ data: period }, { data: connection }] = await Promise.all([
      supabase
        .from("payroll_pay_periods")
        .select("id, period_start, period_end")
        .eq("studio_id", studioId)
        .eq("id", payPeriodId)
        .maybeSingle(),
      supabase
        .from("studio_gusto_connections")
        .select("id, status, gusto_company_uuid")
        .eq("studio_id", studioId)
        .maybeSingle(),
    ]);

    if (!period) go(payPeriodId, "pay_period_not_found");
    if (!connection || connection.status !== "connected" || !connection.gusto_company_uuid) {
      go(payPeriodId, "gusto_not_connected");
    }

    const { data: earnings, error: earningsError } = await admin
      .from("instructor_earnings")
      .select("id, instructor_id, appointment_id, source_type, earning_date, status, worker_classification_snapshot")
      .eq("studio_id", studioId)
      .eq("pay_period_id", payPeriodId)
      .eq("status", "approved")
      .is("payroll_batch_id", null);
    if (earningsError) throw earningsError;

    const instructorIds = Array.from(new Set((earnings ?? []).map((row) => row.instructor_id)));
    const { data: matches, error: matchError } = instructorIds.length
      ? await admin
          .from("studio_gusto_worker_matches")
          .select("instructor_id, gusto_worker_uuid, gusto_worker_type, match_status")
          .eq("connection_id", connection.id)
          .eq("match_status", "confirmed")
          .in("instructor_id", instructorIds)
      : { data: [], error: null };
    if (matchError) throw matchError;

    const token = await getValidGustoAccessToken(connection.id);
    const [paySchedules, gustoPayPeriods] = await Promise.all([
      getGustoPaySchedules(token, connection.gusto_company_uuid),
      getGustoPayPeriods(token, connection.gusto_company_uuid, period.period_start, period.period_end),
    ]);

    await admin.from("studio_gusto_pay_schedules").delete().eq("connection_id", connection.id);
    if (paySchedules.length) {
      await admin.from("studio_gusto_pay_schedules").insert(paySchedules.map((schedule) => ({
        studio_id: studioId,
        connection_id: connection.id,
        gusto_pay_schedule_uuid: schedule.uuid,
        name: schedule.name,
        frequency: schedule.frequency,
        active: schedule.active,
        synced_at: new Date().toISOString(),
        raw_summary: {},
      })));
    }

    await admin.from("studio_gusto_pay_periods").delete().eq("connection_id", connection.id);
    if (gustoPayPeriods.length) {
      await admin.from("studio_gusto_pay_periods").insert(gustoPayPeriods.map((item) => ({
        studio_id: studioId,
        connection_id: connection.id,
        gusto_pay_period_uuid: item.uuid,
        gusto_pay_schedule_uuid: item.pay_schedule_uuid,
        period_start: item.start_date,
        period_end: item.end_date,
        pay_date: item.pay_date,
        synced_at: new Date().toISOString(),
        raw_summary: {},
      })));
    }

    const matchByInstructor = new Map((matches ?? []).map((row) => [row.instructor_id, row]));
    const employeeMatches = (matches ?? []).filter((row) => row.gusto_worker_type === "employee");
    const jobsByWorker = new Map<string, Awaited<ReturnType<typeof getGustoEmployeeJobs>>>();
    for (const match of employeeMatches) {
      const jobs = await getGustoEmployeeJobs(token, match.gusto_worker_uuid);
      jobsByWorker.set(match.gusto_worker_uuid, jobs);
      await admin.from("studio_gusto_worker_jobs").delete().eq("connection_id", connection.id).eq("gusto_worker_uuid", match.gusto_worker_uuid);
      if (jobs.length) {
        await admin.from("studio_gusto_worker_jobs").insert(jobs.map((job) => ({
          studio_id: studioId,
          connection_id: connection.id,
          gusto_worker_uuid: match.gusto_worker_uuid,
          gusto_job_uuid: job.uuid,
          title: job.title,
          active: job.active,
          hire_date: job.hire_date,
          termination_date: job.termination_date,
          synced_at: new Date().toISOString(),
          raw_summary: {},
        })));
      }
    }

    const alignedPeriod = gustoPayPeriods.some((item) =>
      item.start_date === period.period_start && item.end_date === period.period_end,
    );
    const itemRows = (earnings ?? []).map((earning) => {
      const match = matchByInstructor.get(earning.instructor_id);
      const jobs = match?.gusto_worker_type === "employee"
        ? jobsByWorker.get(match.gusto_worker_uuid) ?? []
        : [];
      const activeJob = jobs.find((job) => job.active) ?? null;
      const blockers: string[] = [];
      if (!match) blockers.push("worker_not_matched");
      if (match?.gusto_worker_type === "contractor") blockers.push("contractor_not_supported_in_time_preview");
      if (earning.source_type !== "appointment" || !earning.appointment_id) blockers.push("shift_source_missing");
      if (match?.gusto_worker_type === "employee" && !activeJob) blockers.push("gusto_job_missing");
      if (!alignedPeriod) blockers.push("gusto_pay_period_not_aligned");
      return {
        earning,
        match,
        activeJob,
        blockers,
      };
    });

    const blocked = itemRows.filter((item) => item.blockers.length > 0).length;
    const { data: review, error: reviewError } = await admin
      .from("studio_gusto_readiness_reviews")
      .insert({
        studio_id: studioId,
        connection_id: connection.id,
        pay_period_id: payPeriodId,
        status: blocked ? "blocked" : "ready",
        earning_count: itemRows.length,
        ready_count: itemRows.length - blocked,
        blocker_count: blocked,
        summary: {
          pay_schedules: paySchedules.length,
          aligned_pay_period: alignedPeriod,
          matched_workers: matches?.length ?? 0,
        },
        reviewed_by: user.id,
        reviewed_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    if (reviewError || !review) throw reviewError ?? new Error("Readiness review was not created.");

    if (itemRows.length) {
      const { error: itemError } = await admin.from("studio_gusto_readiness_items").insert(itemRows.map((item) => ({
        review_id: review.id,
        studio_id: studioId,
        earning_id: item.earning.id,
        instructor_id: item.earning.instructor_id,
        gusto_worker_uuid: item.match?.gusto_worker_uuid ?? null,
        gusto_job_uuid: item.activeJob?.uuid ?? null,
        readiness_status: item.blockers.length ? "blocked" : "ready",
        blocker_codes: item.blockers,
        details: { earning_date: item.earning.earning_date, source_type: item.earning.source_type },
      })));
      if (itemError) throw itemError;
    }

    await admin.from("studio_gusto_audit_events").insert({
      studio_id: studioId,
      connection_id: connection.id,
      event_type: "payroll_readiness_review",
      outcome: blocked ? "blocked" : "succeeded",
      actor_user_id: user.id,
      details: { pay_period_id: payPeriodId, earnings: itemRows.length, blockers: blocked },
    });

    revalidatePath(`/app/instructor-pay/periods/${payPeriodId}`);
    go(payPeriodId, blocked ? "gusto_readiness_blocked" : "gusto_readiness_ready");
  } catch (error) {
    if (isRedirectError(error)) throw error;
    console.error("[Instructor Pay Period] Gusto readiness failed", error);
    go(payPeriodId || "missing", "gusto_readiness_failed");
  }
}


export async function generateGustoTimeSheetPreviewAction(formData: FormData) {
  const payPeriodId = getString(formData, "payPeriodId");

  try {
    if (!payPeriodId) go("missing", "missing_pay_period");

    const { supabase, studioId, user } = await requirePayrollPrepareAccess();
    const admin = createAdminClient();

    const [{ data: connection }, { data: studio }, { data: review }] =
      await Promise.all([
        supabase
          .from("studio_gusto_connections")
          .select("id, status")
          .eq("studio_id", studioId)
          .maybeSingle(),
        supabase
          .from("studios")
          .select("timezone")
          .eq("id", studioId)
          .maybeSingle(),
        supabase
          .from("studio_gusto_readiness_reviews")
          .select("id, status, earning_count, blocker_count")
          .eq("studio_id", studioId)
          .eq("pay_period_id", payPeriodId)
          .order("reviewed_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);

    if (!connection || connection.status !== "connected") {
      go(payPeriodId, "gusto_not_connected");
    }

    if (!review || review.status !== "ready" || review.blocker_count > 0) {
      go(payPeriodId, "gusto_preview_requires_readiness");
    }

    const timeZone = studio?.timezone || "America/New_York";

    const { data: readinessItems, error: readinessError } = await admin
      .from("studio_gusto_readiness_items")
      .select(
        "earning_id, instructor_id, gusto_worker_uuid, gusto_job_uuid, readiness_status",
      )
      .eq("review_id", review.id)
      .eq("readiness_status", "ready");

    if (readinessError) throw readinessError;

    const earningIds = (readinessItems ?? []).map((item) => item.earning_id);
    const { data: earnings, error: earningsError } = earningIds.length
      ? await admin
          .from("instructor_earnings")
          .select("id, appointment_id")
          .eq("studio_id", studioId)
          .in("id", earningIds)
      : { data: [], error: null };

    if (earningsError) throw earningsError;

    const appointmentIds = Array.from(
      new Set(
        (earnings ?? [])
          .map((earning) => earning.appointment_id)
          .filter((value): value is string => Boolean(value)),
      ),
    );

    const { data: appointments, error: appointmentsError } = appointmentIds.length
      ? await admin
          .from("appointments")
          .select("id, starts_at, ends_at, duration_minutes")
          .eq("studio_id", studioId)
          .in("id", appointmentIds)
      : { data: [], error: null };

    if (appointmentsError) throw appointmentsError;

    const earningById = new Map((earnings ?? []).map((row) => [row.id, row]));
    const appointmentById = new Map(
      (appointments ?? []).map((row) => [row.id, row]),
    );

    const rows = (readinessItems ?? []).map((item) => {
      const earning = earningById.get(item.earning_id);
      const appointment = earning?.appointment_id
        ? appointmentById.get(earning.appointment_id)
        : null;

      const blockers: string[] = [];
      if (!appointment) blockers.push("appointment_missing");

      const startedAt = appointment?.starts_at ?? null;
      const endedAt = appointment?.ends_at ?? null;

      if (!startedAt) blockers.push("shift_start_missing");
      if (!endedAt) blockers.push("shift_end_missing");

      const startMs = startedAt ? new Date(startedAt).getTime() : Number.NaN;
      const endMs = endedAt ? new Date(endedAt).getTime() : Number.NaN;
      const nowMs = Date.now();

      if (Number.isFinite(startMs) && startMs >= nowMs) {
        blockers.push("shift_not_started");
      }

      if (Number.isFinite(endMs) && endMs > nowMs) {
        blockers.push("shift_not_completed");
      }

      const calculatedMinutes =
        Number.isFinite(startMs) &&
        Number.isFinite(endMs) &&
        endMs > startMs
          ? Math.round((endMs - startMs) / 60000)
          : Number(appointment?.duration_minutes ?? 0);

      if (!Number.isFinite(calculatedMinutes) || calculatedMinutes <= 0) {
        blockers.push("shift_duration_invalid");
      }

      const hoursWorked =
        calculatedMinutes > 0
          ? Math.round((calculatedMinutes / 60) * 100) / 100
          : null;

      const payload =
        blockers.length === 0
          ? {
              entity_uuid: item.gusto_worker_uuid,
              entity_type: "Employee",
              job_uuid: item.gusto_job_uuid,
              time_zone: timeZone,
              shift_started_at: startedAt,
              shift_ended_at: endedAt,
              entries: [
                {
                  hours_worked: hoursWorked,
                  pay_classification: "Regular",
                },
              ],
              metadata: {
                danceflow_earning_id: item.earning_id,
                danceflow_appointment_id: earning?.appointment_id ?? "",
                danceflow_pay_period_id: payPeriodId,
              },
            }
          : {};

      return {
        item,
        earning,
        startedAt,
        endedAt,
        hoursWorked,
        blockers,
        payload,
      };
    });

    const blocked = rows.filter((row) => row.blockers.length > 0).length;
    const totalHours = rows.reduce(
      (sum, row) => sum + Number(row.hoursWorked ?? 0),
      0,
    );

    const { data: preview, error: previewError } = await admin
      .from("studio_gusto_time_sheet_previews")
      .insert({
        studio_id: studioId,
        connection_id: connection.id,
        pay_period_id: payPeriodId,
        readiness_review_id: review.id,
        status: blocked ? "blocked" : "ready",
        shift_count: rows.length,
        ready_count: rows.length - blocked,
        blocker_count: blocked,
        total_hours: Math.round(totalHours * 100) / 100,
        time_zone: timeZone,
        summary: {
          classification: "Regular",
          source: "appointment",
          transmission_status: "preview_only",
        },
        prepared_by: user.id,
        prepared_at: new Date().toISOString(),
      })
      .select("id")
      .single();

    if (previewError || !preview) {
      throw previewError ?? new Error("Gusto preview was not created.");
    }

    if (rows.length) {
      const { error: itemError } = await admin
        .from("studio_gusto_time_sheet_preview_items")
        .insert(
          rows.map((row) => ({
            preview_id: preview.id,
            studio_id: studioId,
            earning_id: row.item.earning_id,
            appointment_id: row.earning?.appointment_id ?? null,
            instructor_id: row.item.instructor_id,
            gusto_worker_uuid: row.item.gusto_worker_uuid,
            gusto_job_uuid: row.item.gusto_job_uuid,
            entity_type: "Employee",
            time_zone: timeZone,
            shift_started_at: row.startedAt,
            shift_ended_at: row.endedAt,
            hours_worked: row.hoursWorked,
            pay_classification: "Regular",
            preview_status: row.blockers.length ? "blocked" : "ready",
            blocker_codes: row.blockers,
            payload_preview: row.payload,
          })),
        );

      if (itemError) throw itemError;
    }

    await admin.from("studio_gusto_audit_events").insert({
      studio_id: studioId,
      connection_id: connection.id,
      event_type: "time_sheet_preview_prepared",
      outcome: blocked ? "blocked" : "succeeded",
      actor_user_id: user.id,
      details: {
        pay_period_id: payPeriodId,
        shifts: rows.length,
        blockers: blocked,
        total_hours: Math.round(totalHours * 100) / 100,
        transmission_status: "preview_only",
      },
    });

    revalidatePath(`/app/instructor-pay/periods/${payPeriodId}`);
    go(
      payPeriodId,
      blocked ? "gusto_preview_blocked" : "gusto_preview_ready",
    );
  } catch (error) {
    if (isRedirectError(error)) throw error;
    console.error("[Instructor Pay Period] Gusto preview failed", error);
    go(payPeriodId || "missing", "gusto_preview_failed");
  }
}


function deliveryFingerprint(previewItemId: string, payload: unknown) {
  const raw = JSON.stringify({ previewItemId, payload });
  let hash = 2166136261;
  for (let index = 0; index < raw.length; index += 1) {
    hash ^= raw.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `df-${previewItemId}-${(hash >>> 0).toString(16)}`;
}

export async function sendGustoTimeSheetsAction(formData: FormData) {
  const payPeriodId = getString(formData, "payPeriodId");

  try {
    if (!payPeriodId) go("missing", "missing_pay_period");
    if (getString(formData, "confirmation") !== "send") {
      go(payPeriodId, "gusto_send_confirmation_required");
    }

    const { supabase, studioId, user } =
      await requirePayrollDisbursementAccess();
    const admin = createAdminClient();

    const [{ data: connection }, { data: preview }] = await Promise.all([
      supabase
        .from("studio_gusto_connections")
        .select("id, status, gusto_company_uuid")
        .eq("studio_id", studioId)
        .maybeSingle(),
      supabase
        .from("studio_gusto_time_sheet_previews")
        .select("id, status, blocker_count, shift_count")
        .eq("studio_id", studioId)
        .eq("pay_period_id", payPeriodId)
        .order("prepared_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);

    if (
      !connection ||
      connection.status !== "connected" ||
      !connection.gusto_company_uuid
    ) {
      go(payPeriodId, "gusto_not_connected");
    }

    if (!preview || preview.status !== "ready" || preview.blocker_count > 0) {
      go(payPeriodId, "gusto_send_requires_ready_preview");
    }

    const { data: previewItems, error: previewItemsError } = await admin
      .from("studio_gusto_time_sheet_preview_items")
      .select(
        "id, earning_id, gusto_worker_uuid, preview_status, payload_preview",
      )
      .eq("preview_id", preview.id)
      .eq("preview_status", "ready")
      .order("created_at", { ascending: true });

    if (previewItemsError) throw previewItemsError;
    if (!previewItems?.length) {
      go(payPeriodId, "gusto_send_requires_ready_preview");
    }

    let transmission: { id: string; status: string } | null = null;

    const { data: existingTransmission } = await admin
      .from("studio_gusto_time_sheet_transmissions")
      .select("id, status")
      .eq("preview_id", preview.id)
      .maybeSingle();

    if (existingTransmission?.status === "succeeded") {
      go(payPeriodId, "gusto_time_sheets_already_sent");
    }

    if (existingTransmission) {
      const { data, error } = await admin
        .from("studio_gusto_time_sheet_transmissions")
        .update({
          status: "sending",
          item_count: previewItems.length,
          failed_count: 0,
          skipped_count: 0,
          last_error: null,
          completed_at: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", existingTransmission.id)
        .select("id, status")
        .single();

      if (error) throw error;
      transmission = data;
    } else {
      const { data, error } = await admin
        .from("studio_gusto_time_sheet_transmissions")
        .insert({
          studio_id: studioId,
          connection_id: connection.id,
          pay_period_id: payPeriodId,
          preview_id: preview.id,
          status: "sending",
          item_count: previewItems.length,
          initiated_by: user.id,
          initiated_at: new Date().toISOString(),
        })
        .select("id, status")
        .single();

      if (error) throw error;
      transmission = data;
    }

    const token = await getValidGustoAccessToken(connection.id);
    let sent = 0;
    let failed = 0;
    let skipped = 0;
    const errors: string[] = [];

    for (const item of previewItems) {
      const payload = item.payload_preview as GustoTimeSheetPayload;
      const fingerprint = deliveryFingerprint(item.id, payload);
      const deliveryKey = fingerprint;

      const { data: priorItem } = await admin
        .from("studio_gusto_time_sheet_transmission_items")
        .select("id, status, gusto_time_sheet_uuid, attempt_count")
        .eq("preview_item_id", item.id)
        .maybeSingle();

      if (
        priorItem &&
        ["succeeded", "reconciled"].includes(priorItem.status) &&
        priorItem.gusto_time_sheet_uuid
      ) {
        skipped += 1;
        continue;
      }

      const attemptAt = new Date().toISOString();
      const itemRecord = priorItem
        ? await admin
            .from("studio_gusto_time_sheet_transmission_items")
            .update({
              transmission_id: transmission.id,
              status: "sending",
              request_fingerprint: fingerprint,
              attempt_count: Number(priorItem.attempt_count ?? 0) + 1,
              last_attempted_at: attemptAt,
              last_error: null,
              updated_at: attemptAt,
            })
            .eq("id", priorItem.id)
            .select("id")
            .single()
        : await admin
            .from("studio_gusto_time_sheet_transmission_items")
            .insert({
              transmission_id: transmission.id,
              studio_id: studioId,
              preview_item_id: item.id,
              earning_id: item.earning_id,
              status: "sending",
              request_fingerprint: fingerprint,
              attempt_count: 1,
              first_attempted_at: attemptAt,
              last_attempted_at: attemptAt,
            })
            .select("id")
            .single();

      if (itemRecord.error || !itemRecord.data) {
        failed += 1;
        errors.push(
          itemRecord.error?.message ?? "Transmission item could not be reserved.",
        );
        continue;
      }

      try {
        const shiftStartMs = new Date(payload.shift_started_at).getTime();
        const shiftEndMs = payload.shift_ended_at
          ? new Date(payload.shift_ended_at).getTime()
          : Number.NaN;
        const nowMs = Date.now();

        if (!Number.isFinite(shiftStartMs) || shiftStartMs >= nowMs) {
          throw new Error(
            "The shift has not started yet. Gusto accepts only completed or past shifts.",
          );
        }

        if (!Number.isFinite(shiftEndMs) || shiftEndMs > nowMs) {
          throw new Error(
            "The shift has not ended yet. Gusto accepts only completed or past shifts.",
          );
        }

        const existing = await findGustoTimeSheetByDanceFlowKey(
          token,
          connection.gusto_company_uuid,
          item.gusto_worker_uuid,
          deliveryKey,
        );

        const response =
          existing ??
          (await createGustoTimeSheet(
            token,
            connection.gusto_company_uuid,
            {
              ...payload,
              metadata: {
                ...(payload.metadata ?? {}),
                danceflow_delivery_key: deliveryKey,
                danceflow_preview_item_id: item.id,
              },
            },
          ));

        const gustoUuid = response.uuid ?? response.id ?? null;
        if (!gustoUuid) {
          throw new Error("Gusto created a time sheet without returning a UUID.");
        }

        const reconciled = Boolean(existing);
        const { error: successError } = await admin
          .from("studio_gusto_time_sheet_transmission_items")
          .update({
            status: reconciled ? "reconciled" : "succeeded",
            gusto_time_sheet_uuid: gustoUuid,
            gusto_response: response,
            sent_at: new Date().toISOString(),
            last_error: null,
            updated_at: new Date().toISOString(),
          })
          .eq("id", itemRecord.data.id);

        if (successError) throw successError;
        sent += 1;
      } catch (itemError) {
        const message =
          itemError instanceof Error
            ? itemError.message
            : "Unknown Gusto time-sheet error.";

        await admin
          .from("studio_gusto_time_sheet_transmission_items")
          .update({
            status: "failed",
            last_error: message.slice(0, 1000),
            updated_at: new Date().toISOString(),
          })
          .eq("id", itemRecord.data.id);

        failed += 1;
        errors.push(message);
      }
    }

    const finalStatus =
      failed === 0
        ? "succeeded"
        : sent + skipped > 0
          ? "partial"
          : "failed";

    await admin
      .from("studio_gusto_time_sheet_transmissions")
      .update({
        status: finalStatus,
        sent_count: sent,
        failed_count: failed,
        skipped_count: skipped,
        completed_at: new Date().toISOString(),
        last_error: errors[0]?.slice(0, 1000) ?? null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", transmission.id);

    await admin.from("studio_gusto_audit_events").insert({
      studio_id: studioId,
      connection_id: connection.id,
      event_type: "time_sheets_sent",
      outcome: finalStatus,
      actor_user_id: user.id,
      details: {
        pay_period_id: payPeriodId,
        preview_id: preview.id,
        transmission_id: transmission.id,
        sent,
        failed,
        skipped,
      },
    });

    revalidatePath(`/app/instructor-pay/periods/${payPeriodId}`);
    go(
      payPeriodId,
      finalStatus === "succeeded"
        ? "gusto_time_sheets_sent"
        : finalStatus === "partial"
          ? "gusto_time_sheets_partial"
          : "gusto_time_sheets_failed",
    );
  } catch (error) {
    if (isRedirectError(error)) throw error;
    console.error("[Instructor Pay Period] Gusto send failed", error);
    go(payPeriodId || "missing", "gusto_time_sheets_failed");
  }
}


function requireDemoGustoEnvironment() {
  if (gustoEnvironment() !== "demo") {
    throw new Error("Demo Gusto setup actions are disabled outside demo.");
  }
}

export async function createMissingGustoDemoJobAction(formData: FormData) {
  const payPeriodId = getString(formData, "payPeriodId");

  try {
    requireDemoGustoEnvironment();

    if (!payPeriodId) {
      go("missing", "gusto_demo_job_missing_fields");
    }

    const { supabase, studioId, user } = await requirePayrollPrepareAccess();
    const admin = createAdminClient();

    const [{ data: connection }, { data: period }, { data: review }] =
      await Promise.all([
        supabase
          .from("studio_gusto_connections")
          .select("id, status, environment")
          .eq("studio_id", studioId)
          .maybeSingle(),
        supabase
          .from("payroll_pay_periods")
          .select("id, status, period_start, period_end")
          .eq("studio_id", studioId)
          .eq("id", payPeriodId)
          .maybeSingle(),
        supabase
          .from("studio_gusto_readiness_reviews")
          .select("id")
          .eq("studio_id", studioId)
          .eq("pay_period_id", payPeriodId)
          .order("reviewed_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);

    if (
      !connection ||
      connection.status !== "connected" ||
      connection.environment !== "demo"
    ) {
      throw new Error(
        "Demo Gusto setup actions require an active demo connection.",
      );
    }

    if (!period || !["open", "in_review"].includes(period.status)) {
      go(payPeriodId, "pay_period_closed");
    }

    if (!review) {
      go(payPeriodId, "gusto_demo_job_missing_fields");
    }

    const { data: blockedItem } = await admin
      .from("studio_gusto_readiness_items")
      .select("earning_id, instructor_id, blocker_codes")
      .eq("studio_id", studioId)
      .eq("review_id", review.id)
      .contains("blocker_codes", ["gusto_job_missing"])
      .limit(1)
      .maybeSingle();

    if (!blockedItem?.earning_id || !blockedItem.instructor_id) {
      go(payPeriodId, "gusto_demo_job_missing_fields");
    }

    const [{ data: earning }, { data: match }, { data: instructor }] =
      await Promise.all([
        admin
          .from("instructor_earnings")
          .select("id, instructor_id, earning_date, pay_period_id")
          .eq("studio_id", studioId)
          .eq("id", blockedItem.earning_id)
          .eq("pay_period_id", payPeriodId)
          .maybeSingle(),
        admin
          .from("studio_gusto_worker_matches")
          .select("gusto_worker_uuid, gusto_worker_type, match_status")
          .eq("studio_id", studioId)
          .eq("connection_id", connection.id)
          .eq("instructor_id", blockedItem.instructor_id)
          .eq("match_status", "confirmed")
          .maybeSingle(),
        admin
          .from("instructors")
          .select("first_name, last_name")
          .eq("studio_id", studioId)
          .eq("id", blockedItem.instructor_id)
          .maybeSingle(),
      ]);

    if (
      !earning ||
      !match?.gusto_worker_uuid ||
      match.gusto_worker_type !== "employee"
    ) {
      go(payPeriodId, "gusto_demo_job_missing_fields");
    }

    const instructorName =
      [instructor?.first_name, instructor?.last_name]
        .filter(Boolean)
        .join(" ")
        .trim() || "Dance Instructor";

    const token = await getValidGustoAccessToken(connection.id);
    const job = await createGustoEmployeeJob(
      token,
      match.gusto_worker_uuid,
      {
        title: `${instructorName} — Dance Instructor`,
        hireDate: earning.earning_date,
      },
    );

    await admin.from("studio_gusto_audit_events").insert({
      studio_id: studioId,
      connection_id: connection.id,
      event_type: "demo_job_created",
      outcome: "succeeded",
      actor_user_id: user.id,
      details: {
        pay_period_id: payPeriodId,
        earning_id: earning.id,
        instructor_id: blockedItem.instructor_id,
        gusto_worker_uuid: match.gusto_worker_uuid,
        gusto_job_uuid: job.uuid ?? job.id ?? null,
        hire_date: earning.earning_date,
      },
    });

    revalidatePath(`/app/instructor-pay/periods/${payPeriodId}`);
    go(payPeriodId, "gusto_demo_job_created");
  } catch (error) {
    if (isRedirectError(error)) throw error;
    console.error("[Instructor Pay Period] Gusto demo job failed", error);
    go(payPeriodId || "missing", "gusto_demo_job_failed");
  }
}

export async function alignPayPeriodToGustoDemoAction(formData: FormData) {
  const payPeriodId = getString(formData, "payPeriodId");

  try {
    requireDemoGustoEnvironment();

    const gustoPayPeriodId = getString(formData, "gustoPayPeriodId");
    if (!payPeriodId || !gustoPayPeriodId) {
      go(payPeriodId || "missing", "gusto_alignment_period_required");
    }

    const { supabase, studioId, user } = await requirePayrollPrepareAccess();
    const admin = createAdminClient();

    const [
      { data: period },
      { data: gustoPeriod },
      { data: earnings },
      { data: batches },
      { data: overlaps },
    ] = await Promise.all([
      supabase
        .from("payroll_pay_periods")
        .select("id, status")
        .eq("studio_id", studioId)
        .eq("id", payPeriodId)
        .maybeSingle(),
      supabase
        .from("studio_gusto_pay_periods")
        .select("id, period_start, period_end, pay_date")
        .eq("studio_id", studioId)
        .eq("id", gustoPayPeriodId)
        .maybeSingle(),
      supabase
        .from("instructor_earnings")
        .select("id, earning_date, payroll_batch_id")
        .eq("studio_id", studioId)
        .eq("pay_period_id", payPeriodId),
      supabase
        .from("payroll_batches")
        .select("id")
        .eq("studio_id", studioId)
        .eq("pay_period_id", payPeriodId)
        .limit(1),
      supabase
        .from("payroll_pay_periods")
        .select("id, period_start, period_end")
        .eq("studio_id", studioId)
        .neq("id", payPeriodId)
        .neq("status", "void"),
    ]);

    if (!period || !["open", "in_review"].includes(period.status)) {
      go(payPeriodId, "gusto_alignment_period_locked");
    }
    if (!gustoPeriod) go(payPeriodId, "gusto_alignment_period_required");
    if (batches?.length) go(payPeriodId, "gusto_alignment_batch_exists");

    const outsideEarning = (earnings ?? []).find(
      (earning) =>
        earning.earning_date < gustoPeriod.period_start ||
        earning.earning_date > gustoPeriod.period_end ||
        Boolean(earning.payroll_batch_id),
    );
    if (outsideEarning) go(payPeriodId, "gusto_alignment_earning_outside");

    const overlapsTarget = (overlaps ?? []).some(
      (other) =>
        other.period_start <= gustoPeriod.period_end &&
        other.period_end >= gustoPeriod.period_start,
    );
    if (overlapsTarget) go(payPeriodId, "gusto_alignment_overlap");

    const { error } = await supabase
      .from("payroll_pay_periods")
      .update({
        period_start: gustoPeriod.period_start,
        period_end: gustoPeriod.period_end,
        pay_date: gustoPeriod.pay_date,
        updated_by: user.id,
        updated_at: new Date().toISOString(),
      })
      .eq("studio_id", studioId)
      .eq("id", payPeriodId);

    if (error) throw error;

    const { data: connection } = await supabase
      .from("studio_gusto_connections")
      .select("id")
      .eq("studio_id", studioId)
      .maybeSingle();

    if (connection) {
      await admin.from("studio_gusto_audit_events").insert({
        studio_id: studioId,
        connection_id: connection.id,
        event_type: "demo_pay_period_aligned",
        outcome: "succeeded",
        actor_user_id: user.id,
        details: {
          pay_period_id: payPeriodId,
          gusto_pay_period_snapshot_id: gustoPayPeriodId,
          period_start: gustoPeriod.period_start,
          period_end: gustoPeriod.period_end,
          pay_date: gustoPeriod.pay_date,
        },
      });
    }

    revalidatePath(`/app/instructor-pay/periods/${payPeriodId}`);
    revalidatePath("/app/instructor-pay");
    go(payPeriodId, "gusto_pay_period_aligned");
  } catch (error) {
    if (isRedirectError(error)) throw error;
    console.error("[Instructor Pay Period] Gusto alignment failed", error);
    go(payPeriodId || "missing", "gusto_alignment_failed");
  }
}


function normalizePayrollSyncStatus(value: unknown) {
  const status = String(value ?? "unknown").toLowerCase();

  if (["complete", "completed", "success", "succeeded"].includes(status)) {
    return "completed";
  }
  if (["pending", "queued"].includes(status)) return "pending";
  if (["processing", "in_progress", "running"].includes(status)) {
    return "processing";
  }
  if (["failed", "error"].includes(status)) return "failed";
  if (["cancelled", "canceled"].includes(status)) return "cancelled";
  return "unknown";
}

function payrollSyncUuid(value: {
  uuid?: string;
  id?: string;
}) {
  return value.uuid ?? value.id ?? null;
}

export async function initiateGustoPayrollSyncAction(formData: FormData) {
  const payPeriodId = getString(formData, "payPeriodId");

  try {
    if (!payPeriodId) go("missing", "missing_pay_period");
    if (getString(formData, "confirmation") !== "sync") {
      go(payPeriodId, "gusto_payroll_sync_confirmation_required");
    }

    const { supabase, studioId, user } =
      await requirePayrollDisbursementAccess();
    const admin = createAdminClient();

    const [
      { data: connection },
      { data: period },
      { data: transmission },
    ] = await Promise.all([
      supabase
        .from("studio_gusto_connections")
        .select("id, status, gusto_company_uuid")
        .eq("studio_id", studioId)
        .maybeSingle(),
      supabase
        .from("payroll_pay_periods")
        .select("id, period_start, period_end")
        .eq("studio_id", studioId)
        .eq("id", payPeriodId)
        .maybeSingle(),
      supabase
        .from("studio_gusto_time_sheet_transmissions")
        .select("id, status, failed_count")
        .eq("studio_id", studioId)
        .eq("pay_period_id", payPeriodId)
        .order("initiated_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);

    if (
      !connection ||
      connection.status !== "connected" ||
      !connection.gusto_company_uuid
    ) {
      go(payPeriodId, "gusto_not_connected");
    }
    if (!period) go(payPeriodId, "pay_period_not_found");
    if (
      !transmission ||
      transmission.status !== "succeeded" ||
      transmission.failed_count > 0
    ) {
      go(payPeriodId, "gusto_payroll_sync_requires_delivery");
    }

    const { data: existingSync } = await supabase
      .from("studio_gusto_payroll_syncs")
      .select("id, status")
      .eq("transmission_id", transmission.id)
      .maybeSingle();

    if (existingSync) {
      go(payPeriodId, "gusto_payroll_sync_already_started");
    }

    const { data: gustoPeriod } = await supabase
      .from("studio_gusto_pay_periods")
      .select("gusto_pay_schedule_uuid, period_start, period_end")
      .eq("studio_id", studioId)
      .eq("connection_id", connection.id)
      .eq("period_start", period.period_start)
      .eq("period_end", period.period_end)
      .not("gusto_pay_schedule_uuid", "is", null)
      .limit(1)
      .maybeSingle();

    if (!gustoPeriod?.gusto_pay_schedule_uuid) {
      go(payPeriodId, "gusto_payroll_sync_period_missing");
    }

    const token = await getValidGustoAccessToken(connection.id);

    const { data: deliveredItems, error: deliveredItemsError } = await admin
      .from("studio_gusto_time_sheet_transmission_items")
      .select("id, gusto_time_sheet_uuid, status, gusto_response")
      .eq("transmission_id", transmission.id)
      .in("status", ["succeeded", "reconciled"]);

    if (deliveredItemsError) throw deliveredItemsError;

    const unapproved: string[] = [];
    for (const item of deliveredItems ?? []) {
      if (!item.gusto_time_sheet_uuid) {
        unapproved.push(item.id);
        continue;
      }

      const current = await getGustoTimeSheet(
        token,
        item.gusto_time_sheet_uuid,
      );

      await admin
        .from("studio_gusto_time_sheet_transmission_items")
        .update({
          gusto_response: current,
          updated_at: new Date().toISOString(),
        })
        .eq("id", item.id);

      if (String(current.status ?? "").toLowerCase() !== "approved") {
        unapproved.push(item.id);
      }
    }

    if (unapproved.length) {
      go(payPeriodId, "gusto_payroll_sync_requires_approved_time");
    }

    const payrolls = await getGustoUnprocessedPayrolls(
      token,
      connection.gusto_company_uuid,
      gustoPeriod.period_start,
      gustoPeriod.period_end,
    );

    const matchingPayroll = payrolls.find((payroll) => {
      const start =
        payroll.pay_period?.start_date ??
        payroll.pay_period_start_date ??
        null;
      const end =
        payroll.pay_period?.end_date ??
        payroll.pay_period_end_date ??
        null;
      return (
        start === gustoPeriod.period_start &&
        end === gustoPeriod.period_end
      );
    });

    const matchingPayrollUuid =
      matchingPayroll?.uuid ??
      matchingPayroll?.id ??
      matchingPayroll?.payroll_uuid ??
      null;

    if (!matchingPayrollUuid) {
      go(payPeriodId, "gusto_payroll_sync_payroll_missing");
    }

    const payrollEmployees = await getGustoPayrollEmployees(
      token,
      connection.gusto_company_uuid,
      matchingPayrollUuid,
    );
    const eligibleEmployeeUuids = new Set(
      payrollEmployees
        .map((employee) => employee.uuid ?? employee.id ?? null)
        .filter((value): value is string => Boolean(value)),
    );

    const deliveredWorkerUuids = new Set(
      (deliveredItems ?? [])
        .map((item) => {
          const response =
            item.gusto_response &&
            typeof item.gusto_response === "object"
              ? (item.gusto_response as { entity_uuid?: string })
              : null;
          return response?.entity_uuid ?? null;
        })
        .filter((value): value is string => Boolean(value)),
    );

    const ineligibleWorkers = [...deliveredWorkerUuids].filter(
      (workerUuid) => !eligibleEmployeeUuids.has(workerUuid),
    );

    if (ineligibleWorkers.length) {
      await admin.from("studio_gusto_audit_events").insert({
        studio_id: studioId,
        connection_id: connection.id,
        event_type: "payroll_sync_blocked",
        outcome: "blocked",
        actor_user_id: user.id,
        details: {
          pay_period_id: payPeriodId,
          reason: "worker_not_eligible_for_payroll",
          payroll_uuid: matchingPayrollUuid,
          ineligible_worker_uuids: ineligibleWorkers,
        },
      });
      go(payPeriodId, "gusto_payroll_sync_worker_not_eligible");
    }

    const response = await createGustoPayrollSync(
      token,
      connection.gusto_company_uuid,
      {
        payScheduleUuid: gustoPeriod.gusto_pay_schedule_uuid,
        payPeriodStartDate: gustoPeriod.period_start,
        payPeriodEndDate: gustoPeriod.period_end,
      },
    );

    const syncUuid = payrollSyncUuid(response);
    if (!syncUuid) {
      throw new Error("Gusto did not return a payroll-sync UUID.");
    }

    const status = normalizePayrollSyncStatus(response.status);
    const completed = ["completed", "failed", "cancelled"].includes(status);

    const { error: insertError } = await admin
      .from("studio_gusto_payroll_syncs")
      .insert({
        studio_id: studioId,
        connection_id: connection.id,
        pay_period_id: payPeriodId,
        transmission_id: transmission.id,
        gusto_pay_schedule_uuid: gustoPeriod.gusto_pay_schedule_uuid,
        pay_period_start: gustoPeriod.period_start,
        pay_period_end: gustoPeriod.period_end,
        gusto_payroll_sync_uuid: syncUuid,
        gusto_payroll_uuid:
          typeof response.payroll_uuid === "string"
            ? response.payroll_uuid
            : null,
        status,
        response_snapshot: response,
        initiated_by: user.id,
        initiated_at: new Date().toISOString(),
        last_checked_at: new Date().toISOString(),
        completed_at: completed ? new Date().toISOString() : null,
        last_error:
          status === "failed"
            ? String(response.error ?? "Gusto payroll sync failed.")
            : null,
      });

    if (insertError) throw insertError;

    await admin.from("studio_gusto_audit_events").insert({
      studio_id: studioId,
      connection_id: connection.id,
      event_type: "payroll_sync_started",
      outcome: status,
      actor_user_id: user.id,
      details: {
        pay_period_id: payPeriodId,
        transmission_id: transmission.id,
        gusto_payroll_sync_uuid: syncUuid,
        pay_schedule_uuid: gustoPeriod.gusto_pay_schedule_uuid,
        pay_period_start: gustoPeriod.period_start,
        pay_period_end: gustoPeriod.period_end,
      },
    });

    revalidatePath(`/app/instructor-pay/periods/${payPeriodId}`);
    go(
      payPeriodId,
      completed && status === "completed"
        ? "gusto_payroll_sync_completed"
        : status === "failed"
          ? "gusto_payroll_sync_failed"
          : "gusto_payroll_sync_started",
    );
  } catch (error) {
    if (isRedirectError(error)) throw error;
    console.error("[Instructor Pay Period] Gusto payroll sync failed", error);

    const message =
      error instanceof Error ? error.message.toLowerCase() : "";
    if (message.includes("there are no hours to sync to payroll")) {
      go(payPeriodId || "missing", "gusto_payroll_sync_no_eligible_hours");
    }

    go(payPeriodId || "missing", "gusto_payroll_sync_failed");
  }
}

export async function refreshGustoPayrollSyncAction(formData: FormData) {
  const payPeriodId = getString(formData, "payPeriodId");

  try {
    if (!payPeriodId) go("missing", "missing_pay_period");

    const { supabase, studioId, user } =
      await requirePayrollPrepareAccess();
    const admin = createAdminClient();

    const { data: sync } = await supabase
      .from("studio_gusto_payroll_syncs")
      .select(
        "id, connection_id, gusto_payroll_sync_uuid, status",
      )
      .eq("studio_id", studioId)
      .eq("pay_period_id", payPeriodId)
      .order("initiated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!sync) go(payPeriodId, "gusto_payroll_sync_not_found");

    const token = await getValidGustoAccessToken(sync.connection_id);
    const response = await getGustoPayrollSync(
      token,
      sync.gusto_payroll_sync_uuid,
    );
    const status = normalizePayrollSyncStatus(response.status);
    const completed = ["completed", "failed", "cancelled"].includes(status);
    const errorText =
      status === "failed"
        ? String(
            response.error ??
              (Array.isArray(response.errors)
                ? JSON.stringify(response.errors)
                : "Gusto payroll sync failed."),
          ).slice(0, 1000)
        : null;

    const { error } = await admin
      .from("studio_gusto_payroll_syncs")
      .update({
        status,
        gusto_payroll_uuid:
          typeof response.payroll_uuid === "string"
            ? response.payroll_uuid
            : null,
        response_snapshot: response,
        last_checked_at: new Date().toISOString(),
        completed_at: completed ? new Date().toISOString() : null,
        last_error: errorText,
        updated_at: new Date().toISOString(),
      })
      .eq("id", sync.id);

    if (error) throw error;

    await admin.from("studio_gusto_audit_events").insert({
      studio_id: studioId,
      connection_id: sync.connection_id,
      event_type: "payroll_sync_checked",
      outcome: status,
      actor_user_id: user.id,
      details: {
        pay_period_id: payPeriodId,
        gusto_payroll_sync_uuid: sync.gusto_payroll_sync_uuid,
      },
    });

    revalidatePath(`/app/instructor-pay/periods/${payPeriodId}`);
    go(
      payPeriodId,
      status === "completed"
        ? "gusto_payroll_sync_completed"
        : status === "failed"
          ? "gusto_payroll_sync_failed"
          : "gusto_payroll_sync_refreshed",
    );
  } catch (error) {
    if (isRedirectError(error)) throw error;
    console.error(
      "[Instructor Pay Period] Gusto payroll sync refresh failed",
      error,
    );
    go(payPeriodId || "missing", "gusto_payroll_sync_refresh_failed");
  }
}


export async function refreshGustoTimeSheetStatusesAction(formData: FormData) {
  const payPeriodId = getString(formData, "payPeriodId");

  try {
    if (!payPeriodId) go("missing", "missing_pay_period");

    const { supabase, studioId, user } =
      await requirePayrollPrepareAccess();
    const admin = createAdminClient();

    const { data: transmission } = await supabase
      .from("studio_gusto_time_sheet_transmissions")
      .select("id, connection_id")
      .eq("studio_id", studioId)
      .eq("pay_period_id", payPeriodId)
      .order("initiated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!transmission) go(payPeriodId, "gusto_time_sheet_status_not_found");

    const { data: items, error: itemError } = await admin
      .from("studio_gusto_time_sheet_transmission_items")
      .select("id, gusto_time_sheet_uuid")
      .eq("transmission_id", transmission.id)
      .not("gusto_time_sheet_uuid", "is", null);

    if (itemError) throw itemError;

    const token = await getValidGustoAccessToken(
      transmission.connection_id,
    );
    let approved = 0;
    let pending = 0;
    let rejected = 0;

    for (const item of items ?? []) {
      const current = await getGustoTimeSheet(
        token,
        item.gusto_time_sheet_uuid,
      );
      const status = String(current.status ?? "pending").toLowerCase();

      if (status === "approved") approved += 1;
      else if (status === "rejected") rejected += 1;
      else pending += 1;

      const { error } = await admin
        .from("studio_gusto_time_sheet_transmission_items")
        .update({
          gusto_response: current,
          updated_at: new Date().toISOString(),
        })
        .eq("id", item.id);

      if (error) throw error;
    }

    await admin.from("studio_gusto_audit_events").insert({
      studio_id: studioId,
      connection_id: transmission.connection_id,
      event_type: "time_sheet_statuses_checked",
      outcome: rejected ? "blocked" : "succeeded",
      actor_user_id: user.id,
      details: {
        pay_period_id: payPeriodId,
        approved,
        pending,
        rejected,
      },
    });

    revalidatePath(`/app/instructor-pay/periods/${payPeriodId}`);
    go(payPeriodId, "gusto_time_sheet_statuses_refreshed");
  } catch (error) {
    if (isRedirectError(error)) throw error;
    console.error(
      "[Instructor Pay Period] Gusto time-sheet status refresh failed",
      error,
    );
    go(payPeriodId || "missing", "gusto_time_sheet_status_refresh_failed");
  }
}

export async function approveDeliveredGustoTimeSheetsAction(
  formData: FormData,
) {
  const payPeriodId = getString(formData, "payPeriodId");

  try {
    if (!payPeriodId) go("missing", "missing_pay_period");
    if (getString(formData, "confirmation") !== "approve") {
      go(payPeriodId, "gusto_time_sheet_approval_confirmation_required");
    }

    const { supabase, studioId, user } =
      await requirePayrollDisbursementAccess();
    const admin = createAdminClient();

    const { data: transmission } = await supabase
      .from("studio_gusto_time_sheet_transmissions")
      .select("id, connection_id, status")
      .eq("studio_id", studioId)
      .eq("pay_period_id", payPeriodId)
      .order("initiated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!transmission || transmission.status !== "succeeded") {
      go(payPeriodId, "gusto_payroll_sync_requires_delivery");
    }

    const { data: items, error: itemError } = await admin
      .from("studio_gusto_time_sheet_transmission_items")
      .select("id, gusto_time_sheet_uuid")
      .eq("transmission_id", transmission.id)
      .not("gusto_time_sheet_uuid", "is", null);

    if (itemError) throw itemError;

    const token = await getValidGustoAccessToken(
      transmission.connection_id,
    );
    let approvedCount = 0;

    for (const item of items ?? []) {
      const current = await getGustoTimeSheet(
        token,
        item.gusto_time_sheet_uuid,
      );

      const result =
        String(current.status ?? "").toLowerCase() === "approved"
          ? current
          : await approveGustoTimeSheet(token, current);

      const { error } = await admin
        .from("studio_gusto_time_sheet_transmission_items")
        .update({
          gusto_response: result,
          updated_at: new Date().toISOString(),
        })
        .eq("id", item.id);

      if (error) throw error;
      approvedCount += 1;
    }

    await admin.from("studio_gusto_audit_events").insert({
      studio_id: studioId,
      connection_id: transmission.connection_id,
      event_type: "time_sheets_approved",
      outcome: "succeeded",
      actor_user_id: user.id,
      details: {
        pay_period_id: payPeriodId,
        approved_count: approvedCount,
      },
    });

    revalidatePath(`/app/instructor-pay/periods/${payPeriodId}`);
    go(payPeriodId, "gusto_time_sheets_approved");
  } catch (error) {
    if (isRedirectError(error)) throw error;
    console.error(
      "[Instructor Pay Period] Gusto time-sheet approval failed",
      error,
    );
    go(payPeriodId || "missing", "gusto_time_sheet_approval_failed");
  }
}
