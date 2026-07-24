import type { SupabaseClient } from "@supabase/supabase-js";
import { queueOutboundDelivery } from "@/lib/notifications/outbound";
import { renderStudioBrandedEmail } from "@/lib/notifications/email-branding";
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

async function getStudioBranding(
  supabase: SupabaseClient,
  studioId: string,
) {
  const { data, error } = await supabase
    .from("studios")
    .select("name, public_name, public_logo_url")
    .eq("id", studioId)
    .maybeSingle<{
      name: string | null;
      public_name: string | null;
      public_logo_url: string | null;
    }>();

  if (error) {
    throw new Error(`Studio email branding could not be loaded: ${error.message}`);
  }

  return {
    name: data?.public_name?.trim() || data?.name?.trim() || "Your dance studio",
    logoUrl: data?.public_logo_url ?? null,
  };
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
  const studioBrand = await getStudioBranding(params.supabase, params.studioId);
  const bodyText = [
    `Hi ${params.profile.accountant_name},`,
    "",
    `${studioBrand.name} has prepared a secure accounting report package for you.`,
    "The link expires in 7 days.",
    "",
    link,
    "",
    "For security, do not forward this link.",
    "",
    "Thanks,",
    studioBrand.name,
  ].join("\n");

  const bodyHtml = renderStudioBrandedEmail(
    {
      name: studioBrand.name,
      logoUrl: studioBrand.logoUrl,
    },
    {
      previewText: `Secure accounting reports from ${studioBrand.name}`,
      eyebrow: "Accountant Delivery",
      heading: "Your secure report package is ready",
      greeting: `Hi ${params.profile.accountant_name},`,
      intro: `${studioBrand.name} has prepared a secure accounting report package for you.`,
      bodyText,
      actionLabel: "Open secure report package",
      actionUrl: link,
      footerText: `Sent by ${studioBrand.name} through DanceFlow. This secure link expires in 7 days.`,
    },
  );

  const queued = await queueOutboundDelivery({
    studioId: params.studioId,
    channel: "email",
    templateKey: "accountant_secure_delivery",
    recipientEmail: params.profile.email,
    subject: `Secure accounting reports from ${studioBrand.name}`,
    bodyText,
    bodyHtml,
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
