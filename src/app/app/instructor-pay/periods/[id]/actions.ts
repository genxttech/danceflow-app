"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { isRedirectError } from "next/dist/client/components/redirect-error";
import { createAdminClient } from "@/lib/supabase/admin";
import { getValidGustoAccessToken } from "@/lib/integrations/gusto/token";
import {
  getGustoEmployeeJobs,
  getGustoPayPeriods,
  getGustoPaySchedules,
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
