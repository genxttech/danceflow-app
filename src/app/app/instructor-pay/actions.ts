"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { isRedirectError } from "next/dist/client/components/redirect-error";
import {
  requirePayrollDisbursementAccess,
  requirePayrollPrepareAccess,
} from "@/lib/auth/serverRoleGuard";
import { generateInstructorEarningsForCompletedAppointments } from "@/lib/compensation/earnings";

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function getNumber(formData: FormData, key: string) {
  const value = getString(formData, key);
  if (!value) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function getOptionalDate(formData: FormData, key: string) {
  const value = getString(formData, key);
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

function redirectWithStatus(status: string): never {
  redirect(`/app/instructor-pay?status=${encodeURIComponent(status)}`);
}

type PayrollOperation =
  | "create_period"
  | "assign_period"
  | "create_batch"
  | "approve_batch"
  | "pay_batch";

function payrollErrorStatus(operation: PayrollOperation, error: unknown) {
  const message =
    typeof error === "object" && error && "message" in error
      ? String(error.message).toLowerCase()
      : "";

  if (message.includes("overlaps another active pay period")) return "pay_period_overlap";
  if (message.includes("end date must be on or after start date")) return "pay_period_invalid_dates";
  if (message.includes("pay period not found")) return "pay_period_not_found";
  if (message.includes("only open or in-review periods can receive earnings")) return "pay_period_closed";
  if (message.includes("no approved, unbatched earnings are available")) return "no_approved_earnings";
  if (message.includes("pay period must be in review or approved")) return "pay_period_not_ready";
  if (message.includes("only draft or in-review batches can be approved")) return "batch_not_approvable";
  if (message.includes("payroll batch not found")) return "payroll_batch_not_found";
  if (message.includes("only the studio owner can mark payroll paid")) return "owner_required_to_pay";
  if (message.includes("payroll batch must be approved before payment")) return "batch_not_approved";
  if (message.includes("payroll access denied")) return "payroll_access_denied";

  return {
    create_period: "pay_period_create_failed",
    assign_period: "pay_period_assign_failed",
    create_batch: "payroll_batch_create_failed",
    approve_batch: "payroll_batch_approve_failed",
    pay_batch: "payroll_batch_pay_failed",
  }[operation];
}

function logPayrollOperationError(operation: PayrollOperation, error: unknown) {
  const safeError =
    typeof error === "object" && error
      ? {
          message: "message" in error ? String(error.message) : "Unknown error",
          code: "code" in error ? String(error.code) : undefined,
          details: "details" in error ? String(error.details) : undefined,
          hint: "hint" in error ? String(error.hint) : undefined,
        }
      : { message: String(error) };

  console.error(`[Instructor Pay] ${operation} failed`, safeError);
}

export async function saveInstructorPayrollProfileAction(formData: FormData) {
  try {
    const { supabase, studioId, user } = await requirePayrollPrepareAccess();
    const instructorId = getString(formData, "instructorId");
    const workerClassification =
      getString(formData, "workerClassification") || "not_set";
    const payrollActive = getString(formData, "payrollActive") === "on";
    const externalPayrollId =
      getString(formData, "externalPayrollId") || null;
    const payrollNotes = getString(formData, "payrollNotes") || null;

    if (!instructorId) redirectWithStatus("missing_instructor");
    if (
      !["not_set", "contractor", "employee", "owner"].includes(
        workerClassification,
      )
    ) {
      redirectWithStatus("invalid_worker_classification");
    }

    const { error } = await supabase
      .from("instructor_payroll_profiles")
      .upsert(
        {
          studio_id: studioId,
          instructor_id: instructorId,
          worker_classification: workerClassification,
          payroll_active: payrollActive,
          external_payroll_id: externalPayrollId,
          payroll_notes: payrollNotes,
          updated_by: user.id,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "studio_id,instructor_id" },
      );

    if (error) redirectWithStatus("payroll_profile_save_failed");

    revalidatePath("/app/instructor-pay");
    redirectWithStatus("payroll_profile_saved");
  } catch (error) {
    if (isRedirectError(error)) throw error;
    redirectWithStatus("payroll_profile_save_failed");
  }
}

export async function saveInstructorCompensationRuleAction(formData: FormData) {
  try {
    const { supabase, studioId, user } = await requirePayrollPrepareAccess();
    const instructorId = getString(formData, "instructorId");

    if (!instructorId) redirectWithStatus("missing_instructor");

    const privateLessonPayMode = getString(formData, "privateLessonPayMode") || "none";
    const groupClassPayMode = getString(formData, "groupClassPayMode") || "none";

    const { error } = await supabase.from("instructor_compensation_rules").upsert(
      {
        studio_id: studioId,
        instructor_id: instructorId,
        private_lesson_pay_mode: privateLessonPayMode,
        private_lesson_flat_amount: getNumber(formData, "privateLessonFlatAmount"),
        private_lesson_percentage: getNumber(formData, "privateLessonPercentage"),
        private_lesson_duration_rates_enabled: getString(formData, "privateLessonDurationRatesEnabled") === "on",
        private_lesson_30_min_flat_amount: getNumber(formData, "privateLesson30MinFlatAmount"),
        private_lesson_45_min_flat_amount: getNumber(formData, "privateLesson45MinFlatAmount"),
        private_lesson_60_min_flat_amount: getNumber(formData, "privateLesson60MinFlatAmount"),
        group_class_pay_mode: groupClassPayMode,
        group_class_flat_amount: getNumber(formData, "groupClassFlatAmount"),
        group_class_percentage: getNumber(formData, "groupClassPercentage"),
        group_class_per_attendee_amount: getNumber(formData, "groupClassPerAttendeeAmount"),
        active: true,
        notes: getString(formData, "notes") || null,
        created_by: user.id,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "studio_id,instructor_id" },
    );

    if (error) redirectWithStatus("rule_save_failed");

    revalidatePath("/app/instructor-pay");
    revalidatePath(`/app/instructors/${instructorId}`);
    redirectWithStatus("rule_saved");
  } catch (error) {
    if (isRedirectError(error)) throw error;
    redirectWithStatus("rule_save_failed");
  }
}

export async function generateInstructorEarningsAction(formData: FormData) {
  try {
    const { supabase, studioId, user } = await requirePayrollPrepareAccess();
    const fromDate = getOptionalDate(formData, "fromDate");
    const toDate = getOptionalDate(formData, "toDate");

    const result = await generateInstructorEarningsForCompletedAppointments({
      supabase,
      studioId,
      fromDate,
      toDate,
      createdBy: user.id,
    });

    revalidatePath("/app/instructor-pay");
    revalidatePath("/app/reports");

    if (result.error) redirectWithStatus("generate_failed");

    redirect(
      `/app/instructor-pay?status=earnings_generated&scanned=${result.scanned}&staged=${result.staged}&skipped=${result.skipped}`,
    );
  } catch (error) {
    if (isRedirectError(error)) throw error;
    redirectWithStatus("generate_failed");
  }
}

export async function updateInstructorEarningStatusAction(formData: FormData) {
  try {
    const earningId = getString(formData, "earningId");
    const nextStatus = getString(formData, "nextStatus");
    const paymentMethod = getString(formData, "paymentMethod");
    const access =
      nextStatus === "paid"
        ? await requirePayrollDisbursementAccess()
        : await requirePayrollPrepareAccess();
    const { supabase, studioId, user } = access;

    if (!earningId) redirectWithStatus("missing_earning");

    const { data: existing, error: existingError } = await supabase
      .from("instructor_earnings")
      .select("id, status")
      .eq("id", earningId)
      .eq("studio_id", studioId)
      .maybeSingle();

    if (existingError || !existing) redirectWithStatus("earning_update_failed");

    const currentStatus = String(existing.status ?? "pending");

    if (["paid", "void"].includes(currentStatus) && currentStatus !== nextStatus) {
      redirectWithStatus("earning_locked");
    }

    if (currentStatus === nextStatus) {
      redirectWithStatus("earning_unchanged");
    }

    const now = new Date().toISOString();
    const update: Record<string, string | null> = {
      status: nextStatus,
      updated_at: now,
    };

    if (nextStatus === "approved") {
      update.approved_at = now;
      update.approved_by = user.id;
    }

    if (nextStatus === "paid") {
      update.paid_at = now;
      update.paid_by = user.id;
      update.payment_method = paymentMethod || "external_payroll";
      update.approved_at = now;
      update.approved_by = user.id;
    }

    if (nextStatus === "void") {
      update.notes = "Voided from Instructor Pay.";
    }

    if (!["approved", "paid", "void", "pending"].includes(nextStatus)) {
      redirectWithStatus("invalid_status");
    }

    const { error } = await supabase
      .from("instructor_earnings")
      .update(update)
      .eq("id", earningId)
      .eq("studio_id", studioId);

    if (error) redirectWithStatus("earning_update_failed");

    revalidatePath("/app/instructor-pay");
    revalidatePath("/app/reports");
    redirectWithStatus("earning_updated");
  } catch (error) {
    if (isRedirectError(error)) throw error;
    redirectWithStatus("earning_update_failed");
  }
}

export async function createInstructorAdjustmentAction(formData: FormData) {
  try {
    const { supabase, studioId, user } = await requirePayrollPrepareAccess();
    const instructorId = getString(formData, "instructorId");
    const adjustmentType = getString(formData, "adjustmentType") || "correction";
    const earningDate = getOptionalDate(formData, "earningDate") || new Date().toISOString().slice(0, 10);
    const rawAmount = getNumber(formData, "earningAmount");
    const notes = getString(formData, "notes");

    if (!instructorId) redirectWithStatus("missing_instructor");
    if (!notes) redirectWithStatus("adjustment_note_required");
    if (!["bonus", "deduction", "reimbursement", "correction"].includes(adjustmentType)) redirectWithStatus("invalid_adjustment");

    const amount =
      adjustmentType === "deduction"
        ? -Math.abs(rawAmount)
        : Math.abs(rawAmount);
    if (!Number.isFinite(amount) || amount === 0) {
      redirectWithStatus("invalid_adjustment_amount");
    }

    const { data: payrollProfile, error: payrollProfileError } = await supabase
      .from("instructor_payroll_profiles")
      .select("worker_classification, payroll_active")
      .eq("studio_id", studioId)
      .eq("instructor_id", instructorId)
      .maybeSingle();

    if (
      payrollProfileError ||
      !payrollProfile ||
      payrollProfile.payroll_active !== true
    ) {
      redirectWithStatus("payroll_profile_inactive");
    }

    const workerClassification = String(
      payrollProfile.worker_classification ?? "not_set",
    );

    if (workerClassification === "not_set") {
      redirectWithStatus("worker_classification_required");
    }

    const accountingCategory =
      workerClassification === "employee"
        ? "employee_wage_expense"
        : workerClassification === "owner"
          ? "instructor_pay_expense"
          : "contract_labor_expense";
    const taxableCompensation =
      adjustmentType === "reimbursement" ||
      adjustmentType === "deduction"
        ? 0
        : Math.max(amount, 0);
    const reimbursementAmount =
      adjustmentType === "reimbursement" ? Math.max(amount, 0) : 0;
    const deductionAmount =
      adjustmentType === "deduction" ? Math.abs(amount) : 0;

    const { error } = await supabase.from("instructor_earnings").insert({
      studio_id: studioId,
      instructor_id: instructorId,
      earning_date: earningDate,
      source_type: "manual_adjustment",
      appointment_type: null,
      gross_revenue_basis: 0,
      pay_mode: "manual_adjustment",
      pay_rate_amount: amount,
      pay_percentage: 0,
      attendance_count: 0,
      earning_amount: amount,
      status: "pending",
      adjustment_type: adjustmentType,
      worker_classification_snapshot: workerClassification,
      accounting_category_snapshot: accountingCategory,
      taxable_compensation_amount: taxableCompensation,
      reimbursement_amount: reimbursementAmount,
      deduction_amount: deductionAmount,
      notes: `${adjustmentType.charAt(0).toUpperCase() + adjustmentType.slice(1)}: ${notes}`,
      created_by: user.id,
      updated_at: new Date().toISOString(),
    });

    if (error) redirectWithStatus("adjustment_failed");

    revalidatePath("/app/instructor-pay");
    revalidatePath("/app/reports");
    redirectWithStatus("adjustment_created");
  } catch (error) {
    if (isRedirectError(error)) throw error;
    redirectWithStatus("adjustment_failed");
  }
}

export async function overrideInstructorEarningAction(formData: FormData) {
  try {
    const { supabase, studioId, user } = await requirePayrollPrepareAccess();
    const earningId = getString(formData, "earningId");
    const overrideAmount = getNumber(formData, "overrideAmount");
    const overrideReason = getString(formData, "overrideReason");

    if (!earningId) redirectWithStatus("missing_earning");
    if (!overrideReason) redirectWithStatus("override_reason_required");
    if (!Number.isFinite(overrideAmount)) redirectWithStatus("invalid_override_amount");

    const { data: existing, error: existingError } = await supabase
      .from("instructor_earnings")
      .select("id, status")
      .eq("id", earningId)
      .eq("studio_id", studioId)
      .maybeSingle();

    if (existingError || !existing) redirectWithStatus("override_failed");

    const currentStatus = String(existing.status ?? "pending");
    if (["paid", "void"].includes(currentStatus)) redirectWithStatus("earning_locked");

    const { error } = await supabase
      .from("instructor_earnings")
      .update({
        earning_amount: overrideAmount,
        taxable_compensation_amount: Math.max(overrideAmount, 0),
        reimbursement_amount: 0,
        deduction_amount: overrideAmount < 0 ? Math.abs(overrideAmount) : 0,
        pay_mode: "manual_override",
        pay_rate_amount: overrideAmount,
        pay_percentage: 0,
        adjustment_type: "override",
        override_reason: overrideReason,
        notes: `Manual override: ${overrideReason}`,
        updated_at: new Date().toISOString(),
        approved_by: currentStatus === "approved" ? user.id : null,
      })
      .eq("id", earningId)
      .eq("studio_id", studioId);

    if (error) redirectWithStatus("override_failed");

    revalidatePath("/app/instructor-pay");
    revalidatePath("/app/reports");
    redirectWithStatus("override_saved");
  } catch (error) {
    if (isRedirectError(error)) throw error;
    redirectWithStatus("override_failed");
  }
}


export async function createPayrollPayPeriodAction(formData: FormData) {
  try {
    const { supabase, studioId } = await requirePayrollPrepareAccess();
    const periodStart = getOptionalDate(formData, "periodStart");
    const periodEnd = getOptionalDate(formData, "periodEnd");
    const payDate = getOptionalDate(formData, "payDate");

    if (!periodStart || !periodEnd) redirectWithStatus("pay_period_dates_required");
    if (periodEnd < periodStart) redirectWithStatus("pay_period_invalid_dates");

    const { error } = await supabase.rpc("create_payroll_pay_period", {
      p_studio_id: studioId,
      p_period_start: periodStart,
      p_period_end: periodEnd,
      p_pay_date: payDate,
    });

    if (error) {
      logPayrollOperationError("create_period", error);
      redirectWithStatus(payrollErrorStatus("create_period", error));
    }

    revalidatePath("/app/instructor-pay");
    redirectWithStatus("pay_period_created");
  } catch (error) {
    if (isRedirectError(error)) throw error;
    logPayrollOperationError("create_period", error);
    redirectWithStatus(payrollErrorStatus("create_period", error));
  }
}

export async function assignEarningsToPayPeriodAction(formData: FormData) {
  try {
    const { supabase, studioId } = await requirePayrollPrepareAccess();
    const payPeriodId = getString(formData, "payPeriodId");
    if (!payPeriodId) redirectWithStatus("missing_pay_period");

    const { data, error } = await supabase.rpc("assign_earnings_to_pay_period", {
      p_studio_id: studioId,
      p_pay_period_id: payPeriodId,
    });

    if (error) {
      logPayrollOperationError("assign_period", error);
      redirectWithStatus(payrollErrorStatus("assign_period", error));
    }

    revalidatePath("/app/instructor-pay");
    revalidatePath(`/app/instructor-pay/periods/${payPeriodId}`);
    redirect(
      `/app/instructor-pay?status=earnings_assigned&assigned=${Number(data ?? 0)}`,
    );
  } catch (error) {
    if (isRedirectError(error)) throw error;
    logPayrollOperationError("assign_period", error);
    redirectWithStatus(payrollErrorStatus("assign_period", error));
  }
}

export async function createPayrollBatchAction(formData: FormData) {
  try {
    const { supabase, studioId } = await requirePayrollPrepareAccess();
    const payPeriodId = getString(formData, "payPeriodId");
    const provider = getString(formData, "provider") || "manual";
    if (!payPeriodId) redirectWithStatus("missing_pay_period");

    const { error } = await supabase.rpc("create_payroll_batch_from_period", {
      p_studio_id: studioId,
      p_pay_period_id: payPeriodId,
      p_provider: provider,
    });

    if (error) {
      logPayrollOperationError("create_batch", error);
      redirectWithStatus(payrollErrorStatus("create_batch", error));
    }

    revalidatePath("/app/instructor-pay");
    revalidatePath(`/app/instructor-pay/periods/${payPeriodId}`);
    redirectWithStatus("payroll_batch_created");
  } catch (error) {
    if (isRedirectError(error)) throw error;
    logPayrollOperationError("create_batch", error);
    redirectWithStatus(payrollErrorStatus("create_batch", error));
  }
}

export async function approvePayrollBatchAction(formData: FormData) {
  try {
    const { supabase, studioId } = await requirePayrollPrepareAccess();
    const payrollBatchId = getString(formData, "payrollBatchId");
    if (!payrollBatchId) redirectWithStatus("missing_payroll_batch");

    const { error } = await supabase.rpc("approve_payroll_batch", {
      p_studio_id: studioId,
      p_batch_id: payrollBatchId,
    });

    if (error) {
      logPayrollOperationError("approve_batch", error);
      redirectWithStatus(payrollErrorStatus("approve_batch", error));
    }

    revalidatePath("/app/instructor-pay");
    redirectWithStatus("payroll_batch_approved");
  } catch (error) {
    if (isRedirectError(error)) throw error;
    logPayrollOperationError("approve_batch", error);
    redirectWithStatus(payrollErrorStatus("approve_batch", error));
  }
}

export async function markPayrollBatchPaidAction(formData: FormData) {
  try {
    const { supabase, studioId } = await requirePayrollDisbursementAccess();
    const payrollBatchId = getString(formData, "payrollBatchId");
    const paymentMethod =
      getString(formData, "paymentMethod") || "external_payroll";
    const providerBatchReference =
      getString(formData, "providerBatchReference") || null;
    if (!payrollBatchId) redirectWithStatus("missing_payroll_batch");

    const { error } = await supabase.rpc("mark_payroll_batch_paid", {
      p_studio_id: studioId,
      p_batch_id: payrollBatchId,
      p_payment_method: paymentMethod,
      p_provider_batch_reference: providerBatchReference,
    });

    if (error) {
      logPayrollOperationError("pay_batch", error);
      redirectWithStatus(payrollErrorStatus("pay_batch", error));
    }

    revalidatePath("/app/instructor-pay");
    revalidatePath("/app/reports");
    redirectWithStatus("payroll_batch_paid");
  } catch (error) {
    if (isRedirectError(error)) throw error;
    logPayrollOperationError("pay_batch", error);
    redirectWithStatus(payrollErrorStatus("pay_batch", error));
  }
}
