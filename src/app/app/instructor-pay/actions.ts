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
