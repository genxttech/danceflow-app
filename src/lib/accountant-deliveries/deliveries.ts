import type { SupabaseClient } from "@supabase/supabase-js";
import { queueOutboundDelivery } from "@/lib/notifications/outbound";
import { createAccountantDeliveryToken } from "./tokens";
import { isSupportedAccountantReport } from "./reports";

export const SUPPORTED_ACCOUNTANT_REPORTS = [
  "profit_loss",
  "accounting_ledger",
  "payments_refunds",
  "expenses",
  "event_profitability",
] as const;

export type AccountantDeliveryRange = "month" | "quarter" | "year";

export function getAccountantPeriodKey(range: AccountantDeliveryRange, now = new Date()) {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;
  if (range === "year") return `${year}`;
  if (range === "quarter") return `${year}-Q${Math.floor((month - 1) / 3) + 1}`;
  return `${year}-${String(month).padStart(2, "0")}`;
}

export function getNextScheduleRun(cadence: "monthly" | "quarterly" | "annually", from = new Date()) {
  const year = from.getUTCFullYear();
  const month = from.getUTCMonth();
  if (cadence === "monthly") return new Date(Date.UTC(year, month + 1, 1, 13, 0, 0));
  if (cadence === "quarterly") {
    const nextQuarterMonth = Math.floor(month / 3) * 3 + 3;
    return new Date(Date.UTC(year, nextQuarterMonth, 1, 13, 0, 0));
  }
  return new Date(Date.UTC(year + 1, 0, 1, 13, 0, 0));
}

function escapeHtml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

export async function createAndQueueAccountantDelivery(params: {
  supabase: SupabaseClient;
  studioId: string;
  profile: {
    id: string;
    accountant_name: string;
    email: string;
    active: boolean;
    authorized_to_receive_exports: boolean;
    preferred_export_types: string[] | null;
  };
  reportTypes: string[];
  reportRange: AccountantDeliveryRange;
  createdBy?: string | null;
  scheduleId?: string | null;
  periodKey?: string | null;
}) {
  const reports = params.reportTypes.filter(
    (value) => isSupportedAccountantReport(value) && (params.profile.preferred_export_types ?? []).includes(value),
  );
  if (!params.profile.active || !params.profile.authorized_to_receive_exports) {
    throw new Error("Accountant export authorization is not active.");
  }
  if (!reports.length) throw new Error("No supported accountant reports were selected.");

  const { token, tokenHash } = createAccountantDeliveryToken();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data: delivery, error } = await params.supabase
    .from("studio_accountant_deliveries")
    .insert({
      studio_id: params.studioId,
      accountant_profile_id: params.profile.id,
      recipient_email: params.profile.email,
      report_types: reports,
      report_range: params.reportRange,
      token_hash: tokenHash,
      expires_at: expiresAt,
      created_by: params.createdBy ?? null,
      schedule_id: params.scheduleId ?? null,
      period_key: params.periodKey ?? null,
      next_attempt_at: new Date().toISOString(),
    })
    .select("id")
    .single<{ id: string }>();

  if (error || !delivery) throw new Error(error?.message || "Accountant delivery could not be created.");

  const siteUrl = (process.env.NEXT_PUBLIC_SITE_URL || "https://idanceflow.com").replace(/\/$/, "");
  const link = `${siteUrl}/accountant-delivery/${token}`;
  const safeName = escapeHtml(params.profile.accountant_name);
  const queued = await queueOutboundDelivery({
    studioId: params.studioId,
    channel: "email",
    templateKey: "accountant_secure_delivery",
    recipientEmail: params.profile.email,
    subject: "Secure DanceFlow accounting reports",
    bodyText: `Hi ${params.profile.accountant_name},\n\nA secure accounting report package is ready for you. The link expires in 7 days.\n\n${link}\n\nFor security, do not forward this link.`,
    bodyHtml: `<div style="font-family:Arial,sans-serif;line-height:1.6;color:#0f172a"><h2>Secure DanceFlow accounting reports</h2><p>Hi ${safeName},</p><p>A secure accounting report package is ready for you. The link expires in 7 days.</p><p><a href="${link}" style="display:inline-block;background:#4c1d95;color:#fff;padding:12px 18px;border-radius:10px;text-decoration:none;font-weight:700">Open secure report package</a></p><p>For security, do not forward this link.</p></div>`,
    relatedTable: "studio_accountant_deliveries",
    relatedId: delivery.id,
    dedupeKey: `accountant_delivery:${delivery.id}`,
  });

  if (!queued.queued) {
    await params.supabase
      .from("studio_accountant_deliveries")
      .update({ status: "failed", last_error: queued.reason, attempt_count: 1 })
      .eq("id", delivery.id);
    throw new Error(`Accountant delivery queue failed: ${queued.reason}`);
  }

  return delivery.id;
}
