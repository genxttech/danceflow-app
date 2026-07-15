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

export async function createAccountantDeliveryAction(formData: FormData) {
  const { supabase, studioId } = await requireSettingsManageAccess();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const range = getString(formData, "reportRange") || "month";
  if (!["month", "quarter", "year"].includes(range)) {
    redirect("/app/settings/accountant?delivery_error=invalid_range");
  }

  const { data: profile, error: profileError } = await supabase
    .from("studio_accountant_profiles")
    .select("id,accountant_name,email,active,authorized_to_receive_exports,preferred_export_types")
    .eq("studio_id", studioId)
    .maybeSingle();

  if (profileError || !profile || !profile.active || !profile.authorized_to_receive_exports) {
    redirect("/app/settings/accountant?delivery_error=not_authorized");
  }

  const requested = formData.getAll("deliveryReportTypes").filter((v): v is string => typeof v === "string");
  const supported = ["profit_loss","accounting_ledger","payments_refunds","expenses","event_profitability"];
  const reports = requested.filter((v) => supported.includes(v) && (profile.preferred_export_types ?? []).includes(v));
  if (!reports.length) redirect("/app/settings/accountant?delivery_error=no_reports");

  const { createAccountantDeliveryToken } = await import("@/lib/accountant-deliveries/tokens");
  const { queueOutboundDelivery } = await import("@/lib/notifications/outbound");
  const { token, tokenHash } = createAccountantDeliveryToken();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data: delivery, error } = await supabase.from("studio_accountant_deliveries").insert({
    studio_id: studioId,
    accountant_profile_id: profile.id,
    recipient_email: profile.email,
    report_types: reports,
    report_range: range,
    token_hash: tokenHash,
    expires_at: expiresAt,
    created_by: user.id,
  }).select("id").single();
  if (error || !delivery) {
    console.error("Failed to create accountant delivery", { studioId, error });
    redirect("/app/settings/accountant?delivery_error=create_failed");
  }

  const siteUrl = (process.env.NEXT_PUBLIC_SITE_URL || "https://idanceflow.com").replace(/\/$/, "");
  const link = `${siteUrl}/accountant-delivery/${token}`;
  const queued = await queueOutboundDelivery({
    studioId,
    channel: "email",
    templateKey: "accountant_secure_delivery",
    recipientEmail: profile.email,
    subject: "Secure DanceFlow accounting reports",
    bodyText: `Hi ${profile.accountant_name},\n\nA secure accounting report package is ready for you. The link expires in 7 days.\n\n${link}\n\nFor security, do not forward this link.`,
    bodyHtml: `<div style="font-family:Arial,sans-serif;line-height:1.6;color:#0f172a"><h2>Secure DanceFlow accounting reports</h2><p>Hi ${profile.accountant_name},</p><p>A secure accounting report package is ready for you. The link expires in 7 days.</p><p><a href="${link}" style="display:inline-block;background:#4c1d95;color:#fff;padding:12px 18px;border-radius:10px;text-decoration:none;font-weight:700">Open secure report package</a></p><p>For security, do not forward this link.</p></div>`,
    relatedTable: "studio_accountant_deliveries",
    relatedId: delivery.id,
    dedupeKey: `accountant_delivery:${delivery.id}`,
  });

  if (!queued.queued) {
    await supabase.from("studio_accountant_deliveries").update({ status:"failed", last_error: queued.reason }).eq("id", delivery.id).eq("studio_id", studioId);
    redirect("/app/settings/accountant?delivery_error=queue_failed");
  }

  revalidatePath("/app/settings/accountant");
  redirect("/app/settings/accountant?delivery_success=queued");
}

export async function cancelAccountantDeliveryAction(formData: FormData) {
  const { supabase, studioId } = await requireSettingsManageAccess();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const id = getString(formData, "deliveryId");
  await supabase.from("studio_accountant_deliveries").update({ status:"cancelled", cancelled_at:new Date().toISOString(), cancelled_by:user.id }).eq("id",id).eq("studio_id",studioId).in("status",["queued","sent"]);
  revalidatePath("/app/settings/accountant");
  redirect("/app/settings/accountant?delivery_success=cancelled");
}
