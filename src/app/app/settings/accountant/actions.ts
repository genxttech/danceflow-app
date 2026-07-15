"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireSettingsManageAccess } from "@/lib/auth/serverRoleGuard";

type ActionState = { error: string };

const allowedCadences = ["manual", "monthly", "quarterly", "annually"] as const;
const allowedExports = [
  "profit_loss",
  "accounting_ledger",
  "payments_refunds",
  "expenses",
  "event_profitability",
  "payroll_packet",
  "instructor_compensation",
  "wave_reconciliation",
  "tax_season_package",
] as const;

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
    const cadence = getString(formData, "preferredCadence") || "manual";
    const notes = getString(formData, "internalNotes");
    const active = formData.get("active") === "on";
    const authorized = formData.get("authorizedToReceiveExports") === "on";
    const exportTypes = formData
      .getAll("preferredExportTypes")
      .filter((value): value is string => typeof value === "string")
      .filter((value) => (allowedExports as readonly string[]).includes(value));

    if (!accountantName) return { error: "Accountant name is required." };
    if (!email) return { error: "Accountant email is required." };
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return { error: "Enter a valid accountant email address." };
    }
    if (!(allowedCadences as readonly string[]).includes(cadence)) {
      return { error: "Preferred export cadence is invalid." };
    }

    const now = new Date().toISOString();
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
      authorization_granted_at: authorized ? now : null,
      authorization_granted_by: authorized ? user.id : null,
      updated_at: now,
      updated_by: user.id,
    };

    const { error } = await supabase
      .from("studio_accountant_profiles")
      .upsert(payload, { onConflict: "studio_id" });

    if (error) {
      console.error("Failed to save accountant profile", { studioId, error });
      return { error: "Accountant details could not be saved. Please try again." };
    }
  } catch (error) {
    console.error("Unexpected accountant profile save failure", error);
    return { error: "Accountant details could not be saved. Please try again." };
  }

  revalidatePath("/app/settings");
  revalidatePath("/app/settings/accountant");
  redirect("/app/settings/accountant?success=saved");
}
