"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireSettingsManageAccess } from "@/lib/auth/serverRoleGuard";
import {
  createAndQueueAccountantDelivery,
  getNextScheduleRun,
  type AccountantDeliveryRange,
} from "@/lib/accountant-deliveries/deliveries";

type ActionState = { error: string };

const allowedCadences = ["manual", "monthly", "quarterly", "annually"] as const;
type AccountantCadence = (typeof allowedCadences)[number];
type RecurringCadence = Exclude<AccountantCadence, "manual">;

function isAccountantCadence(value: string): value is AccountantCadence {
  return (allowedCadences as readonly string[]).includes(value);
}

function isRecurringCadence(value: string): value is RecurringCadence {
  return value === "monthly" || value === "quarterly" || value === "annually";
}

const allowedExports = [
  "profit_loss", "accounting_ledger", "payments_refunds", "expenses",
  "event_profitability", "payroll_packet", "instructor_compensation",
  "wave_reconciliation", "tax_season_package",
] as const;
const supportedDeliveryReports = ["profit_loss", "accounting_ledger", "payments_refunds", "expenses", "event_profitability"];

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

export async function saveAccountantProfileAction(
  _previousState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const { supabase, studioId } = await requireSettingsManageAccess();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { error: "Your session has expired. Please sign in again." };

    const accountantName = getString(formData, "accountantName");
    const firmName = getString(formData, "firmName");
    const email = getString(formData, "email").toLowerCase();
    const phone = getString(formData, "phone");
    const rawCadence = getString(formData, "preferredCadence") || "manual";
    if (!isAccountantCadence(rawCadence)) {
      return { error: "Preferred export cadence is invalid." };
    }
    const cadence: AccountantCadence = rawCadence;
    const notes = getString(formData, "internalNotes");
    const active = formData.get("active") === "on";
    const authorized = formData.get("authorizedToReceiveExports") === "on";
    const approveRecurringDelivery = formData.get("approveRecurringDelivery") === "on";
    const exportTypes = formData.getAll("preferredExportTypes")
      .filter((value): value is string => typeof value === "string")
      .filter((value) => (allowedExports as readonly string[]).includes(value));

    if (!accountantName) return { error: "Accountant name is required." };
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: "Enter a valid accountant email address." };
    const { data: existing } = await supabase
      .from("studio_accountant_profiles")
      .select("authorized_to_receive_exports,authorization_granted_at,authorization_granted_by")
      .eq("studio_id", studioId)
      .maybeSingle();
    const now = new Date().toISOString();
    const keepAuthorization = authorized && existing?.authorized_to_receive_exports;
    const payload = {
      studio_id: studioId,
      accountant_name: accountantName,
      firm_name: firmName || null,
      email,
      phone: phone || null,
      preferred_cadence: cadence,
      preferred_export_types: exportTypes,
      internal_notes: notes || null,
      active,
      authorized_to_receive_exports: authorized,
      authorization_granted_at: authorized ? (keepAuthorization ? existing.authorization_granted_at : now) : null,
      authorization_granted_by: authorized ? (keepAuthorization ? existing.authorization_granted_by : user.id) : null,
      updated_at: now,
      updated_by: user.id,
    };

    const { data: savedProfile, error } = await supabase
      .from("studio_accountant_profiles")
      .upsert(payload, { onConflict: "studio_id" })
      .select("id")
      .single();
    if (error || !savedProfile) {
      console.error("Failed to save accountant profile", { studioId, error });
      return { error: "Accountant details could not be saved. Please try again." };
    }

    const deliveryReports = exportTypes.filter((value) => supportedDeliveryReports.includes(value));

    if (!isRecurringCadence(cadence)) {
      const { error: schedulePauseError } = await supabase
        .from("studio_accountant_delivery_schedules")
        .update({ enabled: false, updated_at: now, updated_by: user.id })
        .eq("studio_id", studioId);
      if (schedulePauseError) {
        console.error("Failed to pause accountant schedule", { studioId, error: schedulePauseError });
        return { error: "The accountant was saved, but the delivery schedule could not be updated." };
      }
    } else if (approveRecurringDelivery && active && authorized && deliveryReports.length > 0) {
      const reportRange = cadence === "monthly" ? "month" : cadence === "quarterly" ? "quarter" : "year";
      const { error: scheduleError } = await supabase
        .from("studio_accountant_delivery_schedules")
        .upsert({
          studio_id: studioId,
          accountant_profile_id: savedProfile.id,
          cadence,
          report_types: deliveryReports,
          report_range: reportRange,
          enabled: true,
          first_send_approved: true,
          first_send_approved_at: now,
          first_send_approved_by: user.id,
          next_run_at: getNextScheduleRun(cadence, new Date(now)).toISOString(),
          last_error: null,
          updated_at: now,
          updated_by: user.id,
        }, { onConflict: "studio_id" });
      if (scheduleError) {
        console.error("Failed to save accountant schedule", { studioId, error: scheduleError });
        return { error: "The accountant was saved, but recurring delivery could not be activated." };
      }
    } else {
      const { error: scheduleDisableError } = await supabase
        .from("studio_accountant_delivery_schedules")
        .update({ enabled: false, cadence, report_types: deliveryReports, updated_at: now, updated_by: user.id })
        .eq("studio_id", studioId);
      if (scheduleDisableError) {
        console.error("Failed to update accountant schedule", { studioId, error: scheduleDisableError });
        return { error: "The accountant was saved, but recurring delivery could not be updated." };
      }
    }
  } catch (error) {
    console.error("Unexpected accountant profile save failure", error);
    return { error: "Accountant details could not be saved. Please try again." };
  }

  revalidatePath("/app/settings/accountant");
  redirect("/app/settings/accountant?success=saved");
}

export async function createAccountantDeliveryAction(formData: FormData) {
  const { supabase, studioId } = await requireSettingsManageAccess();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const range = (getString(formData, "reportRange") || "month") as AccountantDeliveryRange;
  if (!["month", "quarter", "year"].includes(range)) redirect("/app/settings/accountant?delivery_error=invalid_range");

  const { data: profile } = await supabase.from("studio_accountant_profiles")
    .select("id,accountant_name,email,active,authorized_to_receive_exports,preferred_export_types")
    .eq("studio_id", studioId).maybeSingle();
  if (!profile) redirect("/app/settings/accountant?delivery_error=not_authorized");

  const requested = formData.getAll("deliveryReportTypes").filter((value): value is string => typeof value === "string");
  try {
    await createAndQueueAccountantDelivery({ supabase, studioId, profile, reportTypes: requested, reportRange: range, createdBy: user.id });
  } catch (error) {
    console.error("Failed to create accountant delivery", { studioId, error });
    redirect("/app/settings/accountant?delivery_error=create_failed");
  }
  revalidatePath("/app/settings/accountant");
  redirect("/app/settings/accountant?delivery_success=queued");
}

export async function saveAccountantScheduleAction(formData: FormData) {
  const { supabase, studioId } = await requireSettingsManageAccess();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const { data: profile } = await supabase.from("studio_accountant_profiles")
    .select("id,preferred_cadence,preferred_export_types,active,authorized_to_receive_exports")
    .eq("studio_id", studioId).maybeSingle();
  if (!profile || !profile.active || !profile.authorized_to_receive_exports) redirect("/app/settings/accountant?schedule_error=not_authorized");
  if (!isRecurringCadence(profile.preferred_cadence)) {
    redirect("/app/settings/accountant?schedule_error=manual_cadence");
  }
  const recurringCadence = profile.preferred_cadence;

  const reportTypes = formData.getAll("scheduleReportTypes")
    .filter((value): value is string => typeof value === "string")
    .filter((value) => supportedDeliveryReports.includes(value) && (profile.preferred_export_types ?? []).includes(value));
  if (!reportTypes.length) redirect("/app/settings/accountant?schedule_error=no_reports");
  const range = recurringCadence === "monthly" ? "month" : recurringCadence === "quarterly" ? "quarter" : "year";
  const now = new Date();
  const { error } = await supabase.from("studio_accountant_delivery_schedules").upsert({
    studio_id: studioId,
    accountant_profile_id: profile.id,
    cadence: recurringCadence,
    report_types: reportTypes,
    report_range: range,
    enabled: true,
    first_send_approved: true,
    first_send_approved_at: now.toISOString(),
    first_send_approved_by: user.id,
    next_run_at: getNextScheduleRun(recurringCadence, now).toISOString(),
    last_error: null,
    updated_at: now.toISOString(),
    updated_by: user.id,
  }, { onConflict: "studio_id" });
  if (error) {
    console.error("Failed to save accountant schedule", { studioId, error });
    redirect("/app/settings/accountant?schedule_error=save_failed");
  }
  revalidatePath("/app/settings/accountant");
  redirect("/app/settings/accountant?schedule_success=approved");
}

export async function pauseAccountantScheduleAction() {
  const { supabase, studioId } = await requireSettingsManageAccess();
  await supabase.from("studio_accountant_delivery_schedules").update({ enabled: false, updated_at: new Date().toISOString() }).eq("studio_id", studioId);
  revalidatePath("/app/settings/accountant");
  redirect("/app/settings/accountant?schedule_success=paused");
}

export async function resumeAccountantScheduleAction() {
  const { supabase, studioId } = await requireSettingsManageAccess();
  const { data: schedule } = await supabase.from("studio_accountant_delivery_schedules").select("cadence,first_send_approved").eq("studio_id", studioId).maybeSingle();
  if (!schedule?.first_send_approved) {
    redirect("/app/settings/accountant?schedule_error=approval_required");
  }
  if (!isRecurringCadence(schedule.cadence)) {
    redirect("/app/settings/accountant?schedule_error=manual_cadence");
  }
  await supabase
    .from("studio_accountant_delivery_schedules")
    .update({
      enabled: true,
      next_run_at: getNextScheduleRun(schedule.cadence).toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("studio_id", studioId);
  revalidatePath("/app/settings/accountant");
  redirect("/app/settings/accountant?schedule_success=resumed");
}

export async function cancelAccountantDeliveryAction(formData: FormData) {
  const { supabase, studioId } = await requireSettingsManageAccess();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const id = getString(formData, "deliveryId");
  await supabase.from("studio_accountant_deliveries").update({ status: "cancelled", cancelled_at: new Date().toISOString(), cancelled_by: user.id }).eq("id", id).eq("studio_id", studioId).in("status", ["queued", "sent"]);
  revalidatePath("/app/settings/accountant");
  redirect("/app/settings/accountant?delivery_success=cancelled");
}
