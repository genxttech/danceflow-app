"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { isRedirectError } from "next/dist/client/components/redirect-error";
import { requireInstructorManageAccess } from "@/lib/auth/serverRoleGuard";
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

export async function saveInstructorCompensationRuleAction(formData: FormData) {
  try {
    const { supabase, studioId, user } = await requireInstructorManageAccess();
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
    const { supabase, studioId, user } = await requireInstructorManageAccess();
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
    const { supabase, studioId, user } = await requireInstructorManageAccess();
    const earningId = getString(formData, "earningId");
    const nextStatus = getString(formData, "nextStatus");
    const paymentMethod = getString(formData, "paymentMethod");

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
