"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { isRedirectError } from "next/dist/client/components/redirect-error";
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
